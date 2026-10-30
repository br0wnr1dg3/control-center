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
  "id,title,kind,status,priority,team:teams(key,name),project,labels,scheduled_on,due,today,parent_id,question,updated_at";

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
const INSTRUCTIONS = `Control Center is Chris's task board for everything outside engineering (Linear covers engineering).

Referring to things
- Tasks are CC-<id> (CC-12 is id 12); tools accept 12, "12" or "CC-12". Write "CC-12" in text and it becomes a link in the app.
- Teams are companies plus Personal. Each project belongs to one team and tasks inherit it. Call list_teams before using a team or project you haven't seen this conversation; reuse existing names exactly, and only invent a new project when nothing fits (then pass team).
- For code or app work (changing, deploying or administering one of the team's apps), set repo: call get_team and pick from local_repos by name, alias or description. Leave it empty if unsure; the runner matches or the agent asks.
- Before adding, check for duplicates with list_tasks(query=...). Update or comment on an existing task instead of adding a near-copy.

Writing a task
- Title: a short imperative with the outcome, e.g. "Draft LinkedIn post on menopause study", not "LinkedIn".
- Description (Markdown): what and why in 1-2 lines, then the context someone starting cold needs (links, file paths, names), then a "Done when" checklist (- [ ] ...). For agent tasks also list constraints and where outputs go. Keep team-wide rules in the team briefing (save_team context), not in every task.
- kind: 'agent' only if Claude can finish it alone with a computer; posting publicly, sending messages as Chris, calls, payments, logins and errands are 'human'. Mixed work = an agent task whose agent hands the human step back with add_human_task, or separate sub-tasks.
- Split work longer than a session into sub-tasks (parent_id) under one parent that holds the shared brief.
- Dates: scheduled_on = the day to do it (puts it on the calendar; agent tasks wait for it). due = a real deadline only. Use YYYY-MM-DD in Chris's timezone. today=true pins to today's list.
- Status: new by default. Set ready=true only when Chris says to go ahead: ready agent tasks are executed by the runner without further review.
- Priority only when stated or obvious (1 urgent ... 4 low). Labels are lowercase tags for cross-cutting themes (linkedin, research), not a substitute for project.
- Always pass source: 'cli', 'slack', 'web:<account>' or 'app'.

Comments and answers
- Relaying Chris's own words: author='me' (a running agent receives them). Your own notes: author='claude'. Runner sessions: author='agent'.
- Answer a waiting question with answer_task, which hands the task back to its agent.
- To hand any task to an agent (e.g. "get the agent to merge CC-46"), add_comment with author='me' and a body starting "@agent " followed by Chris's instruction; it becomes a ready agent task and the runner starts it.

After creating or changing tasks, reply with each task's CC key and title.`;

export function buildServer(env: Env) {
  const timeZone = env.TIMEZONE;
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const server = new McpServer(
    { name: "control-center", version: "0.4.0" },
    {
      instructions: INSTRUCTIONS,
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
        source: z.string().optional(),
      }),
    },
    async ({ ready, team, ...fields }) => {
      let team_id: number | undefined;
      try {
        if (team) team_id = await resolveTeam(db, team);
      } catch (e) {
        return fail((e as Error).message);
      }
      const { data, error } = await db
        .from("tasks")
        .insert({ ...fields, team_id, status: ready ? "ready" : "new" })
        .select()
        .single();
      return error ? fail(error.message) : ok(withKey(data));
    },
  );

  server.registerTool(
    "list_tasks",
    {
      description:
        "List tasks. Views: today (flagged, scheduled or due today/earlier), upcoming (calendar by scheduled_on, " +
        "optional from/to), new (untriaged), agent_ready (runner queue), " +
        "needs_you (waiting on Chris), human (open tasks for Chris), open, done_recent. Filter by query (text search), " +
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
          q = q.eq("status", "ready").eq("kind", "agent")
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
      description: "Get one task with sub-tasks, comments and activity.",
      inputSchema: z.object({ id: taskId }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const [task, children, comments, events] = await Promise.all([
        db.from("tasks").select("*,team:teams(key,name)").eq("id", id).single(),
        db.from("tasks").select("id,title,kind,status").eq("parent_id", id).order("id"),
        db.from("task_comments").select("author,body,created_at").eq("task_id", id).order("created_at"),
        db.from("task_events").select("kind,body,actor,created_at").eq("task_id", id).order("created_at"),
      ]);
      if (task.error) return fail(task.error.message);
      return ok({
        ...withKey(task.data),
        subtasks: (children.data ?? []).map(withKey),
        comments: comments.data ?? [],
        activity: events.data ?? [],
      });
    },
  );

  server.registerTool(
    "update_task",
    {
      description:
        "Change fields on a task. labels replaces the whole list (use add_labels/remove_labels to edit). " +
        "Use complete_task to finish, ask_human to block on Chris, add_comment for discussion. An agent that has done " +
        "its part of a task whose remaining steps are Chris's hands it back with kind='human', status='ready' and a log " +
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
        sort_order: z.number().optional(),
        session_id: z.string().optional(),
        log: z.string().optional().describe("Progress note for the activity log"),
        actor: z.string().optional(),
      }),
    },
    async ({ id, log, actor, add_labels, remove_labels, add_links, team, ...fields }) => {
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
      if (Object.keys(fields).length) {
        const { error } = await db.from("tasks").update(fields).eq("id", id);
        if (error) return fail(error.message);
      }
      if (log) await logEvent(db, id, "agent_log", log, actor ?? "claude");
      if (fields.status) await logEvent(db, id, "status", fields.status, actor ?? "claude");
      const { data } = await db.from("tasks").select("*").eq("id", id).single();
      return ok(withKey(data));
    },
  );

  server.registerTool(
    "add_comment",
    {
      description:
        "Comment on a task. author='me' when relaying Chris's words (reaches a running agent session); " +
        "'claude' for your own notes; 'agent' from a runner session. Non-'me' comments land in Chris's inbox.",
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
        "Block a task on a question for Chris: posts it as a comment, sets needs_you and puts it in his inbox. " +
        "The runner resumes the session once he answers.",
      inputSchema: z.object({
        id: taskId,
        question: z.string().min(1),
        session_id: z.string().optional().describe("Claude session id so the runner can resume"),
      }),
    },
    async ({ id, question, session_id }) => {
      const patch: Record<string, unknown> = { status: "needs_you", question };
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
      description: "Answer the open question on a needs_you task (as Chris). Hands it back to the runner.",
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
        "Hand a step to Chris, e.g. 'Post this on LinkedIn' with the draft in instructions. " +
        "Created as a ready human sub-task on today's list and flagged in his inbox.",
      inputSchema: z.object({
        parent_id: taskId,
        title: z.string().min(1).max(500),
        instructions: z.string().describe("Everything Chris needs: drafts, links, exact steps"),
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
        "Chris's inbox: agent questions, comments from Claude/agents, handed-off tasks, finished agent work. Unread first.",
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
        "checked out on Chris's Mac (name, GitHub, description, aliases). Use a local_repos name as a task's repo.",
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
        .select("key,name,kind,color,github,context,repos,workdir,projects(name,description,repos),local_repos:repos(name,github_url,description,aliases)")
        .eq("id", id)
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
