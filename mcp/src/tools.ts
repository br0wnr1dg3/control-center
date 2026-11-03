import { McpServer } from "@modelcontextprotocol/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

const kind = z.enum(["human", "agent", "either"]);
const status = z.enum(["new", "ready", "in_progress", "needs_you", "done", "cancelled"]);
const author = z.enum(["me", "claude", "agent"]);
const priority = z
  .number()
  .int()
  .min(0)
  .max(4)
  .describe("0 none, 1 urgent, 2 high, 3 medium, 4 low");
const link = z.object({ title: z.string(), url: z.string() });
const repo = z.object({
  name: z.string(),
  url: z.string().optional().describe("e.g. https://github.com/org/repo"),
  path: z.string().optional().describe("Local checkout, e.g. ~/Developer/projects/repo"),
});
const teamRef = z.string().describe("Team key or name, e.g. 'personal' or 'flixr'");
const views = ["today", "upcoming", "new", "agent_ready", "needs_you", "human", "open", "done_recent"] as const;

const OPEN = "(done,cancelled)";
const LIST_FIELDS =
  "id,title,kind,status,priority,team:teams(key,name),project,labels,scheduled_on,due,today,parent_id,question,updated_at,waiting_on,external_ref,requested_by";

// Accept 12, "12" or "CC-12".
const taskId = z.preprocess(
  (v) => (typeof v === "string" ? Number(v.replace(/^cc-/i, "")) : v),
  z.number().int().positive(),
);

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

// Board lives in one timezone; keep "today" consistent across Slack, web and the runner.
function todayISO(timeZone: string) {
  return new Date().toLocaleDateString("en-CA", { timeZone });
}

const withKey = <T extends { id: number }>(t: T) => ({ key: `CC-${t.id}`, ...t });

const linkedTasks = (rows: unknown[] | null) =>
  ((rows ?? []) as unknown as { task: { id: number; title: string; kind: string; status: string } }[]).map((r) => withKey(r.task));

const blockedBy = z.array(taskId).optional();

// Make a task's blockers exactly this list. New ones go in before old ones come out: removing first could
// leave a ready task briefly with nothing open, long enough for the runner to start it. Returns an error
// message, if any. The triggers own what this does to the task's status.
async function setBlockers(db: SupabaseClient, id: number, blockers: number[]): Promise<string | null> {
  const wanted = [...new Set(blockers)];
  if (wanted.includes(id)) return `CC-${id} can't be blocked by itself.`;
  if (wanted.length) {
    const { error } = await db
      .from("task_dependencies")
      .upsert(wanted.map((blocked_by_id) => ({ task_id: id, blocked_by_id })), { ignoreDuplicates: true });
    if (error) return error.code === "23503" ? `One of ${wanted.map((b) => `CC-${b}`).join(", ")} doesn't exist.` : error.message;
  }
  let removal = db.from("task_dependencies").delete().eq("task_id", id);
  if (wanted.length) removal = removal.not("blocked_by_id", "in", `(${wanted.join(",")})`);
  const { error } = await removal;
  return error?.message ?? null;
}

// Team by key or (case-insensitive) name.
async function resolveTeam(db: SupabaseClient, ref: string): Promise<number> {
  const { data } = await db.from("teams").select("id,key,name");
  const needle = ref.trim().toLowerCase();
  const team = (data ?? []).find((t) => t.key === needle || t.name.toLowerCase() === needle);
  if (!team) {
    const known = (data ?? []).map((t) => t.key).join(", ");
    throw new Error(`Unknown team "${ref}". Known teams: ${known || "none"}. Create one with save_team.`);
  }
  return team.id;
}

async function logEvent(db: SupabaseClient, taskId: number, kind: string, body: string, actor: string) {
  await db.from("task_events").insert({ task_id: taskId, kind, body, actor });
}

