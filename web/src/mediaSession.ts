import type { CurrentTrack } from "../../shared/protocol";

/**
 * Lock-screen / notification metadata and Next, set on the top-level page.
 * The audio is produced inside YouTube's cross-origin iframe, and which frame the OS media controls attach to is
 * browser-dependent: these may be ignored or overridden by the iframe's own session. Treat them as best-effort.
 * Only Next and Play are wired: pause/seek would let one listener desync themselves from the station clock.
 */
export function setNowPlaying(track: CurrentTrack | null): void {
  if (!("mediaSession" in navigator)) return;
  if (!track) {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = "none";
    return;
  }
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.author,
    album: "viberadio",
    artwork: track.thumbnailUrl ? [{ src: track.thumbnailUrl, sizes: "480x360", type: "image/jpeg" }] : [],
  });
  navigator.mediaSession.playbackState = "playing";
}

export function bindMediaKeys(onNext: () => void): () => void {
  if (!("mediaSession" in navigator)) return () => {};
  navigator.mediaSession.setActionHandler("nexttrack", onNext);
  return () => navigator.mediaSession.setActionHandler("nexttrack", null);
}

/** Lets the lock-screen play button resume a paused local player (the station clock keeps running regardless). */
export function bindPlay(onPlay: () => void): () => void {
  if (!("mediaSession" in navigator)) return () => {};
  navigator.mediaSession.setActionHandler("play", onPlay);
  return () => navigator.mediaSession.setActionHandler("play", null);
}
