import type { ClientMessage, ServerMessage, StateMessage } from "../../shared/protocol";

const PING_INTERVAL_MS = 30_000;
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const DRIFT_THRESHOLD_MS = 1000;
/** After a seek or track load, buffering distorts getCurrentTime; checking sooner causes seek loops. */
const DRIFT_COOLDOWN_MS = 5000;
/** Slack for clock-offset error and buffering before a track counts as overrun. */
const OVERRUN_GRACE_MS = 1500;

export type Connection = {
  send(msg: ClientMessage): void;
  close(): void;
  /** serverNow − localNow, smoothed. */
  offsetMs(): number;
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
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const send = (msg: ClientMessage) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const open = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const sock = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
    ws = sock;
    sock.onopen = () => {
      backoff = BACKOFF_START_MS;
      onStatus(true);
      send({ type: "ping", t0: Date.now() });
      pingTimer = setInterval(() => send({ type: "ping", t0: Date.now() }), PING_INTERVAL_MS);
    };
    sock.onmessage = (ev) => {
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
      clearInterval(pingTimer);
      if (closed) return;
      onStatus(false);
      retryTimer = setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    };
  };
  open();

  return {
    send,
    offsetMs: () => offset,
    close() {
      closed = true;
      clearInterval(pingTimer);
      clearTimeout(retryTimer);
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

  constructor(
    private player: YT.Player,
    private offsetMs: () => number,
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
  }

  /** Id to report for an ENDED event, or null when it can only belong to the previous video. */
  endedId(): string | null {
    return this.confirmedPlaying ? this.playingId : null;
  }

  /**
   * Id of the current track when it is over but nobody reported it, else null.
   * Covers an ENDED lost while the socket was down, and a track the station clock has run past its end (unfreeze after a
   * lost ENDED, or a late joiner): YouTube then flickers at the clamped end and never emits ENDED. The server only
   * advances on the current id, so re-sending is idempotent.
   */
  pendingEndId(): string | null {
    const now = this.latest?.now;
    const id = this.endedId();
    if (!now || !id) return null;
    if (this.player.getPlayerState() === window.YT!.PlayerState.ENDED) return id;
    const durationMs = this.player.getDuration() * 1000;
    if (Date.now() < this.quietUntil || durationMs <= 0) return null;
    return this.targetMs(now.startedAtMs) > durationMs + OVERRUN_GRACE_MS ? id : null;
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
