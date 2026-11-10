import type { ClientMessage, ServerMessage, StateMessage } from "../../shared/protocol";

const PING_INTERVAL_MS = 30_000;
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const DRIFT_THRESHOLD_MS = 1000;
/** After a seek or track load, buffering distorts getCurrentTime; checking sooner causes seek loops. */
const DRIFT_COOLDOWN_MS = 5000;
/** Re-report an unacknowledged end after this long; send() silently drops while the socket is down. */
const END_REPORT_RETRY_MS = 5000;
/** Slack for clock-offset error and buffering before a track counts as overrun. */
const OVERRUN_GRACE_MS = 1500;
/**
 * A ping unanswered for this long means the socket is dead even if the browser never fired `close`
 * (a phone that slept or changed network leaves a half-open socket). Throttled timers fire late, never early, and a
 * live socket's pong is delivered before the late timer runs, so a backgrounded tab cannot trip this falsely.
 */
const PONG_DEADLINE_MS = 10_000;
/** A paused player is nudged at most this often, so a browser that refuses playback is not hammered. */
const RESUME_THROTTLE_MS = 2000;
/** Silent resume attempts before the UI is asked for a tap (autoplay policy blocks playback without a gesture). */
const MAX_RESUME_ATTEMPTS = 3;

export type Connection = {
  send(msg: ClientMessage): void;
  close(): void;
  /** serverNow − localNow, smoothed. */
  offsetMs(): number;
  /** True once the first pong has set the clock offset; before that, offsetMs() is 0 and meaningless. */
  clockSynced(): boolean;
};

export function connect(
  token: string,
  onState: (s: StateMessage) => void,
  onStatus: (open: boolean) => void,
): Connection {
  let ws: WebSocket | null = null;
  let closed = false;
  let backoff = BACKOFF_START_MS;
  let offset = 0;
  let haveOffset = false;
  let lastRxAt = 0;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let pongTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const send = (msg: ClientMessage) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const ping = () => {
    const t0 = Date.now();
    send({ type: "ping", t0 });
    clearTimeout(pongTimer);
    pongTimer = setTimeout(() => {
      if (lastRxAt < t0) reconnectNow();
    }, PONG_DEADLINE_MS);
  };

  const open = () => {
    clearTimeout(retryTimer);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const sock = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      backoff = BACKOFF_START_MS;
      lastRxAt = Date.now();
      onStatus(true);
      ping();
      pingTimer = setInterval(ping, PING_INTERVAL_MS);
    };
    sock.onmessage = (ev) => {
      // A replaced socket can still deliver while closing; its traffic must not count as liveness for the new one.
      if (ws !== sock) return;
      lastRxAt = Date.now();
      if (typeof ev.data !== "string") return;
      const msg = JSON.parse(ev.data) as ServerMessage;
      if (msg.type === "pong") {
        const t1 = Date.now();
        const sample = msg.serverNow - (msg.t0 + (t1 - msg.t0) / 2);
        offset = haveOffset ? 0.8 * offset + 0.2 * sample : sample;
        haveOffset = true;
      } else if (msg.type === "state") {
        onState(msg);
      }
    };
    sock.onclose = () => {
      // A socket we replaced on purpose must not schedule a second reconnect.
      if (ws !== sock) return;
      clearInterval(pingTimer);
      clearTimeout(pongTimer);
      if (closed) return;
      onStatus(false);
      retryTimer = setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    };
  };

  /** Drops the current socket without waiting for its close handshake and dials a fresh one. */
  const reconnectNow = () => {
    if (closed) return;
    clearInterval(pingTimer);
    clearTimeout(pongTimer);
    const old = ws;
    ws = null;
    old?.close();
    onStatus(false);
    backoff = BACKOFF_START_MS;
    open();
  };

  /** Called when the page may have just woken from sleep or a network change: verify the socket, or replace it. */
  const probe = () => {
    if (closed) return;
    const s = ws?.readyState;
    // CONNECTING counts too: a dial started before sleep may never complete, and nothing else times it out.
    if (s === undefined || s === WebSocket.CONNECTING || s === WebSocket.CLOSING || s === WebSocket.CLOSED) reconnectNow();
    else if (s === WebSocket.OPEN) ping();
  };
  const onVisible = () => document.visibilityState === "visible" && probe();
  document.addEventListener("visibilitychange", onVisible);
  document.addEventListener("resume", probe);
  window.addEventListener("online", probe);
  window.addEventListener("pageshow", probe);
  open();

  return {
    send,
    offsetMs: () => offset,
    clockSynced: () => haveOffset,
    close() {
      closed = true;
      clearInterval(pingTimer);
      clearTimeout(pongTimer);
      clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("resume", probe);
      window.removeEventListener("online", probe);
      window.removeEventListener("pageshow", probe);
      ws?.close();
    },
  };
}

