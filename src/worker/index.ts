import { MAX_PLAYLIST_VIDEOS, extractPlaylistIds, extractVideoIds } from "../../shared/video";
import { WEB_ADDER, resolveSlackName } from "./names";
import { botTokenFor, registry } from "./install";
import { finishInstall, startInstall } from "./oauth";
import { isUserMessage, slackChatPost, slackEscape, slackReact, verifySlackRequest, type SlackMessage } from "./slack";
import { fetchPlaylist, fetchVideoCategories, fetchVideoMeta, isNonMusic, type Playlist, type VideoCategory } from "./youtube";
import type { EnqueueItem } from "./station";

export { StationRegistry } from "./registry";
export { Station } from "./station";

export interface Env {
  STATION_REGISTRY: DurableObjectNamespace<import("./registry").StationRegistry>;
  STATION: DurableObjectNamespace<import("./station").Station>;
  ASSETS: Fetcher;
  /** Token of the one workspace named by SLACK_TEAM_ID (installed before OAuth existed); every other workspace uses its own install. */
  SLACK_BOT_TOKEN?: string;
  SLACK_TEAM_ID?: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  /** Local testing only: replace https://slack.com/api and https://slack.com/oauth/v2/authorize and the access exchange. */
  SLACK_API_URL?: string;
  SLACK_OAUTH_URL?: string;
  /** YouTube Data API key (wrangler secret). Without it nothing is filtered: every link is let through. */
  YOUTUBE_API_KEY?: string;
  /** Local testing only: replace https://www.googleapis.com/youtube/v3. */
  YOUTUBE_API_URL?: string;
}

