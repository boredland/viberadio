// Minimal surface of the YouTube IFrame Player API used by this app.
declare namespace YT {
  const PlayerState: { UNSTARTED: -1; ENDED: 0; PLAYING: 1; PAUSED: 2; BUFFERING: 3; CUED: 5 };
  interface OnStateChangeEvent {
    data: number;
  }
  interface OnErrorEvent {
    data: number;
  }
  interface PlayerOptions {
    width: number;
    height: number;
    playerVars: Record<string, string | number>;
    events: {
      onReady?: () => void;
      onStateChange?: (e: OnStateChangeEvent) => void;
      onError?: (e: OnErrorEvent) => void;
      onAutoplayBlocked?: () => void;
    };
  }
  class Player {
    constructor(el: HTMLElement, opts: PlayerOptions);
    loadVideoById(args: { videoId: string; startSeconds: number }): void;
    stopVideo(): void;
    seekTo(seconds: number, allowSeekAhead: boolean): void;
    playVideo(): void;
    mute(): void;
    unMute(): void;
    setVolume(v: number): void;
    getCurrentTime(): number;
    getDuration(): number;
    getPlayerState(): number;
    destroy(): void;
  }
}

interface Window {
  YT?: typeof YT;
  onYouTubeIframeAPIReady?: () => void;
}
