import { useCallback, useEffect, useRef, useState } from "react";
import type { StateMessage } from "../../shared/protocol";
import { createPlayer, loadYouTubeApi, youTubeApiReady } from "./player";
import { connect, PlayerSync, type Connection } from "./sync";
import { Marquee, Visualizer, Win } from "./ui";
import { bindMediaKeys, bindPlay, setNowPlaying } from "./mediaSession";
import { useKeepAwake } from "./wakeLock";
import { forgetStation } from "./pwa";
import { Rotation } from "./Rotation";
import { bpmFor, setBeatSource } from "./Backdrop";
import { autoStartTabAudio, startTabAudio, stopTabAudio, tabAudioMessage, tabAudioSupported, turnOffTabAudio, useTabAudio } from "./tabAudio";
import { Look } from "./Look";
import { loadVolume, saveVolume } from "./volume";
import { BrowserNote } from "./BrowserNote";

const DRIFT_TICK_MS = 5000;
const UI_TICK_MS = 500;
const API_RETRY_MS = 5000;
const CONFIRM_MS = 4000;
/** Page misconfiguration (missing Referer / client identity), not a bad video: must never skip tracks for everyone. */
const ERR_CONFIG = 153;

const pad2 = (n: number) => String(n).padStart(2, "0");
const pad3 = (n: number) => String(n).padStart(3, "0");

