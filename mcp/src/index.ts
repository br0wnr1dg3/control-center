import OAuthProvider, { type ConsentDescription, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { handleAgentMail, type EmailEnv } from "./email";
import { buildServer } from "./tools";

type AuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

const OWNER = "owner";

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

async function passphraseMatches(given: string, expected: string) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function consentPage(details: ConsentDescription, handle: string, error?: string) {
  const name = escape(details.clientName);
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Control Center · Connect</title>
<style>
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; max-width: 420px; margin: 12vh auto; padding: 0 16px; color: #1d1d1f; background: #fafafa; }
  @media (prefers-color-scheme: dark) { body { color: #f5f5f7; background: #111; } input { background: #222; color: inherit; border-color: #444; } }
  input { width: 100%; padding: 10px; font: inherit; border: 1px solid #ccc; border-radius: 8px; box-sizing: border-box; }
  button { padding: 8px 16px; font: inherit; border-radius: 8px; border: 0; margin-right: 8px; cursor: pointer; }
  .allow { background: #0a66ff; color: #fff; }
  .err { color: #d70015; }
  .muted { opacity: .7; font-size: 13px; }
</style>
<h1>Connect ${name}?</h1>
<p>${name} wants full access to your Control Center tasks.</p>
<p class="muted">Access will be sent to <strong>${escape(details.redirectHost)}</strong>.
${details.clientDomain ? `Published by <strong>${escape(details.clientDomain)}</strong>.` : "The app's name is self-reported."}</p>
${details.redirectIsLoopback ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>" : ""}
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <p><input type="password" name="passphrase" placeholder="Passphrase" autofocus autocomplete="current-password"></p>
  ${error ? `<p class="err">${escape(error)}</p>` : ""}
  <p><button class="allow" name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button></p>
</form>`;
}

function html(body: string, headers = new Headers()) {
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(body, { headers });
}

const authHandler = {
  async fetch(request: Request, env: AuthEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/hooks/agentmail") return handleAgentMail(request, env as unknown as EmailEnv, ctx);
    if (url.pathname !== "/authorize") return new Response("Not found", { status: 404 });

    const oauth = env.OAUTH_PROVIDER;
    const authRequest = await oauth.parseAuthRequest(request);
    const details = await oauth.describeConsent(authRequest);

    if (request.method === "GET") {
      const consent = await oauth.beginConsent(authRequest);
      return html(consentPage(details, consent.handle), consent.headers);
    }

    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");

    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }

    if (!(await passphraseMatches(String(form.get("passphrase") ?? ""), env.OWNER_PASSPHRASE))) {
      await new Promise((r) => setTimeout(r, 1500)); // slow down guessing
      return html(consentPage(details, handle, "Wrong passphrase."));
    }

    const approved = await oauth.approveConsent(request, handle, { scope: authRequest.scope });
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: OWNER,
      metadata: { client: details.clientName },
      scope: approved.request.scope,
      props: { userId: OWNER },
    });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  },
};

const mcpHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return createMcpHandler(() => buildServer(env), { route: "/mcp" })(request, env, ctx);
  },
};

export default new OAuthProvider<AuthEnv>({
  apiRoute: "/mcp",
  apiHandler: mcpHandler,
  defaultHandler: authHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  clientIdMetadataDocumentEnabled: true,
  resourceMetadata: {
    resource: `${env.PUBLIC_URL}/mcp`,
    authorization_servers: [env.PUBLIC_URL],
    resource_name: "Control Center",
  },
  // Long-lived access so Slack/web connectors don't need re-auth every hour.
  accessTokenTTL: 60 * 60 * 24,
});
