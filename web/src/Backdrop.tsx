import { useEffect, useRef } from "react";
import { colors, useLook, type BackgroundId } from "./theme";
import { reducedMotion } from "./ui";

/** Beats elapsed on the station clock, or null while nothing plays or the clock is not synced yet. */
type BeatSource = () => number | null;

let beatSource: BeatSource | null = null;

export function setBeatSource(source: BeatSource | null): void {
  beatSource = source;
}

/**
 * The YouTube iframe exposes no audio data, so the backdrop cannot follow the music itself. This is a stable per-track
 * tempo (84-128 BPM, from the video id) counted on the station clock: every listener sees the same pulse at the same moment.
 */
export function bpmFor(videoId: string): number {
  let h = 0;
  for (let i = 0; i < videoId.length; i++) h = (h * 31 + videoId.charCodeAt(i)) >>> 0;
  return 84 + (h % 45);
}

// Seeded so the sky looks the same on every load and for every listener.
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STARS = (() => {
  const rnd = seeded(80);
  return Array.from({ length: 70 }, () => ({ x: rnd(), y: rnd() * 0.85, phase: rnd() * 6.28, size: rnd() < 0.15 ? 2 : 1 }));
})();

/** Kick-shaped envelope: full strength on the beat, fast decay. */
const envelope = (beat: number | null): number => (beat === null ? 0 : Math.exp(-(beat - Math.floor(beat)) * 5));

/**
 * A scene is built for one canvas size and returns its frame painter. State that lives across frames (the matrix columns)
 * belongs to the painter, so a resize starts it fresh.
 */
type Painter = (ctx: CanvasRenderingContext2D, t: number, beat: number | null) => void;
type Scene = (w: number, h: number) => Painter;

const HORIZON = 0.64;
const GRID_ROWS = 14;

function paintSunset(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, beat: number | null): void {
  const hy = h * HORIZON;
  const cx = w / 2;
  const pulse = envelope(beat);

  const sky = ctx.createLinearGradient(0, 0, 0, hy);
  sky.addColorStop(0, "#08011c");
  sky.addColorStop(0.45, "#3a0b5e");
  sky.addColorStop(0.75, "#c2236f");
  sky.addColorStop(1, "#ff7a4d");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, hy);

  for (const s of STARS) {
    const a = (0.35 + 0.35 * Math.sin(t / 700 + s.phase)) * (1 - s.y / 0.85);
    ctx.fillStyle = `rgba(255,255,255,${a})`;
    ctx.fillRect(s.x * w, s.y * hy, s.size, s.size);
  }

  const r = Math.min(w * 0.38, hy * 0.34) * (1 + 0.03 * pulse);
  const cy = hy - r * 0.8;

  const glow = ctx.createRadialGradient(cx, cy, r * 0.5, cx, cy, r * 2.4);
  glow.addColorStop(0, `rgba(255,70,150,${0.4 + 0.3 * pulse})`);
  glow.addColorStop(1, "rgba(255,70,150,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, hy);

  // The sun: a disc whose lower half is cut by gaps that widen toward the bottom. Two nested clips (disc, then bands).
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.beginPath();
  let y = cy - r;
  for (let k = 0; k < 7; k++) {
    const gapStart = cy + r * (0.15 + k * 0.13);
    ctx.rect(cx - r, y, r * 2, gapStart - y);
    y = gapStart + r * (0.025 + k * 0.013);
  }
  ctx.rect(cx - r, y, r * 2, cy + r - y);
  ctx.clip();
  const body = ctx.createLinearGradient(0, cy - r, 0, cy + r);
  body.addColorStop(0, "#fff27a");
  body.addColorStop(0.5, "#ffa13d");
  body.addColorStop(1, "#ff2e88");
  ctx.fillStyle = body;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  ctx.restore();

  const floor = ctx.createLinearGradient(0, hy, 0, h);
  floor.addColorStop(0, "#2b0646");
  floor.addColorStop(1, "#06000f");
  ctx.fillStyle = floor;
  ctx.fillRect(0, hy, w, h - hy);

  const boost = 1 + 0.9 * pulse;
  // Rows travel toward the viewer one row per four beats. One extra row is drawn past the bottom edge, so the row that
  // wraps back in at the horizon (hidden under the horizon line) and the one leaving at the bottom never pop on screen.
  const drift = beat === null ? (t / 9000) % 1 : (((beat / 4) % 1) + 1) % 1;
  ctx.lineWidth = 1.5;
  for (let i = 0; i <= GRID_ROWS; i++) {
    const z = (i + drift) / GRID_ROWS;
    const ry = hy + (h - hy) * z * z;
    ctx.strokeStyle = `rgba(255,80,210,${Math.min(1, (0.12 + 0.6 * z) * boost)})`;
    ctx.beginPath();
    ctx.moveTo(0, ry);
    ctx.lineTo(w, ry);
    ctx.stroke();
  }

  const spread = Math.max(w, 720) * 0.09;
  const cols = ctx.createLinearGradient(0, hy, 0, h);
  cols.addColorStop(0, "rgba(255,80,210,0)");
  cols.addColorStop(1, `rgba(255,80,210,${Math.min(1, 0.7 * boost)})`);
  ctx.strokeStyle = cols;
  ctx.beginPath();
  for (let i = -20; i <= 20; i++) {
    ctx.moveTo(cx, hy);
    ctx.lineTo(cx + i * spread, h);
  }
  ctx.stroke();

  ctx.strokeStyle = `rgba(255,170,230,${0.7 + 0.3 * pulse})`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, hy);
  ctx.lineTo(w, hy);
  ctx.stroke();
}

