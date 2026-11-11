const KEY = "viberadio:volume";
export const DEFAULT_VOLUME = 80;

/** Whatever is in storage is untrusted (an old build, a hand edit): anything that is not a 0-100 number falls back. */
export function loadVolume(): number {
  try {
    const raw = localStorage.getItem(KEY);
    // Number(null), Number("") and Number("  ") are all 0, which would silently restore "muted" for a first-time visitor or a
    // blanked entry. Only an actual numeric string counts as a saved choice.
    if (raw === null || raw.trim() === "") return DEFAULT_VOLUME;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 && v <= 100 ? Math.round(v) : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME;
  }
}

export function saveVolume(v: number): void {
  try {
    localStorage.setItem(KEY, String(Math.round(v)));
  } catch {
    // private mode / storage disabled: the level holds for this visit only
  }
}
