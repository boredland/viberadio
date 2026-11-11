/** Beats elapsed on the station clock, or null while nothing plays or the clock is not synced yet. */
type BeatSource = () => number | null;

let source: BeatSource | null = null;

export function setBeatSource(s: BeatSource | null): void {
  source = s;
}

/** The current beat position (a float; fractional part = position within the beat), or null when nothing plays. */
export function getBeat(): number | null {
  return source?.() ?? null;
}
