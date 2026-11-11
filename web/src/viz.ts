import { colors } from "./theme";

export const BARS = 20;
/** Columns of history the waterfall keeps; one per frame, so about 2.4 s at the display's 33 ms frame step. */
export const HISTORY = 72;

export const VIZ_MODES = [
  { id: "bars", label: "BARS" },
  { id: "mirror", label: "MIRROR" },
  { id: "curve", label: "CURVE" },
  { id: "dots", label: "DOTS" },
  { id: "waterfall", label: "WATERFALL" },
] as const;

export type VizId = (typeof VIZ_MODES)[number]["id"];

/** What every display reads: smoothed 0..1 level and falling peak per band (bass first), plus recent frames for the waterfall. */
export type VizState = {
  level: number[];
  peak: number[];
  /** Ring buffer of past `level` frames; `head` is the newest. */
  history: number[][];
  head: number;
};

export const newVizState = (): VizState => ({
  level: new Array<number>(BARS).fill(0),
  peak: new Array<number>(BARS).fill(0),
  history: Array.from({ length: HISTORY }, () => new Array<number>(BARS).fill(0)),
  head: 0,
});

const KEY = "viberadio:viz";

/** Whatever is in storage is untrusted (an old build, a hand edit): anything that is not a known mode falls back to bars. */
export function loadViz(): VizId {
  try {
    const raw = localStorage.getItem(KEY);
    return VIZ_MODES.find((m) => m.id === raw)?.id ?? "bars";
  } catch {
    return "bars";
  }
}

export function saveViz(id: VizId): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // private mode / storage disabled: the choice holds for this visit only
  }
}

export function nextViz(id: VizId): VizId {
  const i = VIZ_MODES.findIndex((m) => m.id === id);
  return VIZ_MODES[(i + 1) % VIZ_MODES.length].id;
}

export const vizLabel = (id: VizId): string => VIZ_MODES.find((m) => m.id === id)?.label ?? "";

type Paint = (ctx: CanvasRenderingContext2D, w: number, h: number, s: VizState) => void;

/** Colour by how loud: the same three steps the bars always used. */
function tier(c: ReturnType<typeof colors>, lvl: number): string {
  return lvl < 0.6 ? c.accent : lvl < 0.8 ? c.vizMid : c.vizHi;
}

const bars: Paint = (ctx, w, h, s) => {
  const c = colors();
  const bw = w / BARS;
  for (let i = 0; i < BARS; i++) {
    const segs = Math.round(s.level[i] * 10);
    for (let k = 0; k < segs; k++) {
      ctx.fillStyle = k < 6 ? c.accent : k < 8 ? c.vizMid : c.vizHi;
      ctx.fillRect(i * bw + 1, h - (k + 1) * (h / 10) + 1, bw - 2, h / 10 - 1);
    }
    const p = Math.round(s.peak[i] * 10);
    if (p > 0) {
      ctx.fillStyle = c.peak;
      ctx.fillRect(i * bw + 1, h - p * (h / 10), bw - 2, 2);
    }
  }
};

/** Bass in the middle, treble at both edges, each bar growing up and down from the centre line. */
const mirror: Paint = (ctx, w, h, s) => {
  const c = colors();
  const cols = BARS * 2;
  const cw = w / cols;
  const cy = h / 2;
  for (let i = 0; i < cols; i++) {
    const band = i < BARS ? BARS - 1 - i : i - BARS;
    const half = s.level[band] * (cy - 1);
    ctx.fillStyle = tier(c, s.level[band]);
    if (half >= 0.5) ctx.fillRect(i * cw + 0.5, cy - half, cw - 1, half * 2);
    const cap = s.peak[band] * (cy - 1);
    if (cap > 1.5) {
      ctx.fillStyle = c.peak;
      ctx.fillRect(i * cw + 0.5, cy - cap - 1, cw - 1, 1.5);
      ctx.fillRect(i * cw + 0.5, cy + cap - 0.5, cw - 1, 1.5);
    }
  }
};

