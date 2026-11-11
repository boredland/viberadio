import { useSyncExternalStore } from "react";

/**
 * Opt-in "real" equalizer. The YouTube iframe exposes no audio, so this listens to what the browser itself plays: the user
 * shares THIS tab with its audio, and an AnalyserNode reads the shared track. Nothing is recorded, stored or sent anywhere,
 * and the capture is never routed back to the speakers (that would double the sound), so playback is unaffected.
 *
 * Chromium on desktop only (Firefox and Safari give no audio track for getDisplayMedia, so the toggle is hidden there; phones
 * have no tab audio). The picker is browser UI and the user can stop at any time from the browser's own "Stop sharing" bar.
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
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function" &&
    !isTouchOnly() &&
    hasTabAudioCapture()
  );
}

/**
 * Only Chromium returns an audio track from getDisplayMedia for a shared tab. Firefox exposes the method but never returns
 * audio (Mozilla bug 1541425, open since 2019), and desktop Safari does the same, so for both the toggle could only end in an
 * error note. CaptureController ships in Chromium alone, which makes it a feature test for exactly that family (it is not
 * about zoom control, only a marker); a user-agent sniff would miss Safari and can be spoofed. If Firefox or Safari ever ship
 * tab audio, replace this with a check that does not exclude them.
 */
function hasTabAudioCapture(): boolean {
  return "CaptureController" in window;
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

/** Bumped by every stop and every start. A start that resolves after a stop sees a different number and cleans up after itself. */
let generation = 0;

/** Teardown without a verdict: leaving the page, or a start being replaced. The listener has not said no. */
export function stopTabAudio(): void {
  generation++;
  teardown();
  set({ status: "off" });
}

/** The listener turned real EQ off (button or the browser's own "Stop sharing"): stop, and do not ask again automatically. */
export function turnOffTabAudio(): void {
  rememberAuto(false);
  stopTabAudio();
}

const AUTO_KEY = "viberadio:real-eq-auto";

function autoAllowed(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== "0";
  } catch {
    return true;
  }
}

function rememberAuto(on: boolean): void {
  try {
    localStorage.setItem(AUTO_KEY, on ? "1" : "0");
  } catch {
    // storage unavailable: asking again next visit is the harmless outcome
  }
}

/**
 * Asks to share the tab when the listener tunes in. getDisplayMedia needs a click, and Tune In is one, so this must be called
 * synchronously from that handler. Does nothing where tab audio is impossible, or after the listener declined or turned it
 * off; the REAL EQ button still works then. The browser cannot remember a share across reloads, so it asks on each visit.
 */
export async function autoStartTabAudio(): Promise<void> {
  if (!tabAudioSupported() || !autoAllowed()) return;
  await startTabAudio({ automatic: true });
}

/** A context created after an await can come up "suspended" and a suspended resume() may stay pending; never wait forever. */
const RESUME_TIMEOUT_MS = 3000;

function resumeWithin(c: AudioContext, ms: number): Promise<void> {
  return Promise.race([
    c.resume(),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error("audio context resume timed out")), ms)),
  ]);
}

/**
 * Must run inside a click handler: getDisplayMedia needs a user gesture, and an `await` before it can lose that gesture.
 */
export async function startTabAudio(opts: { automatic?: boolean } = {}): Promise<void> {
  if (state.status === "starting" || state.status === "on") return;
  if (!tabAudioSupported()) return set({ status: "failed", reason: "unsupported" });
  const gen = ++generation;
  set({ status: "starting" });
  // Everything this call acquired, so an abandoned start (the listener left while the picker was open) releases it all.
  let acquired: MediaStream | null = null;
  let acquiredCtx: AudioContext | null = null;
  const abandoned = () => gen !== generation;
  const release = () => {
    acquired?.getTracks().forEach((t) => t.stop());
    void acquiredCtx?.close().catch(() => {});
  };
  try {
    // Video is required by Chrome even when only the audio is wanted; the video track is disabled right after.
    const s = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      selfBrowserSurface: "include",
      preferCurrentTab: true,
      systemAudio: "exclude",
      surfaceSwitching: "exclude",
    } as DisplayMediaStreamOptions);
    acquired = s;
    if (abandoned()) return release();

    // The video was only the price of admission. Disabled, not stopped: in some setups stopping the video track ends the
    // whole share. teardown() stops every track when capture ends, so nothing is left running.
    s.getVideoTracks().forEach((t) => (t.enabled = false));
    const track = s.getAudioTracks()[0];
    if (!track) {
      release();
      return set({ status: "failed", reason: "no-audio" });
    }

    // "Stop sharing" in the browser bar is the listener turning it off: remember that, so the next visit does not ask again.
    track.addEventListener("ended", () => {
      if (stream === s) turnOffTabAudio();
    });

    const c = new AudioContext();
    acquiredCtx = c;
    // Created after an await, so the click's user activation may be spent and the context can start "suspended". A suspended
    // analyser reads all zeros while the toggle claims success, which is the worst failure to show: resume, then verify.
    await resumeWithin(c, RESUME_TIMEOUT_MS);
    if (abandoned()) return release();
    if (c.state !== "running") throw new Error("audio context did not start");

    const src = c.createMediaStreamSource(s);
    const a = c.createAnalyser();
    // 2048 gives ~23 Hz bins at 48 kHz. At 512 (~94 Hz) the log-spaced low bars each span less than one bin, so a single bass
    // note lit ten bars at once.
    a.fftSize = 2048;
    // The default window tops out at -30 dBFS, so anything louder pins a bar at full scale and loud music reads as a flat wall.
    // -90..-10 keeps headroom: a moderately loud tone lands mid-scale and only genuinely hot peaks reach the top.
    a.minDecibels = -90;
    a.maxDecibels = -10;
    a.smoothingTimeConstant = 0.3;
    // Analyser only: deliberately not connected to ctx.destination, so the captured copy never plays a second time.
    src.connect(a);

    // "Stop sharing" during the resume wait ends the track before `stream` is published, so the listener above saw nothing.
    // Publishing it would show REAL EQ as on over silent bars, so refuse a track that is already dead.
    if (track.readyState === "ended") {
      release();
      return set({ status: "off" });
    }

    // Published only now that the whole chain is live, so a failure above never leaves half of it behind.
    stream = s;
    ctx = c;
    analyser = a;
    bins = new Uint8Array(new ArrayBuffer(a.frequencyBinCount));
    // A listener who shared once is happy to be asked again; this also re-enables asking after an earlier refusal.
    rememberAuto(true);
    set({ status: "on" });
  } catch (err) {
    release();
    if (abandoned()) return;
    teardown();
    const name = (err as DOMException)?.name;
    const reason = name === "NotAllowedError" || name === "AbortError" ? "denied" : "error";
    // Declining the browser's prompt is an answer: do not ask again on every visit.
    if (reason === "denied") rememberAuto(false);
    // Cancelling a prompt the listener never asked for is their answer, not an error to report. Only a manual click that
    // is cancelled shows the "Sharing was cancelled" note.
    set(reason === "denied" && opts.automatic ? { status: "off" } : { status: "failed", reason });
  }
}

/**
 * 0..1 level for each of the 20 bars, or null when capture is not running. Bars are log-spaced across 60 Hz to 14 kHz, since
 * music energy sits at the low end and linear buckets would leave most bars idle.
 */
export function readLevels(): Float32Array | null {
  if (state.status !== "on" || !analyser || !bins || !ctx) return null;
  analyser.getByteFrequencyData(bins);
  const hzPerBin = ctx.sampleRate / analyser.fftSize;
  const lo = 60;
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
