export type Drive = { bass: number; treble: number };

/** Share of the bars that count as low end and as high end. Bars are log-spaced, so 30% each side is ~60-300 Hz and ~2.6-14 kHz. */
const BAND = 0.3;

/**
 * Turns the per-bar levels into two numbers the backdrop can paint with. Loud music sits near full scale on the low bars
 * all the time, so the bass value follows how far the low end jumps above its own recent average (a kick), with a small
 * loudness term on top. Treble just decays slowly so the stars shimmer instead of flickering. The returned object is
 * reused: it is read once per frame and never kept.
 */
export function createDrive(): (levels: Float32Array | null) => Drive | null {
  let avg = 0;
  let kick = 0;
  let treble = 0;
  const out: Drive = { bass: 0, treble: 0 };
  return (levels) => {
    if (!levels) {
      avg = kick = treble = 0;
      return null;
    }
    const n = Math.max(1, Math.round(levels.length * BAND));
    let bass = 0;
    let high = 0;
    for (let i = 0; i < n; i++) bass = Math.max(bass, levels[i]);
    for (let i = levels.length - n; i < levels.length; i++) high = Math.max(high, levels[i]);
    kick = Math.max(kick * 0.88, (bass - avg) * 3);
    avg += (bass - avg) * 0.03;
    treble = Math.max(treble * 0.9, high);
    out.bass = Math.min(1, kick + 0.3 * bass);
    out.treble = treble;
    return out;
  };
}