/** A smooth filled spectrum with a line on top and a dot where each peak sits. */
const curve: Paint = (ctx, w, h, s) => {
  const c = colors();
  const step = w / (BARS - 1);
  const pts = s.level.map((v, i) => [i * step, h - 2 - v * (h - 7)] as const);
  ctx.beginPath();
  ctx.moveTo(0, h);
  ctx.lineTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    const mx = (pts[i - 1][0] + pts[i][0]) / 2;
    const my = (pts[i - 1][1] + pts[i][1]) / 2;
    ctx.quadraticCurveTo(pts[i - 1][0], pts[i - 1][1], mx, my);
  }
  ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  ctx.lineTo(w, h);
  ctx.closePath();
  const fill = ctx.createLinearGradient(0, 0, 0, h);
  fill.addColorStop(0, `rgba(${c.accentRgb}, 0.6)`);
  fill.addColorStop(1, `rgba(${c.accentRgb}, 0.05)`);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = c.accent;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    const mx = (pts[i - 1][0] + pts[i][0]) / 2;
    const my = (pts[i - 1][1] + pts[i][1]) / 2;
    ctx.quadraticCurveTo(pts[i - 1][0], pts[i - 1][1], mx, my);
  }
  ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  ctx.stroke();
  ctx.fillStyle = c.peak;
  for (let i = 0; i < BARS; i++) {
    if (s.peak[i] > 0.05) ctx.fillRect(i * step - 1, h - 2 - s.peak[i] * (h - 7) - 3, 2, 2);
  }
};

/** An LED matrix: eight rows of round lamps per band, lit from the bottom, with a lit peak lamp. */
const dots: Paint = (ctx, w, h, s) => {
  const c = colors();
  const rows = 8;
  const cw = w / BARS;
  const ch = h / rows;
  const r = Math.max(1, Math.min(cw, ch) / 2 - 1);
  for (let i = 0; i < BARS; i++) {
    const lit = Math.round(s.level[i] * rows);
    const peakRow = Math.round(s.peak[i] * rows);
    for (let k = 0; k < rows; k++) {
      const cx = i * cw + cw / 2;
      const cy = h - (k + 0.5) * ch;
      if (k < lit) ctx.fillStyle = k < 5 ? c.accent : k < 7 ? c.vizMid : c.vizHi;
      else if (k === peakRow - 1 && peakRow > 0) ctx.fillStyle = c.peak;
      else ctx.fillStyle = `rgba(${c.accentRgb}, 0.13)`;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
};

/**
 * Time runs left to right, newest on the right; each row is a band (bass at the bottom). Loudness is a continuous ramp from a
 * dim accent to the bright peak colour: the three loudness steps the bars use turned a loud steady sound into one flat red
 * wash, hiding which bands and moments were loudest.
 */
const waterfall: Paint = (ctx, w, h, s) => {
  const c = colors();
  const colW = w / HISTORY;
  const rowH = h / BARS;
  for (let col = 0; col < HISTORY; col++) {
    const frame = s.history[(s.head + 1 + col) % HISTORY];
    for (let b = 0; b < BARS; b++) {
      const lvl = frame[b];
      if (lvl < 0.04) continue;
      ctx.fillStyle = `rgba(${c.accentRgb}, ${(0.08 + 0.72 * lvl * lvl).toFixed(3)})`;
      ctx.fillRect(col * colW, h - (b + 1) * rowH, colW + 0.5, rowH + 0.5);
      // Only the hottest cells get the peak colour, so a loud moment shows as a bright streak instead of a blanket.
      if (lvl > 0.85) {
        ctx.globalAlpha = Math.min(1, (lvl - 0.85) * 5);
        ctx.fillStyle = c.peak;
        ctx.fillRect(col * colW, h - (b + 1) * rowH, colW + 0.5, rowH + 0.5);
        ctx.globalAlpha = 1;
      }
    }
  }
};

export const PAINTERS: Record<VizId, Paint> = { bars, mirror, curve, dots, waterfall };
