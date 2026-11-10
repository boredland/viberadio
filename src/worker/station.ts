import { DurableObject } from "cloudflare:workers";
import type { ClientMessage, CurrentTrack, ServerMessage, StateMessage, Track } from "../../shared/protocol";
import type { Env } from "./index";
import { extractVideoIds } from "../../shared/video";
import { isUserMessage, slackApi, type SlackMessage } from "./slack";
import { fetchVideoMeta } from "./youtube";

type StationState = {
  teamId: string;
  channelId: string;
  current: CurrentTrack | null;
  /** Set iff the clock is frozen (no listeners). */
  pausedAtMs: number | null;
  /** Fresh posts, FIFO. */
  queue: Track[];
  /** Last history row played. */
  rotationCursor: { ts: string; seq: number } | null;
  backfill: { cursor: string | null; done: boolean; error: string | null };
  /** Ring buffer, cap SEEN_CAP. */
  seenEventIds: string[];
};

type LibraryRow = {
  video_id: string;
  first_ts: string;
  seq: number;
  title: string | null;
  author: string | null;
  thumbnail_url: string | null;
  dead: number;
};

export type EnqueueItem = {
  videoId: string;
  seq: number;
  title: string;
  author: string;
  thumbnailUrl: string;
};

const SEEN_CAP = 500;
/** Workers Free allows 50 subrequests per invocation; stay well under. */
const MAX_ROWS_EXAMINED = 20;
const BACKFILL_PAGE_DELAY_MS = 1500;
const BACKFILL_DEFAULT_RETRY_S = 60;
const FATAL_PLAYER_ERRORS = new Set([100, 101, 150]);

