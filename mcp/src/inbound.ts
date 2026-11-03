// Signed inbound events: a trusted app creates job trees and advances stages (POST /hooks/inbound).
//
// Each team has its own secret, the Worker secret INBOUND_SECRET_<TEAM KEY> (uppercase, "-" as "_"); a team
// without one accepts nothing. The sender signs every request:
//   X-CC-Team:      team key
//   X-CC-Timestamp: unix seconds (within 5 minutes)
//   X-CC-Signature: v1=<hex HMAC-SHA256 of "<timestamp>.<raw body>">
//
// This file only authenticates and checks the event's shape. apply_inbound_event in Postgres does the
// rest in one transaction, including idempotency by event id. See README for the event formats.

import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const MAX_BODY = 1_000_000;
const MAX_AGE_SECONDS = 300;

const externalId = z.string().min(1).max(200);
const webUrl = z
  .string()
  .url()
  .max(2000)
  .refine((u) => /^https?:\/\//i.test(u), "must be http or https"); // the app opens these on click

const taskFields = {
  id: externalId,
  url: webUrl.optional(),
  title: z.string().min(1).max(500),
  description: z.string().max(100_000).optional(),
  kind: z.enum(["human", "agent", "either"]).optional(),
  priority: z.number().int().min(0).max(4).optional(),
  labels: z.array(z.string().min(1).max(100)).max(50).optional(),
  scheduled_on: z.string().date().optional(),
  due: z.string().date().optional(),
  // Approves the task: a ready agent task runs without further review. Off unless the sender says so.
  ready: z.boolean().optional(),
};

const envelope = {
  id: z.string().min(1).max(200),
  source: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,49}$/)
    .refine((s) => s !== "agent", "is reserved"), // tasks.source = 'agent' means an agent's hand-off to the owner
};

const eventSchema = z.discriminatedUnion("type", [
  z.object({
    ...envelope,
    type: z.literal("job.create"),
    job: z.object({
      ...taskFields,
      project: z.string().min(1).max(120).optional(),
      requested_by: z
        .object({ name: z.string().min(1).max(200).optional(), email: z.string().email().max(320).optional() })
        .refine((r) => r.name || r.email, "needs a name or an email")
        .optional(),
      stages: z
        .array(z.object({ ...taskFields, blocked_by: z.array(externalId).max(100).optional() }))
        .max(100)
        .optional(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal("stage.ready"),
    task: externalId,
    note: z.string().min(1).max(2000).optional(),
  }),
  z.object({
    ...envelope,
    type: z.literal("comment"),
    task: externalId,
    body: z.string().min(1).max(100_000),
    author: z.string().min(1).max(200).optional(),
  }),
]);

const json = (status: number, body: unknown) => Response.json(body, { status });

export function inboundSecretName(team: string) {
  return `INBOUND_SECRET_${team.toUpperCase().replace(/-/g, "_")}`;
}

async function verifySignature(secret: string, timestamp: string, signature: string, body: string) {
  if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > MAX_AGE_SECONDS) return false;
  const hex = signature.match(/^v1=([0-9a-f]{64})$/)?.[1];
  if (!hex) return false;
  const given = Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, given, enc.encode(`${timestamp}.${body}`)); // constant time
}

const STATUS_FOR_CODE: Record<string, number> = {
  CC404: 404,
  CC409: 409,
  CC422: 422,
  "23514": 422, // a stage blocked by itself, or a cycle
};

export async function handleInbound(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // One answer for every way of failing this, so it doesn't reveal which teams exist or have a secret.
  const unauthorized = () => json(401, { error: "bad signature" });
  const team = request.headers.get("x-cc-team") ?? "";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(team)) return unauthorized();
  const secret = (env as unknown as Record<string, unknown>)[inboundSecretName(team)];
  if (typeof secret !== "string" || !secret) return unauthorized();

  const body = await request.text();
  if (body.length > MAX_BODY) return json(413, { error: "body too large" });
  const verified = await verifySignature(
    secret,
    request.headers.get("x-cc-timestamp") ?? "",
    request.headers.get("x-cc-signature") ?? "",
    body,
  );
  if (!verified) return unauthorized();

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json(400, { error: "body isn't JSON" });
  }
  const event = eventSchema.safeParse(parsed);
  if (!event.success) {
    return json(400, {
      error: "invalid event",
      issues: event.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  const { id, source, type, ...rest } = event.data;
  const payload = "job" in rest ? rest.job : rest;

  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: teamRow, error: teamError } = await db.from("teams").select("id").eq("key", team).maybeSingle();
  if (teamError) {
    console.error("inbound: team lookup failed:", teamError.message);
    return json(500, { error: "internal error" });
  }
  if (!teamRow) return unauthorized();

  const { data, error } = await db.rpc("apply_inbound_event", {
    p_team: teamRow.id,
    p_source: source,
    p_event_id: id,
    p_type: type,
    p_payload: payload,
  });
  if (error) {
    const status = STATUS_FOR_CODE[error.code];
    if (status) return json(status, { error: error.message });
    console.error("inbound: apply failed:", error.code, error.message);
    return json(500, { error: "internal error" }); // worth retrying with the same event id
  }
  return json(200, { ok: true, event: id, ...data });
}