// Sent to every client at connect time. Claude in Slack or on the web knows nothing else about the
// board, so this is the house style for tickets.
const instructions = (o: string) => `Control Center is ${o}'s task board for everything outside engineering (Linear covers engineering).

Referring to things
- Tasks are CC-<id> (CC-12 is id 12); tools accept 12, "12" or "CC-12". Write "CC-12" in text and it becomes a link in the app.
- Teams are companies plus Personal. Each project belongs to one team and tasks inherit it. Call list_teams before using a team or project you haven't seen this conversation; reuse existing names exactly, and only invent a new project when nothing fits (then pass team).
- For code or app work (changing, deploying or administering one of the team's apps), set repo: call get_team and pick from local_repos by name, alias or description. Leave it empty if unsure; the runner matches or the agent asks.
- Before adding, check for duplicates with list_tasks(query=...). Update or comment on an existing task instead of adding a near-copy.

Writing a task
- Title: a short imperative with the outcome, e.g. "Draft LinkedIn post on menopause study", not "LinkedIn".
- Description (Markdown): what and why in 1-2 lines, then the context someone starting cold needs (links, file paths, names), then a "Done when" checklist (- [ ] ...). For agent tasks also list constraints and where outputs go. Keep team-wide rules in the team briefing (save_team context), not in every task.
- kind: 'agent' only if Claude can finish it alone with a computer; posting publicly, sending messages as ${o}, calls, payments, logins and errands are 'human'. Mixed work = an agent task whose agent hands the human step back with add_human_task, or separate sub-tasks.
- Split work longer than a session into sub-tasks (parent_id) under one parent that holds the shared brief.
- For stages that must run in order, pass blocked_by. It delays a task, it doesn't approve it: a ready task waits until its blockers finish, then an agent task starts by itself, while a new task still needs ${o}'s go-ahead. If a blocker is cancelled the task moves to needs_you for ${o} to decide.
- Dates: scheduled_on = the day to do it (puts it on the calendar; agent tasks wait for it). due = a real deadline only. Use YYYY-MM-DD in ${o}'s timezone. today=true pins to today's list.
- Status: new by default. Set ready=true only when ${o} says to go ahead: ready agent tasks are executed by the runner without further review.
- Priority only when stated or obvious (1 urgent ... 4 low). Labels are lowercase tags for cross-cutting themes (linkedin, research), not a substitute for project.
- Always pass source: 'cli', 'slack', 'web:<account>' or 'app'.

Comments and answers
- Relaying ${o}'s own words: author='me' (a running agent receives them). Your own notes: author='claude'. Runner sessions: author='agent'.
- Answer a waiting question with answer_task, which hands the task back to its agent.
- To hand any task to an agent (e.g. "get the agent to merge CC-46"), add_comment with author='me' and a body starting "@agent " followed by ${o}'s instruction; it becomes a ready agent task and the runner starts it.

After creating or changing tasks, reply with each task's CC key and title.`;