/** Keeps one YT.Player aligned with the station clock. Seek-only: YouTube rounds unsupported playback rates back to 1. */
export class PlayerSync {
  playingId: string | null = null;
  /** False from loadVideoById until PLAYING; an ENDED seen before that belongs to the previous video. */
  private confirmedPlaying = false;
  private quietUntil = 0;
  private latest: StateMessage | null = null;
  private lastEndReport: { id: string; at: number } | null = null;
  private lastResumeAt = 0;
  private resumeAttempts = 0;

  constructor(
    private player: YT.Player,
    private offsetMs: () => number,
    private clockSynced: () => boolean,
  ) {}

  private targetMs(startedAtMs: number): number {
    return Date.now() + this.offsetMs() - startedAtMs;
  }

  apply(state: StateMessage): void {
    this.latest = state;
    const now = state.now;
    if (!now) {
      if (this.playingId !== null) this.player.stopVideo();
      this.playingId = null;
      return;
    }
    if (now.id !== this.playingId) {
      this.playingId = now.id;
      this.confirmedPlaying = false;
      this.quietUntil = Date.now() + DRIFT_COOLDOWN_MS;
      this.player.loadVideoById({ videoId: now.videoId, startSeconds: Math.max(0, this.targetMs(now.startedAtMs) / 1000) });
      return;
    }
    this.checkDrift();
  }

  markPlaying(): void {
    this.confirmedPlaying = true;
    this.resumeAttempts = 0;
  }

  /**
   * Browsers pause an embedded player when the tab is backgrounded, the screen locks or another app takes audio focus,
   * and nothing tells the page to resume. If the station says a track is on but the player is not running, seek back to
   * the station position and play. Returns true once silent attempts are used up, so the UI can ask for a tap.
   * `user` bypasses the throttle and the attempt cap: a tap is the gesture the autoplay policy wants.
   */
  resumeIfPaused(user = false): boolean {
    const now = this.latest?.now;
    if (!now) return false;
    const state = this.player.getPlayerState();
    const S = window.YT!.PlayerState;
    if (state === S.PLAYING) {
      this.resumeAttempts = 0;
      return false;
    }
    // BUFFERING resolves itself, and ENDED is takePendingEndId's job.
    if (state === S.BUFFERING || state === S.ENDED) return false;
    const t = Date.now();
    if (!user) {
      if (t < this.quietUntil) return false;
      if (this.resumeAttempts >= MAX_RESUME_ATTEMPTS) return true;
      if (t - this.lastResumeAt < RESUME_THROTTLE_MS) return false;
      this.resumeAttempts++;
    }
    this.lastResumeAt = t;
    // Seek while paused, then play: the other order restarts audio at the stale position first.
    if (this.clockSynced()) this.player.seekTo(Math.max(0, this.targetMs(now.startedAtMs) / 1000), true);
    this.player.playVideo();
    return false;
  }

  /** Id to report for an ENDED event, or null when it can only belong to the previous video. */
  endedId(): string | null {
    return this.confirmedPlaying ? this.playingId : null;
  }

  /**
   * Id of the current track when it is over but nobody reported it, else null; each id is handed out at most once per
   * END_REPORT_RETRY_MS. Covers an ENDED lost while the socket was down, and a track the station clock has run past
   * its end (unfreeze after a lost ENDED, or a late joiner): YouTube then flickers at the clamped end and never emits
   * ENDED. The server only advances on the current id, so a repeat is harmless.
   * Overrun needs a measured clock offset: with offset 0 a skewed client would end a playing track for everyone.
   */
  takePendingEndId(): string | null {
    const now = this.latest?.now;
    const id = this.endedId();
    if (!now || !id) return null;
    if (this.lastEndReport?.id === id && Date.now() - this.lastEndReport.at < END_REPORT_RETRY_MS) return null;
    const ended = this.player.getPlayerState() === window.YT!.PlayerState.ENDED;
    if (!ended) {
      const durationMs = this.player.getDuration() * 1000;
      if (!this.clockSynced() || Date.now() < this.quietUntil || durationMs <= 0) return null;
      if (this.targetMs(now.startedAtMs) <= durationMs + OVERRUN_GRACE_MS) return null;
    }
    this.lastEndReport = { id, at: Date.now() };
    return id;
  }

  checkDrift(): void {
    const now = this.latest?.now;
    if (!now || Date.now() < this.quietUntil) return;
    if (this.player.getPlayerState() !== window.YT!.PlayerState.PLAYING) return;
    const target = this.targetMs(now.startedAtMs);
    const drift = this.player.getCurrentTime() * 1000 - target;
    if (Math.abs(drift) > DRIFT_THRESHOLD_MS) {
      this.player.seekTo(Math.max(0, target / 1000), true);
      this.quietUntil = Date.now() + DRIFT_COOLDOWN_MS;
    }
  }

  elapsedMs(): number {
    const now = this.latest?.now;
    return now ? Math.max(0, this.targetMs(now.startedAtMs)) : 0;
  }
}
