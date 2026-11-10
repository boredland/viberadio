import { extractVideoIds, isUserMessage, slackChatPost, verifySlackRequest, type SlackMessage } from "./slack";
import { fetchVideoMeta } from "./youtube";
import type { EnqueueItem } from "./station";

export { StationRegistry } from "./registry";
export { Station } from "./station";

export interface Env {
  STATION_REGISTRY: DurableObjectNamespace<import("./registry").StationRegistry>;
  STATION: DurableObjectNamespace<import("./station").Station>;
  ASSETS: Fetcher;
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_TEAM_ID?: string;
}

type SlackEventBody = {
  type: string;
  challenge?: string;
  team_id?: string;
  event_id?: string;
  authorizations?: { user_id: string }[];
  event?: SlackMessage & { user?: string; channel?: string };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const registry = (env: Env) => env.STATION_REGISTRY.getByName("registry");

async function readVerified(request: Request, env: Env): Promise<string | null> {
  const raw = await request.text();
  const ok = await verifySlackRequest(
    raw,
    request.headers.get("X-Slack-Request-Timestamp"),
    request.headers.get("X-Slack-Signature"),
    env.SLACK_SIGNING_SECRET,
  );
  return ok ? raw : null;
}

async function announce(env: Env, origin: string, channel: string, token: string): Promise<void> {
  await slackChatPost(
    env,
    channel,
    `🎧 This channel is now a radio station. Post YouTube links to add songs. Tune in: ${origin}/s/${token}`,
  );
}

async function handleEvent(body: SlackEventBody, origin: string, env: Env): Promise<void> {
  const event = body.event;
  const teamId = body.team_id;
  const channel = event?.channel;
  if (!event || !teamId || !channel) return;

  if (event.type === "member_joined_channel") {
    if (event.user !== body.authorizations?.[0]?.user_id) return;
    const { token } = await registry(env).ensureStation(teamId, channel);
    await env.STATION.getByName(token).init(teamId, channel);
    await announce(env, origin, channel, token);
    return;
  }

  if (!isUserMessage(event) || !event.ts || !body.event_id) return;
  const ids = extractVideoIds(event.text ?? "");
  if (ids.length === 0) return;

  const { token, created } = await registry(env).ensureStation(teamId, channel);
  if (created) await announce(env, origin, channel, token);

  const threadTs = event.thread_ts ?? event.ts;
  const metas = await Promise.all(ids.map((id) => fetchVideoMeta(id)));
  const items: EnqueueItem[] = [];
  for (const [seq, videoId] of ids.entries()) {
    const meta = metas[seq];
    if (!meta) {
      await slackChatPost(
        env,
        channel,
        `⚠️ Couldn't add https://youtu.be/${videoId} — video unavailable or not embeddable`,
        threadTs,
      );
      continue;
    }
    items.push({ videoId, seq, ...meta });
  }

  const { accepted } = await env.STATION.getByName(token).enqueue(teamId, channel, body.event_id, event.ts, items);
  if (accepted && items.length > 0) {
    await slackChatPost(
      env,
      channel,
      items.map((i) => `▶️ Added to rotation: *${i.title}*`).join("\n"),
      threadTs,
    );
  }
}

async function slackEvents(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const raw = await readVerified(request, env);
  if (raw === null) return new Response("invalid signature", { status: 401 });
  const body = JSON.parse(raw) as SlackEventBody;
  if (body.type === "url_verification") return json({ challenge: body.challenge });
  if (body.type === "event_callback") {
    if (!env.SLACK_TEAM_ID || env.SLACK_TEAM_ID === body.team_id) {
      // Slack's deadline is 3 s and it retries on timeout, so ack first.
      ctx.waitUntil(handleEvent(body, new URL(request.url).origin, env).catch((e) => console.error("handleEvent", e)));
    }
  }
  return new Response(null, { status: 200 });
}

async function slackCommands(request: Request, env: Env): Promise<Response> {
  const raw = await readVerified(request, env);
  if (raw === null) return new Response("invalid signature", { status: 401 });
  const form = new URLSearchParams(raw);
  const teamId = form.get("team_id");
  const channelId = form.get("channel_id");
  if (!teamId || !channelId) return new Response("bad request", { status: 400 });
  if (env.SLACK_TEAM_ID && env.SLACK_TEAM_ID !== teamId) return new Response("forbidden", { status: 403 });
  const { token } = await registry(env).ensureStation(teamId, channelId);
  await env.STATION.getByName(token).init(teamId, channelId);
  return json({ response_type: "ephemeral", text: `🎧 Tune in: ${new URL(request.url).origin}/s/${token}` });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "POST" && pathname === "/slack/events") return slackEvents(request, env, ctx);
    if (request.method === "POST" && pathname === "/slack/commands") return slackCommands(request, env);

    if (request.method === "GET" && pathname.startsWith("/api/station/")) {
      const token = pathname.slice("/api/station/".length);
      const info = await registry(env).lookupToken(token);
      if (!info) return json({ error: "unknown_station" }, 404);
      const station = env.STATION.getByName(token);
      await station.init(info.teamId, info.channelId);
      return json(await station.snapshot());
    }

    if (pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
      const token = url.searchParams.get("token") ?? "";
      const info = await registry(env).lookupToken(token);
      if (!info) return json({ error: "unknown_station" }, 404);
      const stub = env.STATION.getByName(token);
      await stub.init(info.teamId, info.channelId);
      return stub.fetch(request);
    }

    if (pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
