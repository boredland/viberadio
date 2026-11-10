import { useCallback, useEffect, useRef, useState } from "react";
import type { StateMessage } from "../../shared/protocol";
import { createPlayer, loadYouTubeApi, youTubeApiReady } from "./player";
import { connect, PlayerSync, type Connection } from "./sync";

const DRIFT_TICK_MS = 5000;
const UI_TICK_MS = 500;
/** Page misconfiguration (missing Referer / client identity), not a bad video: must never skip tracks for everyone. */
const ERR_CONFIG = 153;

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function Station({ token }: { token: string }) {
  const [valid, setValid] = useState<boolean | null>(null);
  const [snap, setSnap] = useState<StateMessage | null>(null);
  const [tuned, setTuned] = useState(false);
  const [apiReady, setApiReady] = useState(youTubeApiReady());
  const [connected, setConnected] = useState(true);
  const [volume, setVolume] = useState(80);
  const [muted, setMuted] = useState(false);
  const [unmuteChip, setUnmuteChip] = useState(false);
  const [configError, setConfigError] = useState(false);
  const [, setTick] = useState(0);

  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YT.Player | null>(null);
  const syncRef = useRef<PlayerSync | null>(null);
  const connRef = useRef<Connection | null>(null);
  const latestRef = useRef<StateMessage | null>(null);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/station/${encodeURIComponent(token)}`)
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) return setValid(false);
        setSnap((await r.json()) as StateMessage);
        setValid(true);
      })
      .catch(() => !cancelled && setValid(false));
    // Preloaded so the Tune in click can build the player synchronously (autoplay needs the user gesture's call stack).
    loadYouTubeApi().then(() => !cancelled && setApiReady(true));
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(
    () => () => {
      connRef.current?.close();
      playerRef.current?.destroy();
    },
    [],
  );

  useEffect(() => {
    if (!tuned) return;
    const check = () => {
      const sync = syncRef.current;
      sync?.checkDrift();
      const overdue = sync?.pendingEndId();
      if (overdue) connRef.current?.send({ type: "ended", id: overdue });
    };
    const onVisible = () => document.visibilityState === "visible" && check();
    const drift = setInterval(check, DRIFT_TICK_MS);
    const ui = setInterval(() => setTick((t) => t + 1), UI_TICK_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(drift);
      clearInterval(ui);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tuned]);

  const tuneIn = useCallback(() => {
    if (!hostRef.current || !youTubeApiReady()) return;
    setTuned(true);
    const host = document.createElement("div");
    hostRef.current.appendChild(host);

    const conn = connect(
      token,
      (s) => {
        latestRef.current = s;
        setSnap(s);
        const sync = syncRef.current;
        sync?.apply(s);
        const overdue = sync?.pendingEndId();
        if (overdue) conn.send({ type: "ended", id: overdue });
      },
      setConnected,
    );
    connRef.current = conn;

    const player = createPlayer(host, {
      onReady: () => {
        player.setVolume(volumeRef.current);
        syncRef.current = new PlayerSync(player, conn.offsetMs);
        if (latestRef.current) syncRef.current.apply(latestRef.current);
      },
      onPlaying: () => syncRef.current?.markPlaying(),
      onEnded: () => {
        const id = syncRef.current?.endedId();
        if (id) conn.send({ type: "ended", id });
      },
      onError: (code) => {
        if (code === ERR_CONFIG) return setConfigError(true);
        const id = syncRef.current?.playingId;
        if (id) conn.send({ type: "error", id, code });
      },
      onAutoplayBlocked: () => {
        player.mute();
        player.playVideo();
        setMuted(true);
        setUnmuteChip(true);
      },
    });
    playerRef.current = player;
  }, [token]);

  const setVol = (v: number) => {
    setVolume(v);
    playerRef.current?.setVolume(v);
  };

  const toggleMute = () => {
    const p = playerRef.current;
    if (!p) return;
    if (muted) p.unMute();
    else p.mute();
    setMuted(!muted);
    setUnmuteChip(false);
  };

  if (valid === null) return <main className="card">Loading…</main>;
  if (valid === false) return <main className="card">This station link isn't valid.</main>;

  const now = snap?.now ?? null;
  const duration = (tuned && syncRef.current ? playerRef.current?.getDuration() : 0) ?? 0;
  const elapsed = syncRef.current?.elapsedMs() ?? 0;

  return (
    <main className="card">
      <header>
        <h1>viberadio</h1>
        <p>
          🎧 {snap?.listeners ?? 0} listening · {snap?.librarySize ?? 0} tracks in rotation
        </p>
      </header>

      {tuned && !connected && <p className="banner">Reconnecting…</p>}
      {configError && <p className="banner">Player configuration error (153)</p>}

      {!tuned && (
        <button className="primary" disabled={!apiReady} onClick={tuneIn}>
          ▶ Tune in
        </button>
      )}
      <div className="player" ref={hostRef} hidden={!tuned} />

      {tuned && now && (
        <section>
          <h2>{now.title}</h2>
          <p>{now.author}</p>
          {now.source === "history" && <span className="badge">↩ from channel history</span>}
          {duration > 0 ? <progress value={Math.min(elapsed, duration * 1000)} max={duration * 1000} /> : <progress />}
          <p className="time">
            {fmt(elapsed)}
            {duration > 0 ? ` / ${fmt(duration * 1000)}` : ""}
          </p>
        </section>
      )}

      {tuned && !now && snap && (
        <p>
          {snap.indexing
            ? "Indexing channel history…"
            : snap.librarySize === 0
              ? "Nothing in rotation yet — post a YouTube link in the channel."
              : "Nothing playable right now — post a YouTube link in the channel."}
        </p>
      )}

      {tuned && (
        <div className="controls">
          <button disabled={now === null} onClick={() => connRef.current?.send({ type: "next" })}>
            Next ⏭
          </button>
          <button onClick={toggleMute}>{muted ? "🔇" : "🔊"}</button>
          <input type="range" min={0} max={100} value={volume} onChange={(e) => setVol(Number(e.target.value))} />
          {unmuteChip && (
            <button className="chip" onClick={toggleMute}>
              Tap to unmute
            </button>
          )}
        </div>
      )}

      {snap && snap.queue.length > 0 && (
        <section>
          <h3>Up next</h3>
          <ol>
            {snap.queue.map((t) => (
              <li key={t.id}>
                {t.title} <small>— {t.author}</small>
              </li>
            ))}
          </ol>
        </section>
      )}
    </main>
  );
}