/** mm:ss, or h:mm:ss past an hour, for the LCD readout. */
function fmtLcd(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${pad2(m)}:${pad2(s % 60)}`;
}

export function Station({ token, online }: { token: string; online: boolean }) {
  const [valid, setValid] = useState<boolean | null>(null);
  const [snap, setSnap] = useState<StateMessage | null>(null);
  const [tuned, setTuned] = useState(false);
  const [apiReady, setApiReady] = useState(youTubeApiReady());
  const [connected, setConnected] = useState(true);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [apiRetry, setApiRetry] = useState(0);
  // A lazy initialiser, so storage is read once at mount, and the player is created with it in onReady via volumeRef.
  const [volume, setVolume] = useState(loadVolume);
  const [muted, setMuted] = useState(false);
  const [unmuteChip, setUnmuteChip] = useState(false);
  const [configError, setConfigError] = useState(false);
  const [needsTap, setNeedsTap] = useState(false);
  const [, setTick] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YT.Player | null>(null);
  const syncRef = useRef<PlayerSync | null>(null);
  const connRef = useRef<Connection | null>(null);
  const latestRef = useRef<StateMessage | null>(null);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const keepAwake = useKeepAwake(tuned);
  const tabAudio = useTabAudio();

  useEffect(() => {
    let cancelled = false;
    setLoadFailed(false);
    fetch(`/api/station/${encodeURIComponent(token)}`)
      .then(async (r) => {
        if (cancelled) return;
        // Only a definite 404 means the link is bad; any other failure is transient and must not look like one.
        if (r.status === 404) {
          forgetStation(token);
          return setValid(false);
        }
        if (!r.ok) return setLoadFailed(true);
        setSnap((await r.json()) as StateMessage);
        setValid(true);
      })
      .catch(() => !cancelled && setLoadFailed(true));
    // Preloaded so the Tune in click can build the player synchronously (autoplay needs the user gesture's call stack).
    // A load that failed offline is dialled again on every attempt, so TUNE IN enables once the network is back.
    loadYouTubeApi()
      .then(() => !cancelled && setApiReady(true))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [token, attempt]);

  // Leaving the page must end the share: otherwise Chrome's "sharing this tab" bar and the analyser outlive the station.
  useEffect(() => stopTabAudio, []);

  // Retry once when connectivity returns. Keyed on `online` alone: keying on loadFailed too would retry in a tight loop
  // against a server that is reachable but failing.
  useEffect(() => {
    if (online && loadFailed && valid === null) setAttempt((n) => n + 1);
  }, [online]);

  // The station can load while the YouTube script did not (flaky network, stalled request): dial that again. A failed
  // attempt re-arms itself on a timer, because nothing else changes (we are still online) to re-run this effect.
  useEffect(() => {
    if (!online || apiReady) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    loadYouTubeApi()
      .then(() => !cancelled && setApiReady(true))
      .catch(() => {
        if (!cancelled) timer = setTimeout(() => setApiRetry((n) => n + 1), API_RETRY_MS);
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [online, apiReady, apiRetry]);

  // An armed remove button disarms itself, so a stray tap earlier cannot turn a later tap into a removal.
  useEffect(() => {
    if (!confirmId) return;
    const t = setTimeout(() => setConfirmId(null), CONFIRM_MS);
    return () => clearTimeout(t);
  }, [confirmId]);

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
      const overdue = sync?.takePendingEndId();
      if (overdue) connRef.current?.send({ type: "ended", id: overdue });
      if (sync) setNeedsTap(sync.resumeIfPaused());
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      syncRef.current?.onPageVisible();
      check();
    };
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
    // The video window is display:none until React re-renders; a hidden iframe can be refused playback, so expand it first.
    hostRef.current.closest(".win")?.classList.remove("collapsed");
    const host = document.createElement("div");
    hostRef.current.appendChild(host);

    const conn = connect(
      token,
      (s) => {
        latestRef.current = s;
        setSnap(s);
        const sync = syncRef.current;
        sync?.apply(s);
        const overdue = sync?.takePendingEndId();
        if (overdue) conn.send({ type: "ended", id: overdue });
      },
      setConnected,
    );
    connRef.current = conn;

    const player = createPlayer(host, {
      onReady: () => {
        player.setVolume(volumeRef.current);
        syncRef.current = new PlayerSync(player, conn.offsetMs, conn.clockSynced);
        if (latestRef.current) syncRef.current.apply(latestRef.current);
      },
      onPlaying: () => {
        syncRef.current?.markPlaying();
        setNeedsTap(false);
      },
      onPaused: () => {
        const sync = syncRef.current;
        if (sync) setNeedsTap(sync.resumeIfPaused());
      },
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
    // Last, so the player already exists when the browser's share prompt takes over. Still the same click, so it is allowed.
    void autoStartTabAudio();
  }, [token]);

  const setVol = (v: number) => {
    setVolume(v);
    playerRef.current?.setVolume(v);
    // Every change, not on release: arrow keys on the slider have no release event, and the write is one small number.
    saveVolume(v);
  };

  const toggleMute = () => {
    const p = playerRef.current;
    if (!p) return;
    if (muted) p.unMute();
    else p.mute();
    setMuted(!muted);
    setUnmuteChip(false);
  };

  /** A tap is the gesture the autoplay policy needs, so this resumes where the silent retries gave up. */
  const resumeByTap = useCallback(() => {
    syncRef.current?.resumeIfPaused(true);
    setNeedsTap(false);
  }, []);

  useEffect(() => {
    if (!tuned) return;
    setNowPlaying(snap?.now ?? null);
  }, [tuned, snap?.now?.id]);

  useEffect(() => () => setNowPlaying(null), []);

  // The tab title carries the track and whether it is audible, so a pinned or background tab shows it. A volume of 0 is
  // silent too, so it counts as muted.
  const silent = muted || volume === 0;
  const trackTitle = snap?.now?.title ?? null;
  useEffect(() => {
    if (!tuned || !trackTitle) {
      document.title = "viberadio";
      return;
    }
    document.title = `${silent ? "🔇" : "🔊"} ${trackTitle} · viberadio`;
  }, [tuned, trackTitle, silent]);

  useEffect(() => () => void (document.title = "viberadio"), []);

  // The backdrop pulses on the station clock, and only while the player is really playing (never while paused or blocked).
  useEffect(() => {
    if (!tuned) return;
    setBeatSource(() => {
      const conn = connRef.current;
      const now = latestRef.current?.now;
      // syncRef is created in onReady, so its presence means the player's methods exist.
      if (!syncRef.current || !conn || !now || !conn.clockSynced()) return null;
      if (playerRef.current?.getPlayerState() !== window.YT!.PlayerState.PLAYING) return null;
      return ((Date.now() + conn.offsetMs() - now.startedAtMs) / 60000) * bpmFor(now.videoId);
    });
    return () => setBeatSource(null);
  }, [tuned]);

  useEffect(() => {
    if (!tuned) return;
    const offNext = bindMediaKeys(() => connRef.current?.send({ type: "next" }));
    const offPlay = bindPlay(resumeByTap);
    return () => {
      offNext();
      offPlay();
    };
  }, [tuned, resumeByTap]);

  if (valid === null)
    return (
      <main className="stack">
        <Win title="VIBERADIO">
          {loadFailed ? (
            <>
              <p className="lcd-text err">NO SIGNAL</p>
              <p className="dim">
                {online
                  ? "Can't reach the station. Press RETRY."
                  : "You're offline. This will reconnect when you're back online."}
              </p>
              <button className="btn" onClick={() => setAttempt((n) => n + 1)}>
                RETRY
              </button>
            </>
          ) : (
            <p className="lcd-text">
              LOADING<span className="blink">_</span>
            </p>
          )}
        </Win>
      </main>
    );
  if (valid === false)
    return (
      <main className="stack">
        <Win title="VIBERADIO">
          <p className="lcd-text err">ERR: UNKNOWN STATION</p>
          <p className="dim">This station link isn't valid.</p>
        </Win>
      </main>
    );

  const now = snap?.now ?? null;
  const duration = (tuned && syncRef.current ? playerRef.current?.getDuration() : 0) ?? 0;
  const elapsed = syncRef.current?.elapsedMs() ?? 0;
  const pct = duration > 0 ? Math.min(100, (elapsed / (duration * 1000)) * 100) : 0;
  const emptyMsg = !snap
    ? ""
    : snap.indexing
      ? "Indexing channel history…"
      : snap.librarySize === 0
        ? "Nothing in rotation yet — post a YouTube link in the channel."
        : "Nothing playable right now — post a YouTube link in the channel.";
  const ticker = now ? `${now.title} — ${now.author}` : tuned ? emptyMsg : "PRESS TUNE IN TO START";

  /** Two taps: any listener can remove for everyone, so the first tap only arms the button. Needs the socket. */
  const removeButton = (id: string, title: string) => {
    if (!tuned) return null;
    const armed = confirmId === id;
    return (
      <button
        className={armed ? "x armed" : "x"}
        disabled={!connected}
        aria-label={armed ? `Confirm removing ${title}` : `Remove ${title}`}
        onClick={() => {
          if (!armed) return setConfirmId(id);
          connRef.current?.send({ type: "remove", id });
          setConfirmId(null);
        }}
      >
        {armed ? "REMOVE?" : "✕"}
      </button>
    );
  };

  return (
    <main className="stack rig">
      <div className="col">
      <Win title="VIBERADIO">
        <div className="lcd">
          <div className="lcd-top">
            <div className="clock" aria-label="elapsed time">
              {tuned && now ? fmtLcd(elapsed) : "--:--"}
            </div>
            <Visualizer active={tuned && now !== null && connected} />
          </div>
          <Marquee text={ticker} />
          <div className="lcd-info">
            <span className={now?.source === "history" ? "tag amber" : "tag"}>
              <span
                className={tuned ? (connected ? "led-dot on" : "led-dot warn") : "led-dot"}
                role="img"
                aria-label={tuned ? (connected ? "connected" : "connection lost") : "not tuned in"}
              />
              {now ? (now.source === "history" ? "↩ HISTORY" : "★ QUEUE") : "IDLE"}
            </span>
            <span>🎧 {pad3(snap?.listeners ?? 0)} LSN</span>
            <span>{pad3(snap?.librarySize ?? 0)} TRK</span>
            <span>{duration > 0 ? fmtLcd(duration * 1000) : "--:--"} LEN</span>
            {now?.addedBy && <span className="by-lcd">ADDED BY {now.addedBy.toUpperCase()}</span>}
          </div>
        </div>

        <div
          className={duration > 0 ? "seek" : "seek indeterminate"}
          role="progressbar"
          aria-label="track position"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
        >
          <div className="seek-fill" style={{ width: `${pct}%` }} />
        </div>

        {tuned && !connected && <p className="banner">RECONNECTING…</p>}
        {configError && <p className="banner">PLAYER CONFIGURATION ERROR (153)</p>}
        <BrowserNote />

        {!tuned ? (
          <button className="btn tune" disabled={!apiReady} onClick={tuneIn}>
            ▶ TUNE IN
          </button>
        ) : (
          <div className="controls">
            <button className="btn" disabled={now === null} onClick={() => connRef.current?.send({ type: "next" })}>
              NEXT ⏭
            </button>
            <button className="btn" onClick={toggleMute} aria-pressed={muted}>
              {muted ? "MUTED" : "MUTE"}
            </button>
            <label className="vol">
              <span>VOL</span>
              <input
                type="range"
                min={0}
                max={100}
                value={volume}
                onChange={(e) => setVol(Number(e.target.value))}
                style={{ ["--fill" as string]: `${volume}%` }}
              />
            </label>
            {unmuteChip && (
              <button className="btn amber" onClick={toggleMute}>
                TAP TO UNMUTE
              </button>
            )}
            {needsTap && (
              <button className="btn amber" onClick={resumeByTap}>
                ▶ TAP TO RESUME
              </button>
            )}
            {keepAwake.supported && (
              <button
                className="btn quiet"
                onClick={keepAwake.toggle}
                aria-pressed={keepAwake.wanted}
                aria-label={`Keep screen on${keepAwake.wanted && !keepAwake.active ? " (waiting for the browser)" : ""}`}
                title="Stops the screen from turning off so the player keeps playing. Uses more battery."
              >
                {keepAwake.wanted ? (keepAwake.active ? "SCREEN ON ✓" : "SCREEN ON …") : "KEEP SCREEN ON"}
              </button>
            )}
            {tabAudioSupported() && (
              <button
                className="btn quiet"
                onClick={tabAudio.status === "on" ? turnOffTabAudio : () => void startTabAudio()}
                aria-pressed={tabAudio.status === "on"}
                disabled={tabAudio.status === "starting"}
                title="Make the equalizer follow the real sound. Your browser will ask you to share this tab with its audio. Nothing is recorded or sent. Desktop Chrome or Edge only."
              >
                {tabAudio.status === "on" ? "REAL EQ ✓" : tabAudio.status === "starting" ? "REAL EQ …" : "REAL EQ"}
              </button>
            )}
            {tabAudio.status === "failed" && <p className="dim">{tabAudioMessage(tabAudio.reason)}</p>}
          </div>
        )}
      </Win>

      <Win title="VIDEO" className={tuned ? "" : "collapsed"} fold={{ key: "video", label: "VIDEO", keepLive: true }}>
        <div className="player" ref={hostRef} />
      </Win>
      </div>
      <div className="col">
      <Win title="PLAYLIST">
        {now || (snap?.queue.length ?? 0) > 0 ? (
          <ol className="playlist">
            {now && (
              <li className="current">
                <span className="n">01.</span>
                <span className="t">
                  {now.title} <small>— {now.author}</small>
                </span>
                {now.addedBy && (
                  <span className="by" title={`Added by ${now.addedBy}`}>
                    +{now.addedBy}
                  </span>
                )}
                <span className="d">{duration > 0 ? fmtLcd(duration * 1000) : ""}</span>
                {removeButton(now.id, now.title)}
              </li>
            )}
            {snap?.queue.map((t, i) => (
              <li key={t.id}>
                <span className="n">{pad2(i + 2)}.</span>
                <span className="t">
                  {t.title} <small>— {t.author}</small>
                </span>
                {t.addedBy && (
                  <span className="by" title={`Added by ${t.addedBy}`}>
                    +{t.addedBy}
                  </span>
                )}
                {removeButton(t.id, t.title)}
              </li>
            ))}
          </ol>
        ) : (
          <p className="dim">{emptyMsg || "Queue empty."}</p>
        )}
      </Win>

      {tuned && (
        <Rotation
          token={token}
          // Only the size of the rotation: it changes on any add or removal. The playing/queued track is deliberately not
          // part of it, or every track change would refetch every shown page (each can trigger title lookups).
          version={`${snap?.librarySize ?? 0}`}
          connected={connected}
          onRemove={(videoId) => connRef.current?.send({ type: "removeVideo", videoId })}
        />
      )}
      <Look />
      </div>
    </main>
  );
}
