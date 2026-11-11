import type { Env } from "./index";
import { BOT_SCOPES, registry } from "./install";

const COOKIE = "vr_oauth_state";
const COOKIE_PATH = "/slack/oauth";
const STATE_COOKIE_MAX_AGE_S = 600;

type AccessResponse = {
  ok: boolean;
  error?: string;
  access_token?: string;
  bot_user_id?: string;
  is_enterprise_install?: boolean;
  team?: { id?: string; name?: string };
};

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

function stateCookie(value: string, maxAge: number, secure: boolean): string {
  // Lax, not Strict: the callback is a top-level GET navigation arriving from slack.com, which Lax cookies accompany.
  return `${COOKIE}=${value}; Path=${COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** Back to the landing page with a result flag only: the page words it, so a crafted link cannot make it say anything else. */
function backToLanding(origin: string, result: "ok" | "cancelled" | "failed", secure: boolean): Response {
  const headers = new Headers({ Location: `${origin}/?install=${result}`, "Cache-Control": "no-store" });
  headers.append("Set-Cookie", stateCookie("", 0, secure));
  return new Response(null, { status: 302, headers });
}

/** Sends the browser to Slack's consent screen with a fresh single-use state, also kept in a cookie for the callback. */
export async function startInstall(request: Request, env: Env): Promise<Response> {
  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) {
    return new Response("Installing is not set up on this server.", { status: 503 });
  }
  const url = new URL(request.url);
  const state = await registry(env).newState();
  if (state === null) return new Response("Too many installs in progress. Try again in a few minutes.", { status: 429 });

  const authorize = new URL(env.SLACK_OAUTH_URL ?? "https://slack.com/oauth/v2/authorize");
  authorize.searchParams.set("client_id", env.SLACK_CLIENT_ID);
  authorize.searchParams.set("scope", BOT_SCOPES.join(","));
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("redirect_uri", `${url.origin}/slack/oauth/callback`);

  const headers = new Headers({ Location: authorize.toString(), "Cache-Control": "no-store" });
  headers.append("Set-Cookie", stateCookie(state, STATE_COOKIE_MAX_AGE_S, url.protocol === "https:"));
  return new Response(null, { status: 302, headers });
}

/**
 * Slack redirects back with a code. The state must be the one issued by startInstall twice over: still outstanding in the
 * registry (single use) and equal to the cookie of the browser that began the flow, so a link planted by someone else
 * cannot install their workspace's token under a victim's session.
 */
export async function finishInstall(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const secure = url.protocol === "https:";
  const state = url.searchParams.get("state") ?? "";
  const cookie = readCookie(request, COOKIE);

  // Consumed first, so even a failing attempt cannot be replayed.
  const known = await registry(env).consumeState(state);
  if (!known || cookie === null || cookie !== state) return backToLanding(url.origin, "failed", secure);

  if (url.searchParams.get("error")) return backToLanding(url.origin, "cancelled", secure);
  const code = url.searchParams.get("code");
  if (!code || !env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) return backToLanding(url.origin, "failed", secure);

  let body: AccessResponse;
  try {
    const res = await fetch(`${env.SLACK_API_URL ?? "https://slack.com/api"}/oauth.v2.access`, {
      method: "POST",
      body: new URLSearchParams({
        client_id: env.SLACK_CLIENT_ID,
        client_secret: env.SLACK_CLIENT_SECRET,
        code,
        redirect_uri: `${url.origin}/slack/oauth/callback`,
      }),
      signal: AbortSignal.timeout(5000),
    });
    body = (await res.json()) as AccessResponse;
  } catch (err) {
    console.error("oauth.v2.access threw:", err);
    return backToLanding(url.origin, "failed", secure);
  }

  const teamId = body.team?.id;
  // Enterprise Grid org-wide installs hand out a token per org, not per workspace, which this app does not model.
  if (!body.ok || !body.access_token || !body.bot_user_id || !teamId || body.is_enterprise_install) {
    console.error("oauth.v2.access refused:", body.ok ? "unsupported_install" : body.error);
    return backToLanding(url.origin, "failed", secure);
  }

  await registry(env).saveInstall({
    teamId,
    teamName: body.team?.name ?? "",
    botToken: body.access_token,
    botUserId: body.bot_user_id,
    installedAt: Date.now(),
  });
  return backToLanding(url.origin, "ok", secure);
}
