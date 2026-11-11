/** Winamp-style graphic equalizer: a preamp and ten peaking bands, with the classic centre frequencies. */

export const EQ_FREQS = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000] as const;
export const EQ_BANDS = EQ_FREQS.length;
export const EQ_MAX_DB = 12;
/** The preamp must reach as low as the loudest preset needs (-14 dB for TREBLE) and keeps the same upper bound as the bands. */
export const PREAMP_MIN_DB = -20;
/** About one octave wide at each centre, so neighbouring sliders overlap the way Winamp's do. */
const BAND_Q = 1.4;
/** Moving a slider ramps over a few ms; setting the value outright clicks. */
const RAMP_S = 0.015;

export type EqSettings = { preamp: number; bands: number[] };

export const FLAT: EqSettings = { preamp: 0, bands: new Array(EQ_BANDS).fill(0) };

/**
 * Neighbouring bands overlap, so a preset's loudest point is higher than any one slider. Each preamp is the measured peak
 * of its curve (offline, 48 kHz, sine sweep) rounded up, so a preset never pushes a full-scale track past 0 dBFS.
 */
export const PRESETS: { name: string; settings: EqSettings }[] = [
  { name: "FLAT", settings: FLAT },
  { name: "BASS", settings: { preamp: -8, bands: [7, 6, 4, 2, 0, 0, 0, 0, 0, 0] } },
  { name: "TREBLE", settings: { preamp: -14, bands: [0, 0, 0, 0, 0, 1, 3, 5, 6, 7] } },
  { name: "ROCK", settings: { preamp: -11, bands: [5, 3, 2, -1, -2, 0, 3, 4, 5, 5] } },
  { name: "POP", settings: { preamp: -7, bands: [-1, 2, 4, 5, 3, 0, -1, -1, 1, 1] } },
  { name: "VOCAL", settings: { preamp: -7, bands: [-3, -2, 0, 3, 5, 5, 3, 1, 0, -1] } },
];

const clampDb = (v: number): number => Math.max(-EQ_MAX_DB, Math.min(EQ_MAX_DB, v));
const clampPreamp = (v: number): number => Math.max(PREAMP_MIN_DB, Math.min(EQ_MAX_DB, v));
const dbToGain = (db: number): number => Math.pow(10, db / 20);

const KEY = "viberadio:eq";

/** Storage is untrusted (an old build, a hand edit): anything that is not a well-formed setting falls back to flat. */
export function loadEq(): EqSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return clone(FLAT);
    const v = JSON.parse(raw) as Partial<EqSettings> | null;
    if (!v || !Array.isArray(v.bands) || v.bands.length !== EQ_BANDS) return clone(FLAT);
    if (typeof v.preamp !== "number" || !v.bands.every((b) => typeof b === "number" && Number.isFinite(b))) return clone(FLAT);
    if (!Number.isFinite(v.preamp)) return clone(FLAT);
    return { preamp: clampPreamp(v.preamp), bands: v.bands.map(clampDb) };
  } catch {
    return clone(FLAT);
  }
}

export function saveEq(s: EqSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // private mode / storage disabled: the curve holds for this visit only
  }
}

export function clone(s: EqSettings): EqSettings {
  return { preamp: s.preamp, bands: [...s.bands] };
}

export type EqChain = {
  setBand(i: number, db: number): void;
  setPreamp(db: number): void;
  /** Linear gain for the whole chain: the station's volume and mute, since YouTube's own player must stay at full level. */
  setOutput(gain: number): void;
  disconnect(): void;
};

/**
 * input -> preamp -> 10 peaking filters -> master gain -> output. Works on a live or an offline context, so the filter
 * maths can be checked without a sound card.
 */
export function buildChain(ctx: BaseAudioContext, input: AudioNode, output: AudioNode, s: EqSettings, outputGain = 1): EqChain {
  const preamp = ctx.createGain();
  preamp.gain.value = dbToGain(clampPreamp(s.preamp));
  const filters = EQ_FREQS.map((f, i) => {
    const node = ctx.createBiquadFilter();
    node.type = "peaking";
    node.frequency.value = f;
    node.Q.value = BAND_Q;
    node.gain.value = clampDb(s.bands[i] ?? 0);
    return node;
  });
  const master = ctx.createGain();
  master.gain.value = outputGain;

  input.connect(preamp);
  let prev: AudioNode = preamp;
  for (const f of filters) {
    prev.connect(f);
    prev = f;
  }
  prev.connect(master);
  master.connect(output);

  const ramp = (p: AudioParam, v: number) => p.setTargetAtTime(v, ctx.currentTime, RAMP_S);
  return {
    setBand: (i, db) => {
      if (i >= 0 && i < EQ_BANDS) ramp(filters[i].gain, clampDb(db));
    },
    setPreamp: (db) => ramp(preamp.gain, dbToGain(clampPreamp(db))),
    setOutput: (g) => ramp(master.gain, Math.max(0, g)),
    disconnect: () => {
      for (const n of [preamp, ...filters, master]) n.disconnect();
    },
  };
}