export class Station extends DurableObject<Env> {
  private state: StationState | null = null;
  private advanceLock: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS library(
        video_id TEXT PRIMARY KEY,
        first_ts TEXT NOT NULL,
        seq INTEGER NOT NULL,
        title TEXT, author TEXT, thumbnail_url TEXT,
        dead INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS library_order ON library(first_ts, seq);
    `);
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get<StationState>("state")) ?? null;
    });
  }

  // ---- RPC ----------------------------------------------------------------

  async init(teamId: string, channelId: string): Promise<void> {
    if (this.state) return;
    this.state = {
      teamId,
      channelId,
      current: null,
      pausedAtMs: null,
      queue: [],
      rotationCursor: null,
      backfill: { cursor: null, done: false, error: null },
      seenEventIds: [],
    };
    await this.persist();
    await this.ctx.storage.setAlarm(Date.now());
  }

  /**
   * Backfill failures are terminal (`not_in_channel`, `invalid_auth` never fix themselves), so a station created before
   * the bot could read the channel stays empty. The bot joining is the moment that changes, so retry then.
   */
  async rearmBackfill(): Promise<void> {
    const s = this.state;
    if (!s || s.backfill.error === null) return;
    s.backfill = { cursor: null, done: false, error: null };
    await this.persist();
    await this.ctx.storage.setAlarm(Date.now());
    this.broadcast();
  }

  async enqueue(
    teamId: string,
    channelId: string,
    eventId: string,
    messageTs: string,
    items: EnqueueItem[],
  ): Promise<{ accepted: boolean }> {
    await this.init(teamId, channelId);
    const s = this.st();
    if (s.seenEventIds.includes(eventId)) return { accepted: false };
    s.seenEventIds.push(eventId);
    if (s.seenEventIds.length > SEEN_CAP) s.seenEventIds.splice(0, s.seenEventIds.length - SEEN_CAP);

    for (const it of items) {
      s.queue.push({
        id: `${Date.now()}-${it.videoId}`,
        videoId: it.videoId,
        title: it.title,
        author: it.author,
        thumbnailUrl: it.thumbnailUrl,
        source: "queue",
      });
      // Keeps the original first_ts; re-posting a link revives a dead row.
      this.ctx.storage.sql.exec(
        `INSERT INTO library(video_id, first_ts, seq, title, author, thumbnail_url, dead) VALUES (?,?,?,?,?,?,0)
         ON CONFLICT(video_id) DO UPDATE SET title=excluded.title, author=excluded.author, thumbnail_url=excluded.thumbnail_url, dead=0`,
        it.videoId,
        messageTs,
        it.seq,
        it.title,
        it.author,
        it.thumbnailUrl,
      );
    }
    await this.persist();
    await this.maybeStart();
    this.broadcast();
    return { accepted: true };
  }

  snapshot(exclude?: WebSocket): StateMessage {
    const s = this.st();
    const sockets = this.ctx.getWebSockets().filter((w) => w !== exclude);
    return {
      type: "state",
      serverNow: Date.now(),
      now: s.current,
      queue: s.queue,
      listeners: sockets.length,
      librarySize: this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM library WHERE dead=0").one().n,
      indexing: !s.backfill.done,
    };
  }

  // ---- WebSocket ----------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    await this.unfreeze();
    await this.maybeStart();
    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string" || !this.state) return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    switch (msg?.type) {
      case "ping":
        ws.send(JSON.stringify({ type: "pong", t0: msg.t0, serverNow: Date.now() } satisfies ServerMessage));
        return;
      case "next":
        await this.advance(null);
        return;
      case "ended":
        await this.advance(msg.id);
        return;
      case "error": {
        const cur = this.state.current;
        if (cur && cur.id === msg.id && FATAL_PLAYER_ERRORS.has(msg.code)) {
          this.ctx.storage.sql.exec("UPDATE library SET dead=1 WHERE video_id=?", cur.videoId);
        }
        await this.advance(msg.id);
        return;
      }
      case "remove":
        if (typeof msg.id === "string") await this.remove(msg.id);
        return;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.freeze(ws);
    this.broadcast(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  // ---- Transitions --------------------------------------------------------

  private async maybeStart(): Promise<void> {
    const s = this.st();
    if (s.current === null && this.ctx.getWebSockets().length > 0) await this.start(null);
  }

  /** Every caller shares one in-flight advance, so two listeners reporting the same ending cannot double-advance. */
  private start(prevVideoId: string | null): Promise<void> {
    if (this.advanceLock) return this.advanceLock;
    const run = this.doStart(prevVideoId).finally(() => {
      this.advanceLock = null;
    });
    this.advanceLock = run;
    return run;
  }

  private async doStart(prevVideoId: string | null): Promise<void> {
    const s = this.st();
    s.current = null;
    await this.persist();
    let track: Track | null;
    // A post arriving while pickNext awaits a fetch lands in the queue after the pick returned null.
    do {
      track = await this.pickNext(prevVideoId);
    } while (!track && s.queue.length > 0);
    const now = Date.now();
    s.current = track ? { ...track, startedAtMs: now } : null;
    s.pausedAtMs = track && this.ctx.getWebSockets().length === 0 ? now : null;
    await this.persist();
    this.broadcast();
  }

  private async advance(trackId: string | null): Promise<void> {
    const cur = this.st().current;
    if (this.advanceLock) return this.advanceLock;
    if (!cur || (trackId !== null && cur.id !== trackId)) return;
    await this.start(cur.videoId);
  }

  /**
   * Removes a track everywhere it would play from. The library row is marked dead (not deleted) so history rotation
   * skips it, the backfill upsert cannot resurrect it, and re-posting the link revives it, like an unplayable video.
   * Every queued copy goes too: the intent is "this video should not be on the radio", not "this one slot".
   * Web-add event ids are forgotten as well: they dedupe by content for 30 s, which would otherwise swallow a re-add made
   * right after fixing a mistake. Slack event ids stay, since a re-post is a new event and redelivery must still dedupe.
   */
  private async remove(id: string): Promise<void> {
    const s = this.st();
    const target = s.current?.id === id ? s.current : s.queue.find((t) => t.id === id);
    if (!target) return;
    this.ctx.storage.sql.exec("UPDATE library SET dead=1 WHERE video_id=?", target.videoId);
    s.queue = s.queue.filter((t) => t.videoId !== target.videoId);
    s.seenEventIds = s.seenEventIds.filter((e) => !e.startsWith("web-"));
    await this.persist();
    // By video, not slot: removing a queued copy of what is playing right now must stop it too.
    if (s.current?.videoId === target.videoId) await this.advance(s.current.id);
    else this.broadcast();
  }

  private async unfreeze(): Promise<void> {
    const s = this.st();
    if (s.pausedAtMs !== null && s.current) {
      s.current.startedAtMs += Date.now() - s.pausedAtMs;
      s.pausedAtMs = null;
      await this.persist();
    }
  }

  private async freeze(closing: WebSocket): Promise<void> {
    const s = this.st();
    if (this.ctx.getWebSockets().filter((w) => w !== closing).length === 0 && s.current && s.pausedAtMs === null) {
      s.pausedAtMs = Date.now();
      await this.persist();
    }
  }

  private async pickNext(prevVideoId: string | null): Promise<Track | null> {
    const s = this.st();
    const queued = s.queue.shift();
    if (queued) return queued;
    if (!s.backfill.done) return null;

    const sql = this.ctx.storage.sql;
    let cursor = s.rotationCursor;
    let skippedPrev = false;
    for (let examined = 0; examined < MAX_ROWS_EXAMINED; examined++) {
      let row: LibraryRow | undefined = cursor
        ? sql
            .exec<LibraryRow>(
              `SELECT * FROM library WHERE dead=0 AND (first_ts > ?1 OR (first_ts = ?1 AND seq > ?2)) ORDER BY first_ts, seq LIMIT 1`,
              cursor.ts,
              cursor.seq,
            )
            .toArray()[0]
        : undefined;
      row ??= sql.exec<LibraryRow>("SELECT * FROM library WHERE dead=0 ORDER BY first_ts, seq LIMIT 1").toArray()[0];
      if (!row) return null;
      cursor = { ts: row.first_ts, seq: row.seq };

      if (row.video_id === prevVideoId && !skippedPrev) {
        const alive = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM library WHERE dead=0").one().n;
        if (alive > 1) {
          skippedPrev = true;
          continue;
        }
      }

      let { title, author, thumbnail_url: thumbnailUrl } = row;
      if (title === null) {
        const meta = await fetchVideoMeta(row.video_id);
        if (!meta) {
          sql.exec("UPDATE library SET dead=1 WHERE video_id=?", row.video_id);
          continue;
        }
        ({ title, author, thumbnailUrl } = meta);
        sql.exec(
          "UPDATE library SET title=?, author=?, thumbnail_url=? WHERE video_id=?",
          title,
          author,
          thumbnailUrl,
          row.video_id,
        );
      }
      s.rotationCursor = cursor;
      return {
        id: `${Date.now()}-${row.video_id}`,
        videoId: row.video_id,
        title: title ?? "",
        author: author ?? "",
        thumbnailUrl: thumbnailUrl ?? "",
        source: "history",
      };
    }
    // Keep the position so the next call continues past the rows just examined.
    s.rotationCursor = cursor;
    return null;
  }

  // ---- Backfill -----------------------------------------------------------

  async alarm(): Promise<void> {
    const s = this.state;
    if (!s || s.backfill.done) return;

    const res = await slackApi("conversations.history", this.env.SLACK_BOT_TOKEN, {
      channel: s.channelId,
      limit: "200",
      ...(s.backfill.cursor ? { cursor: s.backfill.cursor } : {}),
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get("Retry-After")) || BACKFILL_DEFAULT_RETRY_S;
      await this.ctx.storage.setAlarm(Date.now() + wait * 1000);
      return;
    }
    const body = (await res.json()) as {
      ok: boolean;
      error?: string;
      messages?: SlackMessage[];
      has_more?: boolean;
      response_metadata?: { next_cursor?: string };
    };
    if (!body.ok) {
      // not_in_channel / missing_scope do not fix themselves; live links still work.
      console.error("conversations.history failed:", body.error);
      s.backfill = { cursor: null, done: true, error: body.error ?? "unknown_error" };
    } else {
      for (const m of body.messages ?? []) {
        if (!isUserMessage(m) || !m.ts) continue;
        extractVideoIds(m.text ?? "").forEach((videoId, seq) => {
          this.ctx.storage.sql.exec(
            `INSERT INTO library(video_id, first_ts, seq) VALUES (?,?,?)
             ON CONFLICT(video_id) DO UPDATE SET first_ts=excluded.first_ts, seq=excluded.seq WHERE excluded.first_ts < library.first_ts`,
            videoId,
            m.ts,
            seq,
          );
        });
      }
      const next = body.response_metadata?.next_cursor;
      if (body.has_more && next) {
        s.backfill.cursor = next;
        await this.ctx.storage.setAlarm(Date.now() + BACKFILL_PAGE_DELAY_MS);
      } else {
        s.backfill = { cursor: null, done: true, error: null };
      }
    }
    await this.persist();
    await this.maybeStart();
    this.broadcast();
  }

  // ---- Helpers ------------------------------------------------------------

  private st(): StationState {
    if (!this.state) throw new Error("station not initialised");
    return this.state;
  }

  private persist(): Promise<void> {
    return this.ctx.storage.put("state", this.state);
  }

  private broadcast(exclude?: WebSocket): void {
    const payload = JSON.stringify(this.snapshot(exclude));
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      try {
        ws.send(payload);
      } catch {
        // socket already closing; its close handler will rebroadcast
      }
    }
  }
}