const GLYPHS = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄ0123456789<>/\\{}[]=+*#$%";
const MATRIX_STEP_MS = 60;
const MATRIX_SIZE = 16;

/** Falling glyphs in the theme's accent colour; they brighten on the beat. */
const matrixScene: Scene = (w, h) => {
  // Columns start off-screen so they rain in from the top. The first frame is the whole picture for reduced-motion users,
  // so it must already be populated: a static grid of glyphs, still drawn on the next advance for the animated case.
  let seeded = false;
  const drops = Array.from({ length: Math.ceil(w / MATRIX_SIZE) }, () => Math.random() * -50);
  let last = -Infinity;
  let primed = false;
  return (ctx, t, beat) => {
    const c = colors();
    if (!primed) {
      ctx.fillStyle = c.bg;
      ctx.fillRect(0, 0, w, h);
      primed = true;
    }
    // The painter is called at the canvas frame rate; the columns advance at the slower classic rate.
    if (t - last < MATRIX_STEP_MS) return;
    last = t;
    ctx.fillStyle = `rgba(${c.bgRgb}, 0.12)`;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = `rgba(${c.accentRgb}, ${0.45 + 0.45 * envelope(beat)})`;
    ctx.font = `${MATRIX_SIZE}px ui-monospace, Menlo, monospace`;
    const rows = Math.ceil(h / MATRIX_SIZE) + 1;
    if (!seeded) {
      for (let i = 0; i < drops.length; i++) {
        for (let j = 0; j < rows; j++) ctx.fillText(GLYPHS[(Math.random() * GLYPHS.length) | 0], i * MATRIX_SIZE, j * MATRIX_SIZE);
      }
      seeded = true;
    }
    for (let i = 0; i < drops.length; i++) {
      ctx.fillText(GLYPHS[(Math.random() * GLYPHS.length) | 0], i * MATRIX_SIZE, drops[i] * MATRIX_SIZE);
      if (drops[i] * MATRIX_SIZE > h && Math.random() > 0.975) drops[i] = 0;
      drops[i] += 1;
    }
  };
};

/** A starry sky with a moon, glowing in the theme's accent colour toward the horizon. */
const nightScene: Scene = (w, h) => (ctx, t, beat) => {
  const c = colors();
  const pulse = envelope(beat);
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, w, h);

  const horizon = ctx.createLinearGradient(0, h * 0.4, 0, h);
  horizon.addColorStop(0, `rgba(${c.accentRgb}, 0)`);
  horizon.addColorStop(1, `rgba(${c.accentRgb}, ${0.2 + 0.2 * pulse})`);
  ctx.fillStyle = horizon;
  ctx.fillRect(0, h * 0.4, w, h * 0.6);

  for (const s of STARS) {
    const a = 0.25 + 0.5 * (0.5 + 0.5 * Math.sin(t / 900 + s.phase));
    ctx.fillStyle = `rgba(255,255,255,${a})`;
    ctx.fillRect(s.x * w, s.y * h, s.size, s.size);
  }

  const mx = w * 0.8;
  const my = Math.min(h * 0.18, 150);
  const mr = Math.max(18, Math.min(w, h) * 0.035) * (1 + 0.05 * pulse);
  const halo = ctx.createRadialGradient(mx, my, mr * 0.6, mx, my, mr * 4);
  halo.addColorStop(0, `rgba(${c.accentRgb}, ${0.35 + 0.25 * pulse})`);
  halo.addColorStop(1, `rgba(${c.accentRgb}, 0)`);
  ctx.fillStyle = halo;
  ctx.fillRect(mx - mr * 4, my - mr * 4, mr * 8, mr * 8);
  ctx.fillStyle = c.peak;
  ctx.beginPath();
  ctx.arc(mx, my, mr, 0, Math.PI * 2);
  ctx.fill();
};

/** The theme's background colour with a faint glow at the top; the quietest option. */
const plainScene: Scene = (w, h) => (ctx, _t, beat) => {
  const c = colors();
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, w, h);
  const glow = ctx.createRadialGradient(w / 2, 0, 0, w / 2, 0, Math.max(w, h) * 0.7);
  glow.addColorStop(0, `rgba(${c.accentRgb}, ${0.12 + 0.1 * envelope(beat)})`);
  glow.addColorStop(1, `rgba(${c.accentRgb}, 0)`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
};

const sunsetScene: Scene = (w, h) => (ctx, t, beat) => paintSunset(ctx, w, h, t, beat);

const SCENES: Record<BackgroundId, Scene> = {
  sunset: sunsetScene,
  matrix: matrixScene,
  night: nightScene,
  plain: plainScene,
};

/** The page backdrop. Static for reduced-motion users; otherwise animated, and pulsing while a beat source is set. */
export function Backdrop() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { bg, theme } = useLook();

  // `theme` is a dependency because the scenes read the theme's colours when they paint: a new theme needs a new frame.
  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const calm = reducedMotion();
    let w = 0;
    let h = 0;
    let painter: Painter = () => {};

    const draw = (t: number) => painter(ctx, calm ? 0 : t, calm ? null : (beatSource?.() ?? null));
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      painter = SCENES[bg](w, h);
      draw(0);
    };
    resize();
    window.addEventListener("resize", resize);

    let raf = 0;
    let last = 0;
    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      if (t - last < 33) return;
      last = t;
      draw(t);
    };
    if (!calm) raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [bg, theme]);

  return <canvas className="backdrop" data-scene={bg} ref={canvas} aria-hidden />;
}