type SlackEventBody = {
  type: string;
  challenge?: string;
  team_id?: string;
  event_id?: string;
  authorizations?: { user_id: string }[];
  event?: SlackMessage & { user?: string; channel?: string; tokens?: { oauth?: string[]; bot?: string[] } };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

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

/** Emoji name (no colons) added to a message once at least one of its links is in the rotation. */
const ACK_REACTION = "headphones";
/** Added instead of the headphones when nothing in a message could be added because none of it is music. */
const REJECT_REACTION = "x";

async function announce(env: Env, botToken: string, origin: string, channel: string, token: string): Promise<void> {
  await slackChatPost(
    env,
    botToken,
    channel,
    `🎧 This channel is now a radio station. Post YouTube links to add songs. Tune in: ${origin}/s/${token}`,
  );
}

/** Playlist links handled per message; each is one feed request, so this also bounds subrequests. */
const MAX_PLAYLISTS = 3;

type PlaylistRead = { id: string; playlist: Playlist | null };

/** Video id -> the category it is filed under, for the videos the API said are not music. */
type NotMusic = Map<string, string>;

/**
 * One batched videos.list call for every video a request names or reads from a playlist. Playlist videos are included so a
 * playlist of lectures is turned away at add time instead of playing once from the queue.
 */
async function nonMusicIds(env: Env, ids: string[]): Promise<NotMusic> {
  const categories = await fetchVideoCategories(env, ids);
  const out: NotMusic = new Map();
  for (const [id, category] of categories) if (isNonMusic(category)) out.set(id, category.name);
  return out;
}

function splitNamed(items: EnqueueItem[], notMusic: NotMusic) {
  const keep: EnqueueItem[] = [];
  const rejected: { videoId: string; category: string }[] = [];
  for (const item of items) {
    const category = notMusic.get(item.videoId);
    if (category !== undefined) rejected.push({ videoId: item.videoId, category });
    else keep.push(item);
  }
  return { keep, rejected };
}

function readPlaylists(playlistIds: string[]): Promise<PlaylistRead[]> {
  return Promise.all(playlistIds.map(async (id) => ({ id, playlist: await fetchPlaylist(id) })));
}

/**
 * Turns feed results into library items: videos already named in the message, or by an earlier playlist, are skipped, and
 * `seq` continues after the message's own links so their order within the message stays stable. Videos the API said are not
 * music are left out and counted per playlist.
 */
function playlistItems(reads: PlaylistRead[], taken: Set<string>, seqStart: number, notMusic: NotMusic) {
  const items: EnqueueItem[] = [];
  const summaries: { id: string; title: string; added: number; truncated: boolean; notMusic: number }[] = [];
  const failed: string[] = [];
  let seq = seqStart;
  for (const { id, playlist } of reads) {
    if (!playlist || playlist.videos.length === 0) {
      failed.push(id);
      continue;
    }
    let added = 0;
    let skippedNotMusic = 0;
    for (const v of playlist.videos) {
      if (taken.has(v.videoId)) continue;
      if (notMusic.has(v.videoId)) {
        skippedNotMusic++;
        continue;
      }
      taken.add(v.videoId);
      items.push({ ...v, seq: seq++ });
      added++;
    }
    summaries.push({ id, title: playlist.title, added, truncated: playlist.videos.length >= MAX_PLAYLIST_VIDEOS, notMusic: skippedNotMusic });
  }
  return { items, summaries, failed };
}

/**
 * The playlist summaries counted what the feed offered, not what the station took. A video already in the rotation is not
 * new, so `added` is recounted from the station's own answer: a repeated playlist then reports 0, not its full length.
 */
function withNewCounts(pl: ReturnType<typeof playlistItems>, libraryAdded: string[]) {
  const fresh = new Set(libraryAdded);
  // Each playlist's items are consecutive, in summary order, so walk them in step with the summaries.
  let cursor = 0;
  return pl.summaries.map((s) => {
    // `s.added` is what the feed offered that is music and not named in the message; `added` is how many of those the station
    // did not already have.
    let added = 0;
    for (let k = 0; k < s.added; k++) if (fresh.has(pl.items[cursor + k].videoId)) added++;
    cursor += s.added;
    return { ...s, added, alreadyThere: s.added - added };
  });
}

async function handleEvent(body: SlackEventBody, origin: string, env: Env): Promise<void> {
  const event = body.event;
  const teamId = body.team_id;

  // The bot token is dead: forget it, so nothing keeps calling Slack with it. Stations stay (their links keep working for
  // listeners), and a reinstall brings a fresh token. tokens_revoked also fires when only user tokens were revoked
  // (`tokens.oauth`), which leaves the bot token working, so it counts only with a non-empty `tokens.bot`.
  const botRevoked = event?.type === "tokens_revoked" && (event.tokens?.bot?.length ?? 0) > 0;
  if (event?.type === "app_uninstalled" || botRevoked) {
    if (teamId) await registry(env).removeInstall(teamId);
    return;
  }
  if (event?.type === "tokens_revoked") return;

  const channel = event?.channel;
  if (!event || !teamId || !channel) return;
  const botToken = await botTokenFor(env, teamId);
  if (!botToken) return;

  if (event.type === "member_joined_channel") {
    if (event.user !== body.authorizations?.[0]?.user_id) return;
    const { token } = await registry(env).ensureStation(teamId, channel);
    const station = env.STATION.getByName(token);
    await station.init(teamId, channel);
    await station.rearmBackfill();
    await announce(env, botToken, origin, channel, token);
    return;
  }

  if (!isUserMessage(event) || !event.ts || !body.event_id) return;
  const text = event.text ?? "";
  const ids = extractVideoIds(text);
  const playlistIds = extractPlaylistIds(text).slice(0, MAX_PLAYLISTS);
  if (ids.length === 0 && playlistIds.length === 0) return;

  const { token, created } = await registry(env).ensureStation(teamId, channel);
  if (created) await announce(env, botToken, origin, channel, token);

  const threadTs = event.thread_ts ?? event.ts;
  const [metas, reads] = await Promise.all([Promise.all(ids.map((id) => fetchVideoMeta(id))), readPlaylists(playlistIds)]);
  const items: EnqueueItem[] = [];
  // `null` is YouTube saying the video is gone; `undefined` is YouTube not answering (timeout, 429, 5xx). The reply must not
  // call a slow lookup an unavailable video, so they are reported apart.
  const unavailable: string[] = [];
  const lookupFailed: string[] = [];
  for (const [seq, videoId] of ids.entries()) {
    const meta = metas[seq];
    if (meta) items.push({ videoId, seq, ...meta });
    else if (meta === null) unavailable.push(videoId);
    else lookupFailed.push(videoId);
  }
  const notMusic = await nonMusicIds(env, [...items.map((i) => i.videoId), ...reads.flatMap((r) => r.playlist?.videos.map((v) => v.videoId) ?? [])]);
  const split = splitNamed(items, notMusic);
  const pl = playlistItems(reads, new Set(ids), ids.length, notMusic);

  // enqueue dedupes on event_id, so a redelivered event gets neither a second reaction nor a second warning.
  const adder = { id: event.user ?? null, name: await resolveSlackName(env, teamId, event.user) };
  const { accepted, alreadyQueued, libraryAdded } = await env.STATION.getByName(token).enqueue(teamId, channel, body.event_id, event.ts, split.keep, adder, pl.items);
  if (!accepted) return;
  // Headphones only when something was actually queued. A message whose every link was already waiting or playing is
  // answered by the "already in the queue" reply below, and a headphones reaction would say it was added.
  const queuedNew = split.keep.some((i) => !alreadyQueued.includes(i.videoId)) || libraryAdded.length > 0;
  const turnedAway = split.rejected.length > 0 || pl.summaries.some((p) => p.notMusic > 0);
  // Some of the message was music and is already on the radio (a queued link, or a playlist's music videos): not a rejection.
  const alreadyThere = alreadyQueued.length > 0 || withNewCounts(pl, libraryAdded).some((p) => p.alreadyThere > 0);
  // A mixed message gets the headphones (its music is in) and a reply naming what was skipped; only a message with no
  // music at all gets the cross. A message that failed for another reason (unavailable video) gets neither, as before.
  if (queuedNew) await slackReact(env, botToken, channel, event.ts, ACK_REACTION);
  else if (turnedAway && !alreadyThere) await slackReact(env, botToken, channel, event.ts, REJECT_REACTION);
  for (const videoId of unavailable) {
    await slackChatPost(
      env,
      botToken,
      channel,
      `⚠️ Couldn't add https://youtu.be/${videoId} — video unavailable or not embeddable`,
      threadTs,
    );
  }
  for (const videoId of lookupFailed) {
    await slackChatPost(
      env,
      botToken,
      channel,
      `⏳ Couldn't reach YouTube to check https://youtu.be/${videoId}, so it wasn't added. Post it again in a minute.`,
      threadTs,
    );
  }
  for (const videoId of alreadyQueued) {
    const title = split.keep.find((i) => i.videoId === videoId)?.title;
    await slackChatPost(
      env,
      botToken,
      channel,
      `🔁 ${title ? `“${slackEscape(title)}”` : `https://youtu.be/${videoId}`} is already in the queue or playing, so it wasn't queued again`,
      threadTs,
    );
  }
  for (const r of split.rejected) {
    await slackChatPost(
      env,
      botToken,
      channel,
      `🎵 Only music goes on this radio: https://youtu.be/${r.videoId} is filed under “${slackEscape(r.category)}”, so it wasn't added`,
      threadTs,
    );
  }
  for (const p of withNewCounts(pl, libraryAdded)) {
    const cap = p.truncated ? ` (YouTube's feed lists at most ${MAX_PLAYLIST_VIDEOS} videos per playlist)` : "";
    const skipped = p.notMusic > 0 ? `, ${p.notMusic} skipped as not music` : "";
    const title = slackEscape(p.title);
    await slackChatPost(
      env,
      botToken,
      channel,
      p.added === 0 && p.alreadyThere === 0 && p.notMusic > 0
        ? `🎵 Only music goes on this radio: none of the ${p.notMusic} videos in “${title}” are music, so none were added`
        : p.added === 0
          ? `🔁 Every music video in “${title}” is already in the rotation${skipped}`
          : `🎶 ${p.added} ${p.added === 1 ? "video" : "videos"} from “${title}” in the rotation${skipped}${cap}`,
      threadTs,
    );
  }
  for (const id of pl.failed) {
    await slackChatPost(
      env,
      botToken,
      channel,
      `⚠️ Couldn't read https://www.youtube.com/playlist?list=${id} — it may be private, or an album or auto-generated playlist`,
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
    // Slack's deadline is 3 s and it retries on timeout, so ack first. Workspaces without an install are ignored in
    // handleEvent: the signature already proves the request came from Slack, and there is no token to act with.
    ctx.waitUntil(handleEvent(body, new URL(request.url).origin, env).catch((e) => console.error("handleEvent", e)));
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
  if (!(await botTokenFor(env, teamId))) {
    const origin = new URL(request.url).origin;
    return json({ response_type: "ephemeral", text: `viberadio is not installed in this workspace. Add it at ${origin}` });
  }
  const { token } = await registry(env).ensureStation(teamId, channelId);
  await env.STATION.getByName(token).init(teamId, channelId);
  return json({ response_type: "ephemeral", text: `🎧 Tune in: ${new URL(request.url).origin}/s/${token}` });
}

/** Cap per request: each link costs an oEmbed subrequest, and the Workers Free plan allows 50 per invocation. */
const MAX_WEB_ADD = 10;
/** Largest accepted body in bytes; a 10k-char text is well under this even with JSON escaping. */
const MAX_WEB_BODY = 40_000;
/** Rotation rows per page; each untitled one costs an oEmbed fetch, so this also caps subrequests per request. */
const LIBRARY_PAGE = 15;

/**
 * Adds links from the web app (the PWA share target). The station token is the capability, as for Next, so no other
 * auth. JSON content type is required: a cross-origin page can send text/plain without a CORS preflight, but cannot
 * send application/json without one, and this API sets no CORS headers.
 */
async function addFromWeb(request: Request, env: Env, token: string): Promise<Response> {
  if (!(request.headers.get("Content-Type") ?? "").includes("application/json")) return json({ error: "bad_content_type" }, 415);
  // Refused before the body is read: the length check below only runs once the whole body is already in memory.
  // A missing header (chunked upload) is refused too: Number(null) is 0 and would sail past the cap. Browsers always
  // send Content-Length for a fetch() with a string body.
  const declared = request.headers.get("Content-Length");
  if (declared === null || !/^\d+$/.test(declared)) return json({ error: "length_required" }, 411);
  if (Number(declared) > MAX_WEB_BODY) return json({ error: "too_large" }, 413);
  const info = await registry(env).lookupToken(token);
  if (!info) return json({ error: "unknown_station" }, 404);
  const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
  if (typeof body?.text !== "string" || body.text.length > 10_000) return json({ error: "bad_request" }, 400);

  const ids = extractVideoIds(body.text).slice(0, MAX_WEB_ADD);
  const playlistIds = extractPlaylistIds(body.text).slice(0, MAX_PLAYLISTS);
  if (ids.length === 0 && playlistIds.length === 0) return json({ error: "no_video_links" }, 422);

  const [metas, reads] = await Promise.all([Promise.all(ids.map((id) => fetchVideoMeta(id))), readPlaylists(playlistIds)]);
  const found: EnqueueItem[] = [];
  const unavailable: string[] = [];
  const lookupFailed: string[] = [];
  ids.forEach((videoId, seq) => {
    const meta = metas[seq];
    if (meta) found.push({ videoId, seq, ...meta });
    else if (meta === null) unavailable.push(videoId);
    else lookupFailed.push(videoId);
  });
  const notMusic = await nonMusicIds(env, [...found.map((i) => i.videoId), ...reads.flatMap((r) => r.playlist?.videos.map((v) => v.videoId) ?? [])]);
  const { keep: items, rejected } = splitNamed(found, notMusic);
  const pl = playlistItems(reads, new Set(ids), ids.length, notMusic);

  if (items.length === 0 && pl.items.length === 0) {
    // Turned away for not being music is a different answer from unplayable, so the page can say which.
    if (rejected.length > 0 || pl.summaries.some((s) => s.notMusic > 0)) {
      return json({ error: "not_music", rejected, unavailable, playlistsFailed: pl.failed }, 422);
    }
    // YouTube not answering is not "unplayable": the same link may work in a minute.
    if (lookupFailed.length > 0 && unavailable.length === 0) {
      return json({ error: "lookup_failed", unavailable, lookupFailed, playlistsFailed: pl.failed }, 503);
    }
    // A playlist that read fine but contributed nothing (every video was named in the message already) is not a failed read.
    const error = pl.summaries.length > 0 ? "nothing_new" : "none_playable";
    return json({ error, unavailable, lookupFailed, playlistsFailed: pl.failed }, 422);
  }

  // Slack ts format (fixed-width seconds + fraction) so the history ordering treats web adds like channel posts.
  const now = Date.now();
  const ts = `${Math.floor(now / 1000)}.${String(now % 1000).padStart(3, "0")}000`;
  // The share target has no identity, so it is credited to the label "web share" instead of a person.
  const adder = { id: "web", name: WEB_ADDER };
  // No event id: a 30 s content hash used to absorb a double tap, but it also swallowed a deliberate second share of the
  // same link (play it, share it again within the window: dropped). Now a video already waiting or playing is reported as
  // alreadyQueued by enqueue itself, which covers the double tap without hiding a real re-share.
  const { alreadyQueued, libraryAdded } = await env.STATION.getByName(token).enqueue(info.teamId, info.channelId, null, ts, items, adder, pl.items);
  const skipped = new Set(alreadyQueued);
  return json({
    added: items.filter((i) => !skipped.has(i.videoId)).map((i) => ({ videoId: i.videoId, title: i.title })),
    alreadyQueued: items.filter((i) => skipped.has(i.videoId)).map((i) => ({ videoId: i.videoId, title: i.title })),
    playlists: withNewCounts(pl, libraryAdded),
    playlistsFailed: pl.failed,
    unavailable,
    lookupFailed,
    rejected,
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // The landing page shows "Add to Slack" only when the server can complete an install.
    if (request.method === "GET" && pathname === "/api/config") {
      return json({ installable: Boolean(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET) });
    }
    if (request.method === "POST" && pathname === "/slack/events") return slackEvents(request, env, ctx);
    if (request.method === "POST" && pathname === "/slack/commands") return slackCommands(request, env);
    if (request.method === "GET" && pathname === "/slack/install") return startInstall(request, env);
    if (request.method === "GET" && pathname === "/slack/oauth/callback") return finishInstall(request, env);

    const add = pathname.match(/^\/api\/station\/([^/]+)\/add$/);
    if (request.method === "POST" && add) return addFromWeb(request, env, add[1]);

    const lib = pathname.match(/^\/api\/station\/([^/]+)\/library$/);
    if (request.method === "GET" && lib) {
      const info = await registry(env).lookupToken(lib[1]);
      if (!info) return json({ error: "unknown_station" }, 404);
      // Clamped, not rejected: the page size bounds the oEmbed subrequests a listing can trigger.
      const offset = Math.max(0, Math.min(100_000, Math.floor(Number(url.searchParams.get("offset"))) || 0));
      const limit = Math.max(1, Math.min(LIBRARY_PAGE, Math.floor(Number(url.searchParams.get("limit"))) || LIBRARY_PAGE));
      const station = env.STATION.getByName(lib[1]);
      await station.init(info.teamId, info.channelId);
      return json(await station.library(offset, limit));
    }

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
