/** `bands` holds one smoothed 0..1 level per spectrum bar, bass first. It is the drive's own array: read it per frame, never keep it. */
export type Drive = { bass: number; treble: number; bands: Float32Array };

/** Share of the bars that count as low end and as high end. Bars are log-spaced, so 30% each side is ~60-300 Hz and ~2.6-14 kHz. */
const BAND = 0.3;

/**
 * The backdrop fills the screen, so a hard full-strength flash per kick is a photosensitivity risk (WCAG 2.3.1 limits
 * flashes to three per second). The bass pulse is capped well below full (0.4), rises over ~30 ms and falls over ~250 ms,
 * which rounds off the edges a raw per-frame value would have and keeps the full-screen effect gentle.
 */
const BASS_CAP = 0.4;
const ATTACK_MS = 30;
const RELEASE_MS = 250;
/** How slowly the bass baseline follows the music: a kick is the jump above it, so steady loud bass reads as quiet. */
const BASELINE_MS = 1500;
/** A tab that was in the background sends one huge step; treat it as one normal frame. */
const MAX_STEP_MS = 100;

/** The glints should snap up with a note and trail off a little slower, like a classic EQ bar. */
const BAND_ATTACK_MS = 30;
const BAND_RELEASE_MS = 160;

/** One-pole smoothing toward `target`, quick going up and slow going down. Time-based, so the frame rate does not matter. */
function follow(value: number, target: number, dt: number): number {
  const tau = target > value ? ATTACK_MS : RELEASE_MS;
  return value + (target - value) * (1 - Math.exp(-dt / tau));
}

/**
 * Turns the per-bar levels into two numbers the backdrop paints with. `bass` is how far the low end jumps above its own
 * slow average (a kick), never the raw loudness, so loud music does not hold the glow at full. `treble` is the smoothed
 * high end, for star shimmer on a few pixels. The returned object is reused: read it once per frame and do not keep it.
 */
export function createDrive(): (levels: Float32Array | null, now: number) => Drive | null {
  let avg = 0;
  let bass = 0;
  let treble = 0;
  let last = -1;
  const out: Drive = { bass: 0, treble: 0, bands: new Float32Array(0) };
  return (levels, now) => {
    if (!levels) {
      avg = bass = treble = 0;
      out.bands.fill(0);
      last = -1;
      return null;
    }
    const dt = last < 0 ? 16 : Math.min(MAX_STEP_MS, Math.max(0, now - last));
    last = now;
    const n = Math.max(1, Math.round(levels.length * BAND));
    let low = 0;
    let high = 0;
    for (let i = 0; i < n; i++) low = Math.max(low, levels[i]);
    for (let i = levels.length - n; i < levels.length; i++) high = Math.max(high, levels[i]);
    const jump = Math.max(0, (low - avg) * 3);
    avg += (low - avg) * (1 - Math.exp(-dt / BASELINE_MS));
    bass = follow(bass, Math.min(1, jump) * BASS_CAP, dt);
    treble = follow(treble, high, dt);
    if (out.bands.length !== levels.length) out.bands = new Float32Array(levels.length);
    for (let i = 0; i < levels.length; i++) {
      const b = out.bands[i];
      const tau = levels[i] > b ? BAND_ATTACK_MS : BAND_RELEASE_MS;
      out.bands[i] = b + (levels[i] - b) * (1 - Math.exp(-dt / tau));
    }
    out.bass = bass;
    out.treble = treble;
    return out;
  };
}
