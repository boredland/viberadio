let apiPromise: Promise<void> | null = null;

/** A request that neither completes nor errors (captive portal, stalled connection) must not pin the cached promise. */
const API_LOAD_TIMEOUT_MS = 15_000;

/**
 * Loads the IFrame API script once. Safe to call early to preload.
 * A failed or stalled load is not cached: the next call dials again, so the page can recover when the network
 * returns without a manual reload.
 */
export function loadYouTubeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (apiPromise) return apiPromise;
  const attempt = new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    const timer = setTimeout(() => fail(new Error("YouTube iframe API timed out")), API_LOAD_TIMEOUT_MS);
    const fail = (err: Error) => {
      clearTimeout(timer);
      s.remove();
      reject(err);
    };
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timer);
      resolve();
    };
    s.onerror = () => fail(new Error("YouTube iframe API failed to load"));
    s.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(s);
  });
  apiPromise = attempt;
  attempt.catch(() => {
    if (apiPromise === attempt) apiPromise = null;
  });
  return attempt;
}

export function youTubeApiReady(): boolean {
  return !!window.YT?.Player;
}

export type PlayerHandlers = {
  onReady: () => void;
  onPlaying: () => void;
  /** The listener has no pause control, so this is the browser or OS pausing the player (background, lock, audio focus). */
  onPaused: () => void;
  onEnded: () => void;
  onError: (code: number) => void;
  onAutoplayBlocked: () => void;
};

/** YT.Player replaces the element it is given, so `host` must be a throwaway child. */
export function createPlayer(host: HTMLElement, h: PlayerHandlers): YT.Player {
  return new window.YT!.Player(host, {
    // The IFrame API requires a viewport of at least 200x200.
    width: 240,
    height: 240,
    playerVars: { controls: 0, disablekb: 1, playsinline: 1, rel: 0, origin: location.origin },
    events: {
      onReady: h.onReady,
      onStateChange: (e) => {
        const state = window.YT!.PlayerState;
        if (e.data === state.PLAYING) h.onPlaying();
        if (e.data === state.PAUSED) h.onPaused();
        if (e.data === state.ENDED) h.onEnded();
      },
      onError: (e) => h.onError(e.data),
      onAutoplayBlocked: h.onAutoplayBlocked,
    },
  });
}
