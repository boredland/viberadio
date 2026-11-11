import { useEffect, useRef } from "react";
import { colors, useLook, type BackgroundId } from "./theme";
import { getBeat, setBeatSource } from "./beat";
import { reducedMotion } from "./ui";
import { createDrive, type Drive } from "./audioDrive";
import { readLevels } from "./tabAudio";

// Re-exported so Station.tsx does not need to know the beat source lives in its own module.
export { setBeatSource };

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

/** The pulse a scene paints with: the real low end when tab audio is on, else the invented beat. */
const pulseOf = (beat: number | null, audio: Drive | null): number => (audio ? audio.bass : envelope(beat));

/** Stars and glints brighten with the real high end; 1 (no change) without tab audio. */
const shimmerGain = (audio: Drive | null): number => 1 + 1.5 * (audio?.treble ?? 0);

/**
 * A scene is built for one canvas size and returns its frame painter. State that lives across frames (the matrix columns)
 * belongs to the painter, so a resize starts it fresh.
 */
type Painter = (ctx: CanvasRenderingContext2D, t: number, beat: number | null, audio: Drive | null) => void;
type Scene = (w: number, h: number) => Painter;

const HORIZON = 0.64;
const GRID_ROWS = 14;

function paintSunset(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, beat: number | null, audio: Drive | null): void {
  const hy = h * HORIZON;
  const cx = w / 2;
  const pulse = pulseOf(beat, audio);

  const sky = ctx.createLinearGradient(0, 0, 0, hy);
  sky.addColorStop(0, "#08011c");
  sky.addColorStop(0.45, "#3a0b5e");
  sky.addColorStop(0.75, "#c2236f");
  sky.addColorStop(1, "#ff7a4d");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, hy);

  for (const s of STARS) {
    const a = (0.35 + 0.35 * Math.sin(t / 700 + s.phase)) * (1 - s.y / 0.85) * shimmerGain(audio);
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
  return (ctx, t, beat, audio) => {
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
    ctx.fillStyle = `rgba(${c.accentRgb}, ${0.7 + 0.3 * pulseOf(beat, audio)})`;
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
const nightScene: Scene = (w, h) => (ctx, t, beat, audio) => {
  const c = colors();
  const pulse = pulseOf(beat, audio);
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, w, h);

  const horizon = ctx.createLinearGradient(0, h * 0.4, 0, h);
  horizon.addColorStop(0, `rgba(${c.accentRgb}, 0)`);
  horizon.addColorStop(1, `rgba(${c.accentRgb}, ${0.2 + 0.2 * pulse})`);
  ctx.fillStyle = horizon;
  ctx.fillRect(0, h * 0.4, w, h * 0.6);

  for (const s of STARS) {
    const a = (0.25 + 0.5 * (0.5 + 0.5 * Math.sin(t / 900 + s.phase))) * shimmerGain(audio);
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
const plainScene: Scene = (w, h) => (ctx, _t, beat, audio) => {
  const c = colors();
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, w, h);
  const glow = ctx.createRadialGradient(w / 2, 0, 0, w / 2, 0, Math.max(w, h) * 0.7);
  glow.addColorStop(0, `rgba(${c.accentRgb}, ${0.12 + 0.1 * pulseOf(beat, audio)})`);
  glow.addColorStop(1, `rgba(${c.accentRgb}, 0)`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
};

const sunsetScene: Scene = (w, h) => (ctx, t, beat, audio) => paintSunset(ctx, w, h, t, beat, audio);

// Seeded cloud banks: fixed positions, so the sky looks the same on every load.
const CLOUDS = (() => {
  const rnd = seeded(7);
  return Array.from({ length: 9 }, () => ({ x: rnd(), y: 0.12 + rnd() * 0.4, w: 0.18 + rnd() * 0.22, speed: 0.4 + rnd() * 0.8 }));
})();

/**
 * Dawn: a deep-blue sky warming to gold at the horizon, a sun half above a calm sea, a shimmer path on the water, and
 * slow clouds. The sun and its glow swell on the beat. Painted on the page, never behind the panels' text.
 */
const sunriseScene: Scene = (w, h) => (ctx, t, beat, audio) => {
  const hy = h * 0.66;
  const cx = w / 2;
  const pulse = pulseOf(beat, audio);

  const sky = ctx.createLinearGradient(0, 0, 0, hy);
  sky.addColorStop(0, "#0a1a3f");
  sky.addColorStop(0.4, "#4a3a7a");
  sky.addColorStop(0.7, "#e0708a");
  sky.addColorStop(0.88, "#ffa65c");
  sky.addColorStop(1, "#ffd98a");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, hy);

  // Fading stars in the still-dark top of the sky.
  for (const s of STARS) {
    const a = Math.max(0, 0.5 - s.y * 1.1) * (0.5 + 0.5 * Math.sin(t / 800 + s.phase)) * shimmerGain(audio);
    if (a <= 0.02) continue;
    ctx.fillStyle = `rgba(255,255,255,${a})`;
    ctx.fillRect(s.x * w, s.y * hy, s.size, s.size);
  }

  const r = Math.min(w * 0.2, hy * 0.2) * (1 + 0.04 * pulse);
  const sunY = hy - r * 0.15;

  const glow = ctx.createRadialGradient(cx, sunY, r * 0.4, cx, sunY, r * 4.2);
  glow.addColorStop(0, `rgba(255,214,120,${0.55 + 0.3 * pulse})`);
  glow.addColorStop(1, "rgba(255,160,80,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, hy);

  // Clouds drift slowly and catch the light underneath.
  for (const c of CLOUDS) {
    const cw = c.w * w;
    // Wrapped over the canvas width plus the cloud's own width: it travels fully off the right edge before reappearing fully
    // off the left, so it never pops in or out while visible.
    const x = ((c.x * w + (t / 1000) * 6 * c.speed) % (w + cw)) - cw;
    const cy = c.y * hy;
    const warm = Math.min(1, c.y * 1.6 + 0.2);
    const cg = ctx.createLinearGradient(0, cy - 8, 0, cy + 10);
    cg.addColorStop(0, `rgba(255,200,170,${0.16 * warm})`);
    cg.addColorStop(1, `rgba(255,130,100,${0.34 * warm})`);
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.ellipse(x + cw / 2, cy, cw / 2, 9, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // The sun: only the part above the horizon.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, hy);
  ctx.clip();
  const body = ctx.createRadialGradient(cx, sunY, 0, cx, sunY, r);
  body.addColorStop(0, "#fffbe6");
  body.addColorStop(0.6, "#ffe38a");
  body.addColorStop(1, "#ffb347");
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(cx, sunY, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Calm sea, lightest at the horizon.
  const sea = ctx.createLinearGradient(0, hy, 0, h);
  sea.addColorStop(0, "#d98660");
  sea.addColorStop(0.15, "#8a4a68");
  sea.addColorStop(1, "#160a1c");
  ctx.fillStyle = sea;
  ctx.fillRect(0, hy, w, h - hy);

  // Shimmer path: short horizontal glints under the sun that widen toward the viewer and flicker.
  const rows = 26;
  for (let i = 0; i < rows; i++) {
    const z = (i + 1) / rows;
    const y = hy + (h - hy) * z * z;
    const spread = r * (0.5 + 2.4 * z);
    const wob = Math.sin(t / 600 + i * 1.7) * spread * 0.18;
    const a = (0.55 - 0.4 * z) * (0.55 + 0.45 * Math.sin(t / 340 + i * 2.3)) * (1 + 0.5 * pulse);
    if (a <= 0.02) continue;
    ctx.fillStyle = `rgba(255,230,170,${Math.min(0.9, a)})`;
    const lw = spread * (0.5 + 0.5 * Math.abs(Math.sin(i * 12.9898)));
    ctx.fillRect(cx - lw / 2 + wob, y, lw, 1.5 + 2 * z);
  }

  ctx.strokeStyle = `rgba(255,214,150,${0.6 + 0.3 * pulse})`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, hy);
  ctx.lineTo(w, hy);
  ctx.stroke();
};

const SCENES: Record<BackgroundId, Scene> = {
  sunset: sunsetScene,
  sunrise: sunriseScene,
  matrix: matrixScene,
  night: nightScene,
  plain: plainScene,
};

/** The page backdrop. Static for reduced-motion users; otherwise animated, pulsing on the real spectrum when tab audio is on and on the beat otherwise. */
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

    const drive = createDrive();
    const draw = (t: number) => painter(ctx, calm ? 0 : t, calm ? null : getBeat(), calm ? null : drive(readLevels(), t));
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
