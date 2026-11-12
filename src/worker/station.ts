import { DurableObject } from "cloudflare:workers";
import type { ClientMessage, CurrentTrack, LibraryPage, ServerMessage, StateMessage, Track } from "../../shared/protocol";
import type { Env } from "./index";
import { extractVideoIds } from "../../shared/video";
import { botTokenFor } from "./install";
import { WEB_ADDER, resolveSlackName } from "./names";
import { isUserMessage, slackApi, type SlackMessage } from "./slack";
import { fetchVideoMeta, isNonMusic, lookupVideoCategories, type VideoCategory } from "./youtube";

type StationState = {
  teamId: string;
  channelId: string;
  current: CurrentTrack | null;
  /** Set iff the clock is frozen (no listeners). */
  pausedAtMs: number | null;
  /** Fresh posts, FIFO. */
  queue: Track[];
  /** Shuffle-bag generation: a history track is eligible while its `played_cycle` is below this. Absent = 1 (stations from before shuffling). */
  rotationCycle?: number;
  backfill: { cursor: string | null; done: boolean; error: string | null; failures?: number };
  /** One-off pass that fills in posters on rows indexed before attribution existed; absent when not running. */
  refill?: { cursor: string | null; failures?: number };
  /** Set once the pass has finished (or was never owed: the station was created after attribution existed). */
  attributionDone?: boolean;
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
  /** Slack user id of the poster, "web" for the share target, null when unknown (indexed before attribution). */
  added_by_id: string | null;
  /** Resolved display name, cached so a name is looked up once per person, not once per play. */
  added_by: string | null;
  /** 1 = music, 0 = turned away as not music, 2 = YouTube answered but gave no category (final, plays), null = not checked or not answered. */
  music: number | null;
};

export type EnqueueItem = {
  videoId: string;
  seq: number;
  title: string;
  author: string;
  thumbnailUrl: string;
};

/** Who posted: the Slack user id (null for the share target) and their display name when it could be resolved. */
export type Adder = { id: string | null; name: string | null };

const SEEN_CAP = 500;
/** Workers Free allows 50 subrequests per invocation; stay well under. */
const MAX_ROWS_EXAMINED = 20;
/** One videos.list call checks up to this many unchecked rows at once: 1 subrequest and 1 quota unit however many. */
const CATEGORY_BATCH_ROWS = 50;
/** When a batch is refused as a bad request, at most this many ids are asked one at a time to find the bad one. */
const MAX_SPLIT_LOOKUPS = 12;
/** Batched calls one track pick may spend. They share the 50-subrequest budget with the title and name lookups. */
const MAX_CATEGORY_CALLS_PER_PICK = 3;
/** After a call YouTube did not answer, unchecked rows play without a lookup for this long: one outage costs one timeout. */
const CATEGORY_RETRY_MS = 60_000;
const BACKFILL_PAGE_DELAY_MS = 1500;
const BACKFILL_DEFAULT_RETRY_S = 60;
/** Slack errors that retrying cannot fix. */
const PERMANENT_HISTORY_ERRORS = new Set([
  "not_in_channel",
  "channel_not_found",
  "missing_scope",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "is_archived",
]);
/** Failed history pages (error answers, non-JSON bodies, thrown reads) tolerated in a row before a pass gives up. */
const MAX_HISTORY_FAILURES = 8;
const FATAL_PLAYER_ERRORS = new Set([100, 101, 150]);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
// Short: fetchVideoMeta returns a falsy value for a removed video and for a failed lookup alike, so a transient error must not hide a title for long.
const TITLE_MISS_TTL_MS = 2 * 60_000;

