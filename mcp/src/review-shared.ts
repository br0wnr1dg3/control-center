// What the review page (review.ts) and the batch page (batch.ts) both need.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type ReviewEnv = Env & { MEDIA: R2Bucket; UPLOAD_TOKEN: string };

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

export const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const database = (env: ReviewEnv) =>
  createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function tokenMatches(given: string, expected: string) {
  if (!expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

// Publishing and making batches are for agents, which hold the upload token.
export const mayUpload = (request: Request, env: ReviewEnv) =>
  tokenMatches(request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "", env.UPLOAD_TOKEN);

// Notes and decisions are a reviewer's, made on Control Center's own pages: a link alone lets you read a review,
// not write to it from anywhere. A browser says where a POST comes from (Origin, Sec-Fetch-Site), and a document
// with no origin of its own, as a sandboxed HTML review is, says "null". Whatever a browser says has to be this
// site. A request that says nothing isn't a browser's, and needs the upload token as publishing does.
export async function fromOwnPage(request: Request, env: ReviewEnv): Promise<boolean> {
  const origin = request.headers.get("Origin"), site = request.headers.get("Sec-Fetch-Site");
  if (origin === null && site === null) return mayUpload(request, env);
  const own = [new URL(request.url).origin];
  try { own.push(new URL(env.PUBLIC_URL).origin); } catch { /* not set: the request's own address is the only one */ }
  return (origin === null || own.includes(origin)) && (site === null || site === "same-origin");
}

export async function teamKey(db: SupabaseClient, taskId: number): Promise<string | null> {
  const { data } = await db.from("tasks").select("team:teams(key)").eq("id", taskId).maybeSingle();
  return (data?.team as { key?: string } | null)?.key ?? null;
}

export const reviewPath = (team: string | null, token: string) => (team ? `/r/${team}/${token}` : `/r/${token}`);

// A review named by its link or its bare token.
export const tokenOf = (value: unknown) => String(value ?? "").split(/[/?#]/).filter(Boolean).pop() ?? "";

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const PAGE_HEADERS = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
