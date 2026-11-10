import type { CurrentTrack } from "../../shared/protocol";

/**
 * Lock-screen / notification metadata and Next. Without an active media session mobile browsers treat the page as
 * background content and suspend it much sooner; with one, the OS keeps it alive as "playing audio".
 * Only Next is wired: play/pause/seek would let one listener desync themselves from the station clock.
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
