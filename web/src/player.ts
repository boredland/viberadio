let apiPromise: Promise<void> | null = null;

/** Loads the IFrame API script once. Safe to call early to preload. */
export function loadYouTubeApi(): Promise<void> {
  apiPromise ??= new Promise<void>((resolve) => {
    if (window.YT?.Player) return resolve();
    window.onYouTubeIframeAPIReady = () => resolve();
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(s);
  });
  return apiPromise;
}

export function youTubeApiReady(): boolean {
  return !!window.YT?.Player;
}

export type PlayerHandlers = {
  onReady: () => void;
  onPlaying: () => void;
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
        if (e.data === state.ENDED) h.onEnded();
      },
      onError: (e) => h.onError(e.data),
      onAutoplayBlocked: h.onAutoplayBlocked,
    },
  });
}