export function buildServer(env: Env) {
  // Whose board this is, as the instructions name them (OWNER_NAME secret; neutral when unset).
  const o = (env as Env & { OWNER_NAME?: string }).OWNER_NAME || "the owner";
  const timeZone = env.TIMEZONE;
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const server = new McpServer(
    { name: "control-center", version: "0.4.0" },
    {
      instructions: instructions(o),
    },
  );

  server.registerTool(
    "add_task",
    {
      description: "Create a task.",
      inputSchema: z.object({
        title: z.string().min(1).max(500),
        description: z
          .string()
          .optional()
          .describe("Markdown: what and why, context someone starting cold needs, then a 'Done when' checklist"),
        kind: kind.optional().describe("human, agent, or either (default)"),
        priority: priority.optional(),
        team: teamRef.optional().describe("Team key or name; inherited from the project when omitted"),
        repo: z
          .string()
          .optional()
          .describe("For code work: the repo the agent session starts in. Use a local_repos name from get_team (match by name, alias or description)."),
        project: z.string().optional().describe("e.g. Content, Finance, Health, Admin"),
        labels: z.array(z.string()).optional(),
        links: z.array(link).optional(),
        scheduled_on: z.string().date().optional().describe("YYYY-MM-DD: the day to do it (calendar). Agent tasks won't run before it"),
        due: z.string().date().optional().describe("YYYY-MM-DD deadline"),
        today: z.boolean().optional().describe("Put it on today's list"),
        ready: z.boolean().optional().describe("Skip 'new'; agent tasks marked ready get picked up by the runner"),
        parent_id: taskId.optional(),
        blocked_by: blockedBy.describe(
          "Tasks this one waits on. This delays it, it doesn't approve it: with ready=true it starts once they're done, without it stays new. If one is cancelled it moves to needs_you",
        ),
        source: z.string().optional(),
      }),
    },
    async ({ ready, team, blocked_by, ...fields }) => {
      let team_id: number | undefined;
      try {
        if (team) team_id = await resolveTeam(db, team);
      } catch (e) {
        return fail((e as Error).message);
      }
      const { data, error } = await db
        .from("tasks")
        // Ready only once the blockers are in, or the runner could start it in between.
        .insert({ ...fields, team_id, status: ready && !blocked_by?.length ? "ready" : "new" })
        .select()
        .single();
      if (error) return fail(error.message);
      if (!blocked_by?.length) return ok(withKey(data));
      const problem = await setBlockers(db, data.id, blocked_by);
      if (problem) {
        await db.from("tasks").delete().eq("id", data.id); // don't leave a half-made task to be retried beside
        return fail(problem);
      }
      if (ready) await db.from("tasks").update({ status: "ready" }).eq("id", data.id).eq("status", "new");
      // Re-read: a blocker that's already cancelled moves it to needs_you.
      const { data: settled } = await db.from("tasks").select("*,waiting_on").eq("id", data.id).single();
      return ok({ ...withKey(settled), blocked_by: [...new Set(blocked_by)] });
    },
  );

  server.registerTool(
    "list_tasks",
    {
      description:
        "List tasks. Views: today (flagged, scheduled or due today/earlier), upcoming (calendar by scheduled_on, " +
        "optional from/to), new (untriaged), agent_ready (runner queue), " +
        `needs_you (waiting on ${o}), human (open tasks for ${o}), open, done_recent. Filter by query (text search), ` +
        "team, project, label, priority. Use view='open' with query to look for an existing task before adding one.",
      inputSchema: z.object({
        view: z.enum(views).default("today"),
        query: z.string().optional().describe("Words to find in the title or description (any status unless the view narrows it)"),
        team: teamRef.optional(),
        project: z.string().optional(),
        label: z.string().optional(),
        priority: priority.optional().describe("Only this priority"),
        from: z.string().date().optional().describe("upcoming view: start date (default today)"),
        to: z.string().date().optional().describe("upcoming view: end date"),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ view, query, team, project, label, priority, from, to, limit }) => {
      let q = db.from("tasks").select(LIST_FIELDS).limit(limit);

      switch (view) {
        case "today": {
          const today = todayISO(timeZone);
          q = q.not("status", "in", OPEN).or(`today.eq.true,scheduled_on.lte.${today},due.lte.${today}`);
          // Ready work for the owner that can't be done yet isn't for today.
          q = q.or('kind.eq.agent,status.neq.ready,waiting_on.eq."{}"');
          break;
        }
        case "upcoming":
          q = q.not("status", "in", OPEN).gte("scheduled_on", from ?? todayISO(timeZone));
          if (to) q = q.lte("scheduled_on", to);
          q = q.order("scheduled_on");
          break;
        case "new":
          q = q.eq("status", "new");
          break;
        case "agent_ready":
          q = q.eq("status", "ready").eq("kind", "agent").eq("waiting_on", "{}")
            .or(`scheduled_on.is.null,scheduled_on.lte.${todayISO(timeZone)}`);
          break;
        case "needs_you":
          q = q.eq("status", "needs_you");
          break;
        case "human":
          q = q.neq("kind", "agent").not("status", "in", OPEN);
          break;
        case "open":
          q = q.not("status", "in", OPEN);
          break;
        case "done_recent":
          q = q.eq("status", "done").order("completed_at", { ascending: false });
          break;
      }
      if (team) {
        try {
          q = q.eq("team_id", await resolveTeam(db, team));
        } catch (e) {
          return fail((e as Error).message);
        }
      }
      if (query) {
        // Every word must appear in the title or description.
        for (const word of query.split(/\s+/).filter(Boolean)) {
          const term = `%${word.replace(/[%_,()*\\]/g, "")}%`;
          q = q.or(`title.ilike.${term},description.ilike.${term}`);
        }
      }
      if (project) q = q.ilike("project", project);
      if (label) q = q.contains("labels", [label]);
      if (priority !== undefined) q = q.eq("priority", priority);
      q = q.order("sort_order").order("id");

      const { data, error } = await q;
      return error ? fail(error.message) : ok(data.map(withKey));
    },
  );

  server.registerTool(
    "get_task",
    {
      description: "Get one task with sub-tasks, blockers (blocked_by), what it blocks, comments and activity.",
      inputSchema: z.object({ id: taskId }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const [task, children, blockers, blocking, comments, events] = await Promise.all([
        db.from("tasks").select("*,waiting_on,team:teams(key,name)").eq("id", id).single(),
        db.from("tasks").select("id,title,kind,status").eq("parent_id", id).order("id"),
        db.from("task_dependencies").select("task:tasks!blocked_by_id(id,title,kind,status)").eq("task_id", id).order("blocked_by_id"),
        db.from("task_dependencies").select("task:tasks!task_id(id,title,kind,status)").eq("blocked_by_id", id).order("task_id"),
        db.from("task_comments").select("author,body,attachments,created_at").eq("task_id", id).order("created_at"),
        db.from("task_events").select("kind,body,actor,created_at").eq("task_id", id).order("created_at"),
      ]);
      if (task.error) return fail(task.error.message);
      // Pasted screenshots and attached files live in a private bucket: hand out short-lived links to them.
      const signed = async (attachments: unknown) => {
        const files = (attachments ?? []) as { path: string; name: string; type: string }[];
        if (!files.length) return [];
        const { data } = await db.storage.from("comment-attachments").createSignedUrls(files.map((f) => f.path), 3600);
        return files.flatMap((f, i) => (data?.[i]?.signedUrl ? [{ name: f.name, type: f.type, url: data[i].signedUrl }] : []));
      };
      const withImages = await Promise.all(
        (comments.data ?? []).map(async ({ attachments, ...c }) => {
          const files = await signed(attachments);
          return files.length ? { ...c, images: files.map((f) => f.url), files } : c;
        }),
      );
      const { attachments, ...rest } = task.data;
      return ok({
        ...withKey(rest),
        attachments: await signed(attachments),
        subtasks: (children.data ?? []).map(withKey),
        blocked_by: linkedTasks(blockers.data),
        blocks: linkedTasks(blocking.data),
        comments: withImages,
        activity: events.data ?? [],
      });
    },
  );

  server.registerTool(
    "update_task",
    {
      description:
        "Change fields on a task. labels replaces the whole list (use add_labels/remove_labels to edit). " +
        `Use complete_task to finish, ask_human to block on ${o}, add_comment for discussion. An agent that has done ` +
        `its part of a task whose remaining steps are ${o}'s hands it back with kind='human', status='ready' and a log ` +
        "of what's left; never set status 'new' (that means untriaged).",
      inputSchema: z.object({
        id: taskId,
        title: z.string().min(1).max(500).optional(),
        description: z.string().optional(),
        kind: kind.optional(),
        status: status.optional(),
        priority: priority.optional(),
        team: teamRef.nullable().optional().describe("Move to a team (null to clear)"),
        repo: z.string().nullable().optional().describe("Repo the agent session starts in (name or path; null to clear)"),
        worktree: z.string().nullable().optional().describe("Full path of a git worktree an agent made for this task, so the runner cleans it up"),
        project: z.string().nullable().optional(),
        labels: z.array(z.string()).optional(),
        add_labels: z.array(z.string()).optional(),
        remove_labels: z.array(z.string()).optional(),
        add_links: z.array(link).optional().describe("Append links, e.g. output files or URLs"),
        scheduled_on: z.string().date().nullable().optional().describe("Reschedule (YYYY-MM-DD) or null to unschedule"),
        due: z.string().date().nullable().optional(),
        today: z.boolean().optional(),
        parent_id: taskId.nullable().optional(),
        blocked_by: blockedBy.describe(
          "Replaces the tasks this one waits on ([] clears them). This delays the task, it doesn't approve it or change its status",
        ),
        sort_order: z.number().optional(),
        session_id: z.string().optional(),
        log: z.string().optional().describe("Progress note for the activity log"),
        actor: z.string().optional(),
      }),
    },
    async ({ id, log, actor, add_labels, remove_labels, add_links, team, blocked_by, ...fields }) => {
      if (team !== undefined) {
        try {
          (fields as Record<string, unknown>).team_id = team === null ? null : await resolveTeam(db, team);
        } catch (e) {
          return fail((e as Error).message);
        }
      }
      if (add_labels || remove_labels || add_links) {
        const cur = await db.from("tasks").select("labels,links").eq("id", id).single();
        if (cur.error) return fail(cur.error.message);
        if (add_labels || remove_labels) {
          const set = new Set([...(fields.labels ?? cur.data.labels), ...(add_labels ?? [])]);
          remove_labels?.forEach((l) => set.delete(l));
          fields.labels = [...set];
        }
        if (add_links) (fields as Record<string, unknown>).links = [...cur.data.links, ...add_links];
      }
      // First, so a rejected cycle leaves the rest of the update unapplied.
      if (blocked_by) {
        const problem = await setBlockers(db, id, blocked_by);
        if (problem) return fail(problem);
      }
      if (Object.keys(fields).length) {
        const { error } = await db.from("tasks").update(fields).eq("id", id);
        if (error) return fail(error.message);
      }
      if (log) await logEvent(db, id, "agent_log", log, actor ?? "claude");
      if (fields.status) await logEvent(db, id, "status", fields.status, actor ?? "claude");
      const { data } = await db.from("tasks").select("*,waiting_on").eq("id", id).single();
      return ok(blocked_by ? { ...withKey(data), blocked_by: [...new Set(blocked_by)] } : withKey(data));
    },
  );

  server.registerTool(
    "add_comment",
    {
      description:
        `Comment on a task. author='me' when relaying ${o}'s words (reaches a running agent session); ` +
        `'claude' for your own notes; 'agent' from a runner session. Non-'me' comments land in ${o}'s inbox.`,
      inputSchema: z.object({ id: taskId, body: z.string().min(1), author: author.default("claude") }),
    },
    async ({ id, body, author }) => {
      const { data, error } = await db
        .from("task_comments")
        .insert({ task_id: id, body, author })
        .select()
        .single();
      return error ? fail(error.message) : ok(data);
    },
  );

  server.registerTool(
    "complete_task",
    {
      description: "Mark a task done, with a short summary of what was done.",
      inputSchema: z.object({ id: taskId, summary: z.string().optional(), actor: z.string().optional() }),
    },
    async ({ id, summary, actor }) => {
      const { data, error } = await db
        .from("tasks")
        .update({ status: "done", question: null })
        .eq("id", id)
        .select()
        .single();
      if (error) return fail(error.message);
      await logEvent(db, id, "status", summary ? `done: ${summary}` : "done", actor ?? "claude");
      return ok(withKey(data));
    },
  );

  server.registerTool(
    "ask_human",
    {
      description:
        `Block a task on a question for ${o}: posts it as a comment, sets needs_you and puts it in their inbox. ` +
        "The runner resumes the session once they answer. For a choice, pass options: they show as buttons on the board.",
      inputSchema: z.object({
        id: taskId,
        question: z.string().min(1).describe("The full question with the context needed to answer it (Markdown)"),
        options: z
          .array(z.object({ label: z.string(), description: z.string().optional() }))
          .optional()
          .describe("Choices to pick from, e.g. [{label: 'Ship v1', description: 'as is'}]. They can still type something else."),
        multi_select: z.boolean().optional().describe("Allow picking several options"),
        session_id: z.string().optional().describe("Claude session id so the runner can resume"),
      }),
    },
    async ({ id, question, options, multi_select, session_id }) => {
      const patch: Record<string, unknown> = { status: "needs_you", question };
      patch.question_options = options?.length
        ? [{ question, header: null, multiSelect: Boolean(multi_select), options: options.map((o) => ({ label: o.label, description: o.description ?? null })) }]
        : null;
      if (session_id) patch.session_id = session_id;
      // Status first so the inbox gets one "question" entry; the comment trigger skips the duplicate.
      const { data, error } = await db.from("tasks").update(patch).eq("id", id).select().single();
      if (error) return fail(error.message);
      await db.from("task_comments").insert({ task_id: id, author: "agent", body: question });
      return ok(withKey(data));
    },
  );

  server.registerTool(
    "answer_task",
    {
      description: `Answer the open question on a needs_you task (as ${o}). Hands it back to the runner.`,
      inputSchema: z.object({ id: taskId, answer: z.string().min(1) }),
    },
    async ({ id, answer }) => {
      const { data, error } = await db
        .from("tasks")
        .update({ status: "ready", question: null })
        .eq("id", id)
        .eq("status", "needs_you")
        .select()
        .maybeSingle();
      if (error) return fail(error.message);
      if (!data) return fail(`CC-${id} isn't waiting on an answer.`);
      await db.from("task_comments").insert({ task_id: id, author: "me", body: answer });
      return ok(withKey(data));
    },
  );

  server.registerTool(
    "add_human_task",
    {
      description:
        `Hand a step to ${o}, e.g. 'Post this on LinkedIn' with the draft in instructions. ` +
        "Created as a ready human sub-task on today's list and flagged in his inbox.",
      inputSchema: z.object({
        parent_id: taskId,
        title: z.string().min(1).max(500),
        instructions: z.string().describe(`Everything ${o} needs: drafts, links, exact steps`),
        priority: priority.optional(),
      }),
    },
    async ({ parent_id, title, instructions, priority }) => {
      const parent = await db.from("tasks").select("team_id,project,labels,priority").eq("id", parent_id).single();
      if (parent.error) return fail(parent.error.message);
      const { data, error } = await db
        .from("tasks")
        .insert({
          title,
          description: instructions,
          parent_id,
          kind: "human",
          status: "ready",
          today: true,
          team_id: parent.data.team_id,
          project: parent.data.project,
          labels: parent.data.labels,
          priority: priority ?? parent.data.priority,
          source: "agent",
        })
        .select()
        .single();
      return error ? fail(error.message) : ok(withKey(data));
    },
  );

  server.registerTool(
    "plan_today",
    {
      description:
        "Set today's list: flags the given task ids as today (and marks new ones ready, which starts agent tasks). " +
        "With replace=true, un-flags everything else first.",
      inputSchema: z.object({ ids: z.array(taskId).min(1), replace: z.boolean().default(false) }),
    },
    async ({ ids, replace }) => {
      if (replace) {
        const { error } = await db
          .from("tasks")
          .update({ today: false })
          .eq("today", true)
          .not("id", "in", `(${ids.join(",")})`);
        if (error) return fail(error.message);
      }
      const flagged = await db.from("tasks").update({ today: true }).in("id", ids);
      if (flagged.error) return fail(flagged.error.message);
      await db.from("tasks").update({ status: "ready" }).in("id", ids).eq("status", "new");
      const { data } = await db.from("tasks").select("id,title,kind,status").in("id", ids).order("sort_order");
      return ok((data ?? []).map(withKey));
    },
  );

  server.registerTool(
    "list_inbox",
    {
      description:
        `${o}'s inbox: agent questions, comments from Claude/agents, handed-off tasks, finished agent work. Unread first.`,
      inputSchema: z.object({
        unread_only: z.boolean().default(true),
        limit: z.number().int().min(1).max(100).default(30),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ unread_only, limit }) => {
      let q = db
        .from("notifications")
        .select("id,kind,body,read_at,created_at,task:tasks(id,title,status)")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (unread_only) q = q.is("read_at", null);
      const { data, error } = await q;
      return error ? fail(error.message) : ok(data);
    },
  );

  server.registerTool(
    "mark_inbox_read",
    {
      description: "Mark inbox items read, by notification ids or everything for a task.",
      inputSchema: z.object({ ids: z.array(z.number().int()).optional(), task_id: taskId.optional() }),
    },
    async ({ ids, task_id }) => {
      if (!ids && !task_id) return fail("Pass ids or task_id.");
      let q = db.from("notifications").update({ read_at: new Date().toISOString() }).is("read_at", null);
      q = ids ? q.in("id", ids) : q.eq("task_id", task_id!);
      const { error } = await q;
      return error ? fail(error.message) : ok({ ok: true });
    },
  );

  server.registerTool(
    "list_teams",
    {
      description: "Teams (companies and Personal) with their projects. Use get_team for a team's briefing and repos.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const { data, error } = await db
        .from("teams")
        .select("key,name,kind,projects(name)")
        .order("sort_order")
        .order("id");
      if (error) return fail(error.message);
      const loose = await db.from("projects").select("name").is("team_id", null).order("name");
      return ok({
        teams: data.map((t) => ({ ...t, projects: t.projects.map((p: { name: string }) => p.name) })),
        projects_without_team: (loose.data ?? []).map((p) => p.name),
      });
    },
  );

  server.registerTool(
    "get_team",
    {
      description:
        "A team's briefing (context), GitHub org, working folder, projects with their specs, and local_repos: every repo " +
        `checked out on ${o}'s Mac (name, GitHub, description, aliases). Use a local_repos name as a task's repo.`,
      inputSchema: z.object({ team: teamRef }),
      annotations: { readOnlyHint: true },
    },
    async ({ team }) => {
      let id: number;
      try {
        id = await resolveTeam(db, team);
      } catch (e) {
        return fail((e as Error).message);
      }
      const { data, error } = await db
        .from("teams")
        .select("key,name,kind,color,github,base_branch,context,repos,workdir,projects(name,description,repos),local_repos:repos(name,github_url,description,aliases,base_branch)")
        .eq("id", id)
        .eq("local_repos.hidden", false)
        .single();
      return error ? fail(error.message) : ok(data);
    },
  );

  server.registerTool(
    "save_team",
    {
      description:
        "Create or update a team by key. context is a Markdown briefing every agent working on this team's tasks " +
        "reads first (what the company does, rules, tone, people). repos replaces the whole list.",
      inputSchema: z.object({
        key: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).describe("Slug, e.g. 'flixr'"),
        name: z.string().min(1).max(80).optional().describe("Required when creating"),
        kind: z.enum(["company", "personal"]).optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        context: z.string().optional(),
        repos: z.array(repo).optional(),
        workdir: z.string().optional().describe("Local folder for this team's work"),
        github: z.string().url().optional().describe("GitHub org or user URL, e.g. https://github.com/acme"),
      }),
    },
    async ({ key, ...fields }) => {
      const existing = await db.from("teams").select("id").eq("key", key).maybeSingle();
      if (existing.error) return fail(existing.error.message);
      const result = existing.data
        ? await db.from("teams").update(fields).eq("id", existing.data.id).select().single()
        : fields.name
          ? await db.from("teams").insert({ key, ...fields }).select().single()
          : null;
      if (!result) return fail(`No team "${key}" yet; pass name to create it.`);
      return result.error ? fail(result.error.message) : ok(result.data);
    },
  );

  server.registerTool(
    "save_project",
    {
      description:
        "Create or update a project by name: its team, a Markdown spec agents read, and repos. " +
        "Moving a project to another team moves its tasks.",
      inputSchema: z.object({
        name: z.string().min(1).max(120),
        team: teamRef.nullable().optional(),
        description: z.string().optional(),
        repos: z.array(repo).optional(),
        pr_review: z
          .enum(["owner", "agent"])
          .optional()
          .describe(
            `Who takes agents' PRs to merged: 'owner' (${o} gets a review-and-merge task; default) or 'agent' ` +
              "(a fresh agent session waits for the repo's AI review pipeline, or runs /code-review where there is none, fixes what's left, and merges once CI is green)",
          ),
      }),
    },
    async ({ name, team, ...fields }) => {
      const patch: Record<string, unknown> = { ...fields };
      if (team !== undefined) {
        try {
          patch.team_id = team === null ? null : await resolveTeam(db, team);
        } catch (e) {
          return fail((e as Error).message);
        }
      }
      const existing = await db.from("projects").select("id").ilike("name", name).maybeSingle();
      if (existing.error) return fail(existing.error.message);
      const result = existing.data
        ? await db.from("projects").update(patch).eq("id", existing.data.id).select().single()
        : await db.from("projects").insert({ name, ...patch }).select().single();
      return result.error ? fail(result.error.message) : ok(result.data);
    },
  );

  return server;
}