export class Station extends DurableObject<Env> {
  private state: StationState | null = null;
  /** video id -> epoch ms until which a failed title lookup is not retried; in memory, so a restart simply retries. */
  private titleMisses = new Map<string, number>();
  private advanceLock: Promise<void> | null = null;
  /** Epoch ms before which category lookups are not tried (see CATEGORY_RETRY_MS); in memory, so a restart simply retries. */
  private categoryDownUntil = 0;

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
    // Attribution columns arrived after the table did, so existing stations need them added. SQLite has no
    // ADD COLUMN IF NOT EXISTS, hence the pragma check.
    const cols = ctx.storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('library')").toArray();
    if (!cols.some((c) => c.name === "added_by_id")) {
      ctx.storage.sql.exec("ALTER TABLE library ADD COLUMN added_by_id TEXT");
      ctx.storage.sql.exec("ALTER TABLE library ADD COLUMN added_by TEXT");
    }
    // Shuffle bag: the cycle in which a track last played. New rows default to 0, so a fresh post is always in the current bag.
    if (!cols.some((c) => c.name === "played_cycle")) {
      ctx.storage.sql.exec("ALTER TABLE library ADD COLUMN played_cycle INTEGER NOT NULL DEFAULT 0");
    }
    // Whether the video is music, learned the first time it comes up in the shuffle (playlist and backfilled videos were
    // never checked when they were added). NULL means unknown, which the shuffle treats as playable.
    if (!cols.some((c) => c.name === "music")) {
      ctx.storage.sql.exec("ALTER TABLE library ADD COLUMN music INTEGER");
    }
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get<StationState>("state")) ?? null;
      const s = this.state;
      // A station that already finished indexing re-reads the channel once to learn who posted each link. `refill` is
      // separate from `backfill` because `backfill.done` gates history rotation, and a complete station must keep playing
      // while it runs. The trigger is the persisted `attributionDone` flag, not the ALTER above: if the process died
      // between the ALTER and this write, the column would already exist on the next start and the pass would be lost.
      if (s && s.backfill.done && !s.backfill.error && !s.attributionDone && !s.refill) {
        s.refill = { cursor: null };
        await ctx.storage.put("state", s);
        await ctx.storage.setAlarm(Date.now());
      } else if (s?.refill && (await ctx.storage.getAlarm()) === null) {
        // An unfinished pass with no alarm pending is resumed. If one is pending (a 429 wait, a retry) it is left alone:
        // overwriting it with "now" on every wake-up would ignore Slack's Retry-After.
        await ctx.storage.setAlarm(Date.now());
      }
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
    /** Slack event id, for redelivery dedupe. Null skips it: web adds dedupe by queue state (alreadyQueued) instead. */
    eventId: string | null,
    messageTs: string,
    items: EnqueueItem[],
    adder: Adder = { id: null, name: null },
    /** Playlist videos: they join the shuffle without being queued. */
    libraryItems: EnqueueItem[] = [],
  ): Promise<{ accepted: boolean; alreadyQueued: string[]; libraryAdded: string[] }> {
    await this.init(teamId, channelId);
    const s = this.st();
    if (eventId !== null) {
      if (s.seenEventIds.includes(eventId)) return { accepted: false, alreadyQueued: [], libraryAdded: [] };
      s.seenEventIds.push(eventId);
      if (s.seenEventIds.length > SEEN_CAP) s.seenEventIds.splice(0, s.seenEventIds.length - SEEN_CAP);
    }

    const alreadyQueued: string[] = [];
    for (const it of items) {
      // The library already holds one row per video, but the queue used to take a slot per post, so the same link showed
      // up twice and (removal being by video) vanished twice. A video already waiting or playing is not queued again.
      // It still goes through upsertLibrary, which revives a removed row and leaves the original poster alone.
      if (s.current?.videoId === it.videoId || s.queue.some((q) => q.videoId === it.videoId)) {
        alreadyQueued.push(it.videoId);
      } else {
        s.queue.push({
          id: `${Date.now()}-${it.videoId}`,
          videoId: it.videoId,
          title: it.title,
          author: it.author,
          thumbnailUrl: it.thumbnailUrl,
          source: "queue",
          addedBy: adder.name,
        });
      }
      this.upsertLibrary(it, messageTs, adder);
    }
    // A playlist video already in the rotation (and not removed) is not new: report only the ones that are, so a repeated
    // playlist is not announced as added again.
    const libraryAdded: string[] = [];
    for (const it of libraryItems) {
      const had = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM library WHERE video_id=? AND dead=0", it.videoId).one().n > 0;
      this.upsertLibrary(it, messageTs, adder);
      if (!had) libraryAdded.push(it.videoId);
    }
    await this.persist();
    await this.maybeStart();
    this.broadcast();
    return { accepted: true, alreadyQueued, libraryAdded };
  }

  /**
   * Keeps the original first_ts. Credit rule, the same as the backfill's: whoever first posted a link added it, so a
   * re-post of a live video leaves the poster alone (otherwise the credit would depend on whether the backfill had
   * already reached the original post). Reviving a removed video is the exception: that person brought it back.
   * `played_cycle` is left alone, so a re-post neither resets nor skips a track's turn in the shuffle.
   */
  private upsertLibrary(it: EnqueueItem, messageTs: string, adder: Adder): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO library(video_id, first_ts, seq, title, author, thumbnail_url, dead, added_by_id, added_by) VALUES (?,?,?,?,?,?,0,?,?)
       ON CONFLICT(video_id) DO UPDATE SET title=excluded.title, author=excluded.author, thumbnail_url=excluded.thumbnail_url,
         added_by_id=CASE WHEN library.dead=1 AND excluded.added_by_id IS NOT NULL THEN excluded.added_by_id
                          WHEN library.added_by_id IS NULL THEN excluded.added_by_id ELSE library.added_by_id END,
         added_by=CASE WHEN library.dead=1 AND excluded.added_by_id IS NOT NULL THEN excluded.added_by
                       WHEN library.added_by_id IS NULL THEN excluded.added_by ELSE library.added_by END,
         dead=0`,
      it.videoId,
      messageTs,
      it.seq,
      it.title,
      it.author,
      it.thumbnailUrl,
      adder.id,
      adder.name,
    );
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
      case "removeVideo":
        if (typeof msg.videoId === "string" && VIDEO_ID.test(msg.videoId)) await this.removeVideo(msg.videoId);
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
   * Re-adding the video afterwards works like any add: nothing remembers the removal except the library row.
   */
  private async remove(id: string): Promise<void> {
    const s = this.st();
    const target = s.current?.id === id ? s.current : s.queue.find((t) => t.id === id);
    if (target) await this.removeVideo(target.videoId);
  }

  /** Entry point for a video that may exist only in the rotation (already played, not queued, not current). */
  private async removeVideo(videoId: string): Promise<void> {
    const s = this.st();
    const inLibrary =
      this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM library WHERE video_id=? AND dead=0", videoId).one().n > 0;
    const queued = s.queue.some((t) => t.videoId === videoId);
    if (!inLibrary && !queued && s.current?.videoId !== videoId) return;
    this.ctx.storage.sql.exec("UPDATE library SET dead=1 WHERE video_id=?", videoId);
    s.queue = s.queue.filter((t) => t.videoId !== videoId);
    await this.persist();
    // By video, not slot: removing a queued copy of what is playing right now must stop it too.
    if (s.current?.videoId === videoId) await this.advance(s.current.id);
    else this.broadcast();
  }

  /**
   * One page of the rotation, newest post first (a mistake is usually recent). Backfilled rows have no title until
   * they are first played, so missing ones are resolved here, a page at a time: each costs one oEmbed subrequest and the
   * page size keeps that well under the 50-per-invocation limit. A failed lookup leaves the row untitled rather than
   * marking it dead: listing must not have side effects a flaky network could trigger. It is remembered for a while,
   * though, so reopening the list does not re-fetch the same unavailable videos on every request.
   */
  async library(offset: number, limit: number): Promise<LibraryPage> {
    const sql = this.ctx.storage.sql;
    const total = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM library WHERE dead=0").one().n;
    const page = sql
      .exec<LibraryRow>("SELECT * FROM library WHERE dead=0 ORDER BY first_ts DESC, seq DESC LIMIT ? OFFSET ?", limit, offset)
      .toArray();
    const now = Date.now();
    // Expired entries are dropped here so the map cannot outgrow the set of currently unavailable videos.
    if (this.titleMisses.size > 100) for (const [id, until] of this.titleMisses) if (until < now) this.titleMisses.delete(id);
    const missing = page.filter((r) => r.title === null && (this.titleMisses.get(r.video_id) ?? 0) < now);
    const metas = await Promise.all(missing.map((r) => fetchVideoMeta(r.video_id)));
    missing.forEach((r, i) => {
      const m = metas[i];
      if (!m) {
        this.titleMisses.set(r.video_id, now + TITLE_MISS_TTL_MS);
        return;
      }
      r.title = m.title;
      r.author = m.author;
      // `dead=0` guard: a removal during the lookups above must not be touched by a late title write.
      sql.exec("UPDATE library SET title=?, author=?, thumbnail_url=? WHERE video_id=? AND dead=0", m.title, m.author, m.thumbnailUrl, r.video_id);
    });
    await this.fillNames(page);
    return {
      total,
      offset,
      rows: page.map((r) => ({ videoId: r.video_id, title: r.title, author: r.author, addedBy: r.added_by })),
    };
  }

  /**
   * Names are looked up lazily and stored on the row, so a poster costs one Slack call ever, not one per play or listing.
   * `WEB_ADDER` rows carry the label directly. A row whose lookup fails keeps a null name and is retried by the name
   * cache's short miss TTL, not on every request.
   */
  private async adderName(videoId: string, id: string | null, name: string | null): Promise<string | null> {
    if (name || !id) return name;
    if (id === "web") return WEB_ADDER;
    const resolved = await resolveSlackName(this.env, this.st().teamId, id);
    // Same binding as fillNames: only write the name if the row still belongs to the poster it was resolved for.
    if (resolved) {
      this.ctx.storage.sql.exec(
        "UPDATE library SET added_by=? WHERE video_id=? AND added_by IS NULL AND added_by_id=?",
        resolved,
        videoId,
        id,
      );
    }
    return resolved;
  }

  /** Resolves missing names for a page of rows, one lookup per distinct poster. */
  private async fillNames(rows: LibraryRow[]): Promise<void> {
    const need = [...new Set(rows.filter((r) => !r.added_by && r.added_by_id && r.added_by_id !== "web").map((r) => r.added_by_id!))];
    const names = await Promise.all(need.map((id) => resolveSlackName(this.env, this.st().teamId, id)));
    const byId = new Map(need.map((id, i) => [id, names[i]]));
    for (const r of rows) {
      if (r.added_by || !r.added_by_id) continue;
      const n = r.added_by_id === "web" ? WEB_ADDER : (byId.get(r.added_by_id) ?? null);
      if (!n) continue;
      r.added_by = n;
      // Bound to the id the name was resolved for: the lookup above awaited Slack, and a backfill page arriving meanwhile can
      // reassign this row to an earlier poster, whose name this write would otherwise overwrite wrongly.
      this.ctx.storage.sql.exec(
        "UPDATE library SET added_by=? WHERE video_id=? AND added_by IS NULL AND added_by_id=?",
        n,
        r.video_id,
        r.added_by_id,
      );
    }
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
    if (queued) {
      // A fresh post that plays from the queue counts as played this cycle, or it would come round again straight away.
      this.ctx.storage.sql.exec("UPDATE library SET played_cycle=? WHERE video_id=?", s.rotationCycle ?? 1, queued.videoId);
      return queued;
    }
    if (!s.backfill.done) return null;

    const sql = this.ctx.storage.sql;
    let cycle = s.rotationCycle ?? 1;
    // Random pick among tracks not yet played this cycle. The previous track is excluded so a cycle boundary cannot repeat it.
    const draw = (exclude: string): LibraryRow | undefined =>
      sql
        .exec<LibraryRow>(
          "SELECT * FROM library WHERE dead=0 AND played_cycle < ?1 AND video_id != ?2 ORDER BY RANDOM() LIMIT 1",
          cycle,
          exclude,
        )
        .toArray()[0];
    // The music filter exists only with an API key. Subrequests per pick: up to MAX_ROWS_EXAMINED title lookups, up to
    // MAX_CATEGORY_CALLS_PER_PICK category calls and one name lookup, 31 at the most, under the 50 Workers Free allows.
    // Past the call cap an unchecked row simply plays: the filter fails open, it never silences the station.
    const filterOn = Boolean(this.env.YOUTUBE_API_KEY);
    let categoryCalls = 0;
    for (let examined = 0; examined < MAX_ROWS_EXAMINED; examined++) {
      let row = draw(prevVideoId ?? "");
      if (!row) {
        // Bag empty: everything has played, so start a new cycle. With a single track left alive it is the only choice.
        cycle++;
        s.rotationCycle = cycle;
        row = draw(prevVideoId ?? "") ?? draw("");
      }
      if (!row) return null;

      let { title, author, thumbnail_url: thumbnailUrl } = row;
      if (title === null) {
        const meta = await fetchVideoMeta(row.video_id);
        if (meta === null) {
          // `AND title IS NULL`: a re-post during the lookup revived the row and may have titled it; do not kill that.
          sql.exec("UPDATE library SET dead=1 WHERE video_id=? AND title IS NULL", row.video_id);
          continue;
        }
        if (meta) {
          ({ title, author, thumbnailUrl } = meta);
          sql.exec(
            "UPDATE library SET title=?, author=?, thumbnail_url=? WHERE video_id=?",
            title,
            author,
            thumbnailUrl,
            row.video_id,
          );
        }
        // `undefined`: YouTube did not answer (timeout, 429, 5xx). That says nothing about the video, so the row plays
        // untitled and is titled on a later pass, rather than being retired for a slow lookup.
      }
      if (row.music === 0) {
        sql.exec("UPDATE library SET dead=1 WHERE video_id=?", row.video_id);
        continue;
      }
      if (row.music === null && filterOn && categoryCalls < MAX_CATEGORY_CALLS_PER_PICK && Date.now() >= this.categoryDownUntil) {
        categoryCalls++;
        await this.checkCategories(row.video_id);
        // Non-music is retired by the check, and a removal during the await also lands here. A call YouTube did not answer
        // leaves the row unchecked and alive: the filter fails open, and lookups pause (categoryDownUntil).
        const stillThere = sql.exec<{ dead: number }>("SELECT dead FROM library WHERE video_id=?", row.video_id).toArray()[0];
        if (!stillThere || stillThere.dead === 1) continue;
      }
      // Every await above (the title lookup, the name lookup) lets other events run, and `current` is null while an advance
      // is in flight, so a removal in that window had nothing else to stop: it marks the row dead and this track would
      // still play. So the name is resolved first and aliveness is checked last, with no await between that check and the
      // return. (This used to run only after a title lookup, which missed the name lookup entirely.)
      const addedBy = await this.adderName(row.video_id, row.added_by_id, row.added_by);
      const stillAlive = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM library WHERE video_id=? AND dead=0", row.video_id).one().n;
      if (stillAlive === 0) continue;
      sql.exec("UPDATE library SET played_cycle=? WHERE video_id=?", cycle, row.video_id);
      return {
        id: `${Date.now()}-${row.video_id}`,
        videoId: row.video_id,
        title: title ?? "",
        author: author ?? "",
        thumbnailUrl: thumbnailUrl ?? "",
        source: "history",
        addedBy,
      };
    }
    return null;
  }

  /**
   * Checks the category of `videoId` and of up to CATEGORY_BATCH_ROWS - 1 other unchecked rows in ONE videos.list call, so
   * a big backfilled library is cleared a batch at a time instead of one subrequest per row. A non-music video is retired;
   * music is remembered; "answered, no category" (a deleted or private video) is remembered too, as final. A call YouTube
   * did not answer changes nothing and pauses lookups for CATEGORY_RETRY_MS.
   *
   * A batch refused as a bad request (HTTP 400: one id YouTube cannot parse fails the whole call) is split once: the picked
   * row is asked alone, and so is every other id, up to MAX_SPLIT_LOOKUPS calls. An id that is refused even alone is the
   * bad one, and is marked answered-without-category (music=2) so it can never be sent in a batch again. Without that, the
   * same poisoned batch would be re-sent, and refused, on every pick.
   */
  private async checkCategories(videoId: string): Promise<void> {
    const sql = this.ctx.storage.sql;
    const others = sql
      .exec<{ video_id: string }>(
        "SELECT video_id FROM library WHERE dead=0 AND music IS NULL AND video_id != ? ORDER BY RANDOM() LIMIT ?",
        videoId,
        CATEGORY_BATCH_ROWS - 1,
      )
      .toArray()
      .map((r) => r.video_id);
    const lookup = await lookupVideoCategories(this.env, [videoId, ...others]);
    if (lookup.answered.size === 0 && lookup.badRequest && others.length > 0) {
      const ids = [videoId, ...others].slice(0, MAX_SPLIT_LOOKUPS);
      const singles = await Promise.all(ids.map((id) => lookupVideoCategories(this.env, [id])));
      let anyAnswered = false;
      singles.forEach((one, i) => {
        if (one.answered.size > 0) {
          anyAnswered = true;
          this.recordCategory(ids[i], one.categories.get(ids[i]));
        } else if (one.badRequest) {
          // Refused even alone: this id is malformed as far as YouTube is concerned. It stays playable (fail open) but is
          // marked final so it is never batched again.
          sql.exec("UPDATE library SET music=2 WHERE video_id=? AND music IS NULL", ids[i]);
        }
      });
      if (!anyAnswered && singles.every((one) => !one.badRequest)) this.categoryDownUntil = Date.now() + CATEGORY_RETRY_MS;
      return;
    }
    if (lookup.answered.size === 0) {
      this.categoryDownUntil = Date.now() + CATEGORY_RETRY_MS;
      return;
    }
    for (const id of lookup.answered) this.recordCategory(id, lookup.categories.get(id));
  }

  /** Stores one video's verdict. `AND music IS NULL`: only rows still unchecked, so a verdict that arrived meanwhile stands. */
  private recordCategory(id: string, category: VideoCategory | undefined): void {
    const sql = this.ctx.storage.sql;
    if (isNonMusic(category)) sql.exec("UPDATE library SET music=0, dead=1 WHERE video_id=? AND music IS NULL", id);
    else sql.exec("UPDATE library SET music=? WHERE video_id=? AND music IS NULL", category ? 1 : 2, id);
  }

  // ---- Backfill -----------------------------------------------------------

  async alarm(): Promise<void> {
    const s = this.state;
    if (!s) return;
    // The first-time backfill wins: it creates the rows the refill would annotate.
    if (!s.backfill.done) return this.runBackfill(s);
    if (s.refill) return this.runRefill(s);
  }

  /**
   * One conversations.history page. Returns null when nothing should be processed now: a 429, or a network/parse failure.
   * Either way a retry alarm is already set, so callers just stop. Letting a throw escape alarm() would leave the pass
   * without an alarm if the runtime does not retry it, and nothing would ever resume it.
   */
  private async readHistoryPage(s: StationState, cursor: string | null, pass: { failures?: number }) {
    try {
      const token = await botTokenFor(this.env, s.teamId);
      if (!token) {
        // No install for this workspace (uninstalled, or never completed): the same permanent outcome as a revoked token.
        return { ok: false as const, error: "token_revoked" };
      }
      const res = await slackApi(this.env, "conversations.history", token, {
        channel: s.channelId,
        limit: "200",
        ...(cursor ? { cursor } : {}),
      });
      if (res.status === 429) {
        const wait = Number(res.headers.get("Retry-After")) || BACKFILL_DEFAULT_RETRY_S;
        await this.ctx.storage.setAlarm(Date.now() + wait * 1000);
        return null;
      }
      const body = (await res.json()) as {
        ok: boolean;
        error?: string;
        messages?: SlackMessage[];
        has_more?: boolean;
        response_metadata?: { next_cursor?: string };
      };
      if (body.ok) pass.failures = 0;
      return body;
    } catch (err) {
      console.error("conversations.history threw:", err);
      // Bounded like an ok:false answer: a persistently non-JSON 5xx must not retry every minute forever.
      if (await this.noteHistoryFailure(pass)) return null;
      return { ok: false as const, error: "unreachable" };
    }
  }

  /** Counts a failed page and schedules a retry. Returns false once the budget is spent, so the caller ends the pass. */
  private async noteHistoryFailure(pass: { failures?: number }): Promise<boolean> {
    pass.failures = (pass.failures ?? 0) + 1;
    if (pass.failures >= MAX_HISTORY_FAILURES) return false;
    await this.ctx.storage.setAlarm(Date.now() + BACKFILL_DEFAULT_RETRY_S * 1000);
    await this.persist();
    return true;
  }

  private async runBackfill(s: StationState): Promise<void> {
    const body = await this.readHistoryPage(s, s.backfill.cursor, s.backfill);
    if (!body) return;
    if (!body.ok) {
      // Permanent errors do not fix themselves (live links still work). Anything else retries, bounded so a persistent
      // failure still ends the pass instead of leaving "Indexing…" up forever.
      console.error("conversations.history failed:", body.error);
      if (!PERMANENT_HISTORY_ERRORS.has(body.error ?? "") && (await this.noteHistoryFailure(s.backfill))) return;
      s.backfill = { cursor: null, done: true, error: body.error ?? "unknown_error" };
    } else {
      for (const m of body.messages ?? []) {
        if (!isUserMessage(m) || !m.ts) continue;
        extractVideoIds(m.text ?? "").forEach((videoId, seq) => {
          // Newest-first pages: a video posted twice is seen newest first, so the older post overwrites when it arrives.
          // The poster travels with the earliest post, matching `first_ts`, so "who added it" means who first did.
          // The `=` arm is for rows a live post created before attribution existed: same message, so same first_ts, but no
          // poster. A strict `<` alone would skip them, and finishing the backfill marks attribution done.
          this.ctx.storage.sql.exec(
            `INSERT INTO library(video_id, first_ts, seq, added_by_id) VALUES (?,?,?,?)
             ON CONFLICT(video_id) DO UPDATE SET first_ts=excluded.first_ts, seq=excluded.seq, added_by_id=excluded.added_by_id, added_by=NULL
             WHERE excluded.first_ts < library.first_ts
                OR (excluded.first_ts = library.first_ts AND library.added_by_id IS NULL AND excluded.added_by_id IS NOT NULL)`,
            videoId,
            m.ts,
            seq,
            m.user ?? null,
          );
        });
      }
      const next = body.response_metadata?.next_cursor;
      if (body.has_more && next) {
        s.backfill.cursor = next;
        await this.ctx.storage.setAlarm(Date.now() + BACKFILL_PAGE_DELAY_MS);
      } else {
        // A backfill that finishes here records every poster itself, so no separate attribution pass is owed.
        s.backfill = { cursor: null, done: true, error: null };
        s.attributionDone = true;
      }
    }
    await this.persist();
    await this.maybeStart();
    this.broadcast();
  }

  /**
   * Fills in `added_by_id` for rows indexed before attribution existed. It reads the same history but only sets the poster,
   * and only where it is unknown: `first_ts` and everything else stay as they are, and rotation (gated on
   * `backfill.done`, still true) never pauses.
   */
  private async runRefill(s: StationState): Promise<void> {
    const pass = s.refill ?? { cursor: null };
    const body = await this.readHistoryPage(s, pass.cursor, pass);
    if (!body) return;
    if (!body.ok) {
      console.error("refill: conversations.history failed:", body.error);
      // A transient error retries within its budget; a spent budget or a permanent one ends the pass for good.
      if (!PERMANENT_HISTORY_ERRORS.has(body.error ?? "") && (await this.noteHistoryFailure(pass))) return;
      delete s.refill;
      s.attributionDone = true;
    } else {
      for (const m of body.messages ?? []) {
        if (!isUserMessage(m) || !m.ts || !m.user) continue;
        for (const videoId of extractVideoIds(m.text ?? "")) {
          // Only the earliest post of each video names its adder: match on first_ts, and never overwrite a known poster.
          this.ctx.storage.sql.exec(
            "UPDATE library SET added_by_id=? WHERE video_id=? AND first_ts=? AND added_by_id IS NULL",
            m.user,
            videoId,
            m.ts,
          );
        }
      }
      const next = body.response_metadata?.next_cursor;
      if (body.has_more && next) {
        s.refill = { cursor: next, failures: 0 };
        await this.ctx.storage.setAlarm(Date.now() + BACKFILL_PAGE_DELAY_MS);
      } else {
        delete s.refill;
        s.attributionDone = true;
      }
    }
    await this.persist();
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
