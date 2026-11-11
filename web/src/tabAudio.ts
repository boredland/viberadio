import { useSyncExternalStore } from "react";

/**
 * Opt-in "real" equalizer. The YouTube iframe exposes no audio, so this listens to what the browser itself plays: the user
 * shares THIS tab with its audio, and an AnalyserNode reads the shared track. Nothing is recorded, stored or sent anywhere,
 * and the capture is never routed back to the speakers (that would double the sound), so playback is unaffected.
 *
 * Chromium on desktop only (Firefox and Safari give no tab audio, phones have no getDisplayMedia). The picker is browser UI
 * and the user can stop at any time from the browser's own "Stop sharing" bar.
 */

export type TabAudioState =
  | { status: "off" }
  | { status: "starting" }
  | { status: "on" }
  | { status: "failed"; reason: "unsupported" | "denied" | "no-audio" | "error" };

const BARS = 20;

let state: TabAudioState = { status: "off" };
const listeners = new Set<() => void>();
const set = (s: TabAudioState) => {
  state = s;
  listeners.forEach((l) => l());
};

let stream: MediaStream | null = null;
let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let bins: Uint8Array<ArrayBuffer> | null = null;
const levels = new Float32Array(BARS);

export function tabAudioSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function" && !isTouchOnly();
}

/** Phones and tablets expose no tab audio even where getDisplayMedia exists; do not offer a toggle that cannot work. */
function isTouchOnly(): boolean {
  return window.matchMedia("(pointer: coarse)").matches && !window.matchMedia("(any-pointer: fine)").matches;
}

/** What to tell the listener when the toggle did not take. Each case has a different fix, so they are worded apart. */
export function tabAudioMessage(reason: "unsupported" | "denied" | "no-audio" | "error"): string {
  switch (reason) {
    case "unsupported":
      return "Real EQ needs desktop Chrome or Edge.";
    case "denied":
      return "Sharing was cancelled, so the bars stay on the beat pulse.";
    case "no-audio":
      return 'Pick this tab and tick "Share tab audio" in the browser prompt.';
    default:
      return "Couldn't start real EQ. The bars stay on the beat pulse.";
  }
}

function teardown(): void {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  analyser = null;
  bins = null;
  levels.fill(0);
  void ctx?.close().catch(() => {});
  ctx = null;
}

export function stopTabAudio(): void {
  teardown();
  set({ status: "off" });
}

/**
 * Must run inside a click handler: getDisplayMedia needs a user gesture, and an `await` before it can lose that gesture.
 */
export async function startTabAudio(): Promise<void> {
  if (state.status === "starting" || state.status === "on") return;
  if (!tabAudioSupported()) return set({ status: "failed", reason: "unsupported" });
  set({ status: "starting" });
  try {
    // Video is required by Chrome even when only the audio is wanted; the video track is dropped right after.
    // suppressLocalAudioPlayback stays false: true would mute the tab for the listener who is capturing it.
    const s = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      selfBrowserSurface: "include",
      preferCurrentTab: true,
      systemAudio: "exclude",
      surfaceSwitching: "exclude",
      suppressLocalAudioPlayback: false,
    } as DisplayMediaStreamOptions);

    // The video was only the price of admission. Disabled, not stopped: in some setups stopping the video track ends the
    // whole share. teardown() stops every track when capture ends, so nothing is left running.
    s.getVideoTracks().forEach((t) => (t.enabled = false));
    const track = s.getAudioTracks()[0];
    if (!track) {
      s.getTracks().forEach((t) => t.stop());
      return set({ status: "failed", reason: "no-audio" });
    }

    stream = s;
    // "Stop sharing" in the browser bar ends the track: fall back to the synthetic bars instead of showing silence.
    track.addEventListener("ended", () => {
      if (stream) stopTabAudio();
    });

    ctx = new AudioContext();
    // Created after an await, so the click's user activation may be spent and the context can start "suspended". A suspended
    // analyser reads all zeros while the toggle claims success, which is the worst failure to show: resume, then verify.
    await ctx.resume();
    if (ctx.state !== "running") throw new Error("audio context did not start");
    const src = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    // 2048 gives ~23 Hz bins at 48 kHz. At 512 (~94 Hz) the log-spaced low bars each span less than one bin, so a single bass
    // note lit ten bars at once.
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.6;
    bins = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    // Analyser only: deliberately not connected to ctx.destination, so the captured copy never plays a second time.
    src.connect(analyser);
    set({ status: "on" });
  } catch (err) {
    teardown();
    const name = (err as DOMException)?.name;
    set({ status: "failed", reason: name === "NotAllowedError" || name === "AbortError" ? "denied" : "error" });
  }
}

/**
 * 0..1 level for each of the 20 bars, or null when capture is not running. Bars are log-spaced across 40 Hz to 14 kHz, since
 * music energy sits at the low end and linear buckets would leave most bars idle.
 */
export function readLevels(): Float32Array | null {
  if (state.status !== "on" || !analyser || !bins || !ctx) return null;
  analyser.getByteFrequencyData(bins);
  const hzPerBin = ctx.sampleRate / analyser.fftSize;
  const lo = 40;
  const hi = Math.min(14000, ctx.sampleRate / 2);
  for (let i = 0; i < BARS; i++) {
    const f0 = lo * Math.pow(hi / lo, i / BARS);
    const f1 = lo * Math.pow(hi / lo, (i + 1) / BARS);
    const b0 = Math.max(0, Math.floor(f0 / hzPerBin));
    const b1 = Math.min(bins.length - 1, Math.max(b0, Math.ceil(f1 / hzPerBin)));
    let max = 0;
    for (let b = b0; b <= b1; b++) if (bins[b] > max) max = bins[b];
    // Treble is quieter in real music; a gentle tilt keeps the right-hand bars alive.
    levels[i] = Math.min(1, (max / 255) * (1 + (i / BARS) * 0.5));
  }
  return levels;
}

export function useTabAudio(): TabAudioState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => state,
  );
}
