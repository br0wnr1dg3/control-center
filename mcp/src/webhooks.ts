// Outbound webhooks: the sender. Triggers fill the outbox (webhook_deliveries); this claims what's due, signs
// it with each webhook's own secret and reports back. Runs every minute on the Worker's cron, since the
// runner's Mac can sleep. See README for the payload and signing format.
//
// Delivery is at least once: a run that dies mid-send leaves its claims to expire and be sent again, which
// is why each event carries an id for the receiver to dedupe on.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const BATCH = 20; // about 40 subrequests a run, within the Workers Free limit of 50
const TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_BASE_SECONDS = 60;

type Claimed = {
  delivery_id: number;
  webhook_id: number;
  url: string;
  secret: string;
  event_id: string;
  event_type: string;
  attempts: number;
  payload: Record<string, unknown>;
};

type WebhookEnv = Env & { WEBHOOK_RETRY_BASE_SECONDS?: string };

export function serviceClient(env: Env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

async function sign(secret: string, timestamp: string, body: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${body}`));
  return `v1=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// The database knows a review's token but not this Worker's address.
function withReviewUrl(payload: Record<string, unknown>, publicUrl: string) {
  const review = payload.review as { token?: string } | undefined;
  if (!review?.token) return payload;
  const { token, ...rest } = review;
  const team = (payload.task as { team?: { key?: string } | null } | undefined)?.team?.key;
  return { ...payload, review: { ...rest, url: `${publicUrl}${team ? `/r/${team}/${token}` : `/r/${token}`}` } };
}

// Status only: what an endpoint says back is not ours to store or show in the inbox.
async function post(d: Claimed, publicUrl: string): Promise<{ http: number | null; error: string | null }> {
  const body = JSON.stringify(withReviewUrl(d.payload, publicUrl));
  const timestamp = String(Math.floor(Date.now() / 1000));
  try {
    const response = await fetch(d.url, {
      method: "POST",
      redirect: "manual", // a redirect could carry the signed body somewhere the owner never approved
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "user-agent": "control-center-webhooks",
        "x-cc-webhook": String(d.webhook_id),
        "x-cc-event": d.event_id,
        "x-cc-event-type": d.event_type,
        "x-cc-timestamp": timestamp,
        "x-cc-signature": await sign(d.secret, timestamp, body),
      },
      body,
    });
    await response.body?.cancel();
    return { http: response.status, error: null };
  } catch (e) {
    const timedOut = (e as Error).name === "TimeoutError";
    return { http: null, error: timedOut ? `no answer in ${TIMEOUT_MS / 1000}s` : "couldn't connect" };
  }
}

async function send(db: SupabaseClient, env: Env, d: Claimed) {
  const { http, error } = await post(d, env.PUBLIC_URL);
  const base = Number((env as WebhookEnv).WEBHOOK_RETRY_BASE_SECONDS ?? DEFAULT_RETRY_BASE_SECONDS);
  const finished = await db.rpc("finish_webhook_delivery", {
    p_delivery: d.delivery_id,
    p_http: http,
    p_error: error,
    p_retry_base_seconds: base,
  });
  // The claim expires and it goes out again, which the event id makes safe.
  if (finished.error) console.error(`webhooks: couldn't record delivery ${d.delivery_id}:`, finished.error.message);
}

// Each webhook runs in parallel with the others, so a slow one only holds up itself. Within a webhook they
// go in order, which keeps a healthy endpoint's events in sequence.
export async function deliverWebhooks(env: Env, delivery?: number) {
  const db = serviceClient(env);
  const { data, error } = await db.rpc("claim_webhook_deliveries", { p_limit: BATCH, p_delivery: delivery ?? null });
  if (error) {
    console.error("webhooks: claim failed:", error.message);
    return 0;
  }
  const claimed = (data ?? []) as Claimed[];
  const byWebhook = Map.groupBy(claimed, (d) => d.webhook_id);
  await Promise.all(
    [...byWebhook.values()].map(async (deliveries) => {
      for (const d of deliveries) await send(db, env, d);
    }),
  );
  return claimed.length;
}

export async function runWebhookCron(env: Env, scheduledTime: number) {
  await deliverWebhooks(env);
  if (new Date(scheduledTime).getUTCMinutes() === 0) {
    const { error } = await serviceClient(env).rpc("prune_webhook_deliveries");
    if (error) console.error("webhooks: prune failed:", error.message);
  }
}
