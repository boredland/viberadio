import { useEffect, useRef } from "react";
import { colors, useLook, type BackgroundId } from "./theme";
import { setBeatSource } from "./beat";
import { reducedMotion } from "./ui";
import { createDrive, type Drive } from "./audioDrive";
import { readLevels } from "./tabAudio";

// Re-exported so Station.tsx does not need to know the beat source lives in its own module. The backdrop itself no longer
// reads it; only the Visualizer bars do.
export { setBeatSource };

/**
 * The YouTube iframe exposes no audio data. This is a stable per-track tempo (84-128 BPM, from the video id) counted on the
 * station clock, used for the synthetic Visualizer bars: every listener sees the same pulse at the same moment.
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

/** The pulse a scene paints with: the real low end when REAL EQ is on, otherwise nothing (the backdrop stays still). */
const pulseOf = (audio: Drive | null): number => audio?.bass ?? 0;

/** Stars and glints brighten with the real high end; 1 (no change) without tab audio. */
const shimmerGain = (audio: Drive | null): number => 1 + 1.0 * (audio?.treble ?? 0);

/**
 * A scene is built for one canvas size and returns its frame painter. State that lives across frames (the matrix columns)
 * belongs to the painter, so a resize starts it fresh.
 */
type Painter = (ctx: CanvasRenderingContext2D, t: number, audio: Drive | null) => void;
type Scene = (w: number, h: number) => Painter;

const HORIZON = 0.64;
const GRID_ROWS = 14;

function paintSunset(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, audio: Drive | null): void {
  const hy = h * HORIZON;
  const cx = w / 2;
  const pulse = pulseOf(audio);

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
  // Rows drift slowly toward the viewer. One extra row is drawn past the bottom edge, so the row that wraps back in at the
  // horizon (hidden under the horizon line) and the one leaving at the bottom never pop on screen.
  const drift = (t / 9000) % 1;
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

  const bands = audio?.bands.length ? audio.bands : null;
  const spread = bands ? cx / (bands.length - 1) : Math.max(w, 720) * 0.09;
  const cols = ctx.createLinearGradient(0, hy, 0, h);
  cols.addColorStop(0, "rgba(255,80,210,0)");
  cols.addColorStop(1, `rgba(255,80,210,${Math.min(1, 0.7 * boost)})`);
  if (!bands) {
    ctx.strokeStyle = cols;
    ctx.beginPath();
    for (let i = -20; i <= 20; i++) {
      ctx.moveTo(cx, hy);
      ctx.lineTo(cx + i * spread, h);
    }
    ctx.stroke();
  } else {
    // With REAL EQ on the floor lines are a mirrored spectrum: the centre line is the bass, the lines toward the edges are
    // the treble, one line per band on each side. Spacing is set so every line reaches the bottom edge inside the viewport
    // (the usual wide spacing put the treble lines off-screen), and alpha is per band rather than the horizon gradient,
    // which left the treble lines almost invisible.
    ctx.strokeStyle = "rgba(255,80,210,1)";
    for (let k = 0; k < bands.length; k++) {
      const level = bands[k];
      ctx.globalAlpha = 0.2 + 0.6 * level;
      ctx.lineWidth = 1 + 2 * level;
      ctx.beginPath();
      ctx.moveTo(cx, hy);
      ctx.lineTo(cx + k * spread, h);
      if (k > 0) {
        ctx.moveTo(cx, hy);
        ctx.lineTo(cx - k * spread, h);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

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

/**
 * Falling glyphs in the theme's accent colour. With REAL EQ on every column follows one spectrum band (bass at the left edge,
 * treble at the right): a loud band rains faster, brighter, and its hottest glyphs turn white. Without it the calm rain plays
 * and only brightens a little with the bass.
 */
const matrixScene: Scene = (w, h) => {
  // Columns start off-screen so they rain in from the top. The first frame is the whole picture for reduced-motion users,
  // so it must already be populated: a static grid of glyphs, still drawn on the next advance for the animated case.
  let seeded = false;
  const drops = Array.from({ length: Math.ceil(w / MATRIX_SIZE) }, () => Math.random() * -50);
  let last = -Infinity;
  let primed = false;
  return (ctx, t, audio) => {
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
    const bands = audio?.bands.length ? audio.bands : null;
    ctx.fillStyle = `rgba(${c.accentRgb}, ${0.7 + 0.3 * pulseOf(audio)})`;
    ctx.font = `${MATRIX_SIZE}px ui-monospace, Menlo, monospace`;
    const rows = Math.ceil(h / MATRIX_SIZE) + 1;
    if (!seeded) {
      for (let i = 0; i < drops.length; i++) {
        for (let j = 0; j < rows; j++) ctx.fillText(GLYPHS[(Math.random() * GLYPHS.length) | 0], i * MATRIX_SIZE, j * MATRIX_SIZE);
      }
      seeded = true;
    }
    for (let i = 0; i < drops.length; i++) {
      let steps = 1;
      if (bands) {
        const level = bands[Math.min(bands.length - 1, Math.floor((i / drops.length) * bands.length))];
        steps = 1 + (level > 0.35 ? 1 : 0) + (level > 0.7 ? 1 : 0);
        ctx.fillStyle = level > 0.6 ? c.peak : c.accent;
        ctx.globalAlpha = 0.3 + 0.7 * level;
      }
      // A fast column still draws every row it passes, so it leaves a solid streak, not gaps.
      for (let s = 0; s < steps; s++) {
        ctx.fillText(GLYPHS[(Math.random() * GLYPHS.length) | 0], i * MATRIX_SIZE, drops[i] * MATRIX_SIZE);
        if (drops[i] * MATRIX_SIZE > h && Math.random() > 0.975) drops[i] = 0;
        drops[i] += 1;
      }
    }
    ctx.globalAlpha = 1;
  };
};

/** A starry sky with a moon, glowing in the theme's accent colour toward the horizon. */
const nightScene: Scene = (w, h) => (ctx, t, audio) => {
  const c = colors();
  const pulse = pulseOf(audio);
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
const plainScene: Scene = (w, h) => (ctx, _t, audio) => {
  const c = colors();
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, w, h);
  const glow = ctx.createRadialGradient(w / 2, 0, 0, w / 2, 0, Math.max(w, h) * 0.7);
  glow.addColorStop(0, `rgba(${c.accentRgb}, ${0.12 + 0.1 * pulseOf(audio)})`);
  glow.addColorStop(1, `rgba(${c.accentRgb}, 0)`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
};

const sunsetScene: Scene = (w, h) => (ctx, t, audio) => paintSunset(ctx, w, h, t, audio);

// Seeded cloud banks: fixed positions, so the sky looks the same on every load.
const CLOUDS = (() => {
  const rnd = seeded(7);
  return Array.from({ length: 9 }, () => ({ x: rnd(), y: 0.12 + rnd() * 0.4, w: 0.18 + rnd() * 0.22, speed: 0.4 + rnd() * 0.8 }));
})();

/**
 * Dawn: a deep-blue sky warming to gold at the horizon, a sun half above a calm sea, a shimmer path on the water, and
 * slow clouds. The sun and its glow swell with the bass when REAL EQ is on. Painted on the page, never behind the panels' text.
 */
const sunriseScene: Scene = (w, h) => (ctx, t, audio) => {
  const hy = h * 0.66;
  const cx = w / 2;
  const pulse = pulseOf(audio);

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

  // Shimmer path: short horizontal glints under the sun that widen toward the viewer and flicker. With REAL EQ on there is
  // one row per spectrum band, evenly spaced in depth from just below the horizon to just above the bottom edge (bass nearest
  // the viewer, treble at the horizon), and its glint grows and brightens with that band, so the water reads as an
  // equalizer. Perspective spacing squeezed the treble rows under the horizon line, hence the even spacing. Without REAL EQ
  // the calm perspective flicker stays; its 26th row sat below the canvas and is not drawn.
  const bands = audio?.bands.length ? audio.bands : null;
  const rows = bands ? bands.length : 25;
  for (let i = 0; i < rows; i++) {
    let z: number;
    let y: number;
    if (bands) {
      const depth = 0.02 + 0.96 * (i / (rows - 1));
      y = hy + (h - hy) * depth;
      z = Math.sqrt(depth);
    } else {
      z = (i + 1) / 26;
      y = hy + (h - hy) * z * z;
    }
    const spread = r * (0.5 + 2.4 * z);
    const wob = Math.sin(t / 600 + i * 1.7) * spread * 0.18;
    let a: number;
    let lw: number;
    let thick: number;
    if (bands) {
      const level = bands[rows - 1 - i];
      a = (0.1 + 0.7 * level) * (1 - 0.3 * z);
      lw = spread * (0.35 + 0.85 * level);
      thick = 1.5 + 2 * z + 1.5 * level;
    } else {
      a = (0.55 - 0.4 * z) * (0.55 + 0.45 * Math.sin(t / 340 + i * 2.3));
      lw = spread * (0.5 + 0.5 * Math.abs(Math.sin(i * 12.9898)));
      thick = 1.5 + 2 * z;
    }
    if (a <= 0.02) continue;
    ctx.fillStyle = `rgba(255,230,170,${Math.min(0.9, a)})`;
    ctx.fillRect(cx - lw / 2 + wob, y, lw, thick);
  }

  ctx.strokeStyle = `rgba(255,214,150,${0.6 + 0.3 * pulse})`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, hy);
  ctx.lineTo(w, hy);
  ctx.stroke();
};

/** Kivo brand colours (the product's own indigo, navy and ink). Fixed: this background is the brand, whatever theme is active. */
const KIVO_NAVY = "#0B1130";
const KIVO_INDIGO = "63, 76, 168";
const KIVO_INDIGO_LIGHT = "112, 128, 214";
const KIVO_INK = "238, 240, 244";

/** The Kivo logo, one path per part, in an 80 x 82.58 box (from the product's favicon): K, V, the parentheses and two bars. */
const LOGO_W = 80;
const LOGO_H = 82.58;
const LOGO_BAR_BASE = 33.548;
const LOGO_PATHS = {
  k: "M 2.581 33.548 L 2.581 0 L 7.97 0 L 7.97 15.563 L 20.828 0 L 27.448 0 L 13.605 16.448 L 28.387 33.548 L 21.544 33.548 L 7.97 17.892 L 7.97 33.548 L 2.581 33.548 Z",
  v: "M 11.149 82.58 L 0 49.032 L 6.09 49.032 L 15.422 77.129 L 24.877 49.032 L 30.968 49.032 L 19.818 82.58 L 11.149 82.58 Z",
  parenL:
    "M 52.903 56.944 C 51.031 59.307 49.892 62.409 49.892 65.807 C 49.893 69.205 51.031 72.306 52.903 74.668 L 52.903 82.58 C 47.504 79.231 43.871 72.974 43.871 65.807 C 43.871 58.639 47.504 52.381 52.903 49.033 L 52.903 56.944 Z",
  parenR:
    "M 70.968 49.033 C 76.367 52.381 80 58.639 80 65.807 C 79.999 72.974 76.367 79.231 70.968 82.58 L 70.968 74.668 C 72.839 72.306 73.978 69.205 73.978 65.807 C 73.978 62.409 72.84 59.307 70.968 56.944 L 70.968 49.033 Z",
  bar2: "M 64.516 1.648 C 66.369 1.372 68.11 0.805 69.677 0 L 69.677 33.548 L 64.516 33.548 L 64.516 1.648 Z",
  bar1: "M 54.194 33.548 L 54.194 0 C 55.761 0.805 57.502 1.372 59.355 1.648 L 59.355 33.548 L 54.194 33.548 Z",
};

/**
 * Kivo: a wall of rounded tiles (the shape of the app icon) with the logo on a plate in the middle.
 *  - With REAL EQ on, the wall is a spectrum: the centre columns are the bass and the edges the treble, and each column
 *    fills from the bottom with its band. The logo parts follow the music too: the parentheses open on the bass, the two
 *    bars rise and fall like meters on the mids, and the K and V glow with the treble. A kick sends a rounded-square
 *    shockwave outward from the logo.
 *  - Without it the wall breathes in a slow diagonal wave and the logo rests, so the backdrop stays mute.
 * Reduced motion paints one still frame of the resting state.
 */
const kivoScene: Scene = (w, h) => {
  const paths = {
    k: new Path2D(LOGO_PATHS.k),
    v: new Path2D(LOGO_PATHS.v),
    parenL: new Path2D(LOGO_PATHS.parenL),
    parenR: new Path2D(LOGO_PATHS.parenR),
    bar1: new Path2D(LOGO_PATHS.bar1),
    bar2: new Path2D(LOGO_PATHS.bar2),
  };
  const size = Math.max(36, Math.min(64, w / 22));
  const gap = Math.round(size * 0.14);
  const step = size + gap;
  const radius = size * 0.22;
  const cols = Math.ceil(w / step) + 1;
  const rows = Math.ceil(h / step) + 1;
  const x0 = (w - (cols * step - gap)) / 2;
  const y0 = (h - (rows * step - gap)) / 2;
  const logoH = Math.min(w, h) * 0.3;
  const plate = logoH * 1.3;
  const rings: number[] = [];
  let lastRing = -Infinity;
  let prevBass = 0;

  const tile = (ctx: CanvasRenderingContext2D, x: number, y: number) => {
    ctx.beginPath();
    ctx.roundRect(x, y, size, size, radius);
    ctx.fill();
  };

  return (ctx, t, audio) => {
    const bands = audio?.bands.length ? audio.bands : null;
    const pulse = audio ? Math.min(1, audio.bass / 0.4) : 0;

    ctx.fillStyle = KIVO_NAVY;
    ctx.fillRect(0, 0, w, h);
    const glow = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.65);
    glow.addColorStop(0, `rgba(${KIVO_INDIGO}, ${0.28 + 0.22 * pulse})`);
    glow.addColorStop(1, `rgba(${KIVO_INDIGO}, 0)`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    // The wall. Column distance from the middle picks the band, so the bass sits in the centre and the treble at the edges.
    const mid = (cols - 1) / 2;
    for (let c = 0; c < cols; c++) {
      const x = x0 + c * step;
      let lit = 0;
      let level = 0;
      if (bands) {
        // 20 bands over the ~10 columns per side: each column takes the loudest band in its share, so no band is skipped
        // (rounding one band per column silently dropped half of them, including the 8 kHz one).
        const d = mid === 0 ? 0 : Math.abs(c - mid) / mid;
        const lo = Math.min(bands.length - 1, Math.floor(d * (bands.length - 1)));
        const hi = Math.min(bands.length - 1, Math.max(lo, Math.ceil(((Math.abs(c - mid) + 1) / mid) * (bands.length - 1)) - 1));
        for (let b = lo; b <= hi; b++) level = Math.max(level, bands[b]);
        lit = Math.round(level * rows * 0.9);
      }
      for (let r = 0; r < rows; r++) {
        const k = rows - 1 - r;
        const y = y0 + r * step;
        if (k < lit) {
          const top = k === lit - 1;
          ctx.fillStyle = top ? `rgba(${KIVO_INK}, 0.3)` : `rgba(${KIVO_INDIGO_LIGHT}, ${0.12 + 0.2 * level})`;
        } else {
          const wave = 0.5 + 0.5 * Math.sin(t / 1500 + (c + r) * 0.33);
          ctx.fillStyle = `rgba(${KIVO_INDIGO}, ${(bands ? 0.07 : 0.07 + 0.07 * wave).toFixed(3)})`;
        }
        tile(ctx, x, y);
      }
    }

    // Shockwaves on a bass hit: thin rounded squares travelling outward from the logo plate.
    if (audio && audio.bass > 0.12 && audio.bass > prevBass + 0.03 && t - lastRing > 220) {
      rings.push(t);
      lastRing = t;
      if (rings.length > 6) rings.shift();
    }
    prevBass = audio?.bass ?? 0;
    const reach = Math.max(w, h) * 0.75;
    for (let i = rings.length - 1; i >= 0; i--) {
      const age = (t - rings[i]) / 1400;
      if (age >= 1) {
        rings.splice(i, 1);
        continue;
      }
      const s = plate * (0.9 + (reach / plate) * age);
      ctx.strokeStyle = `rgba(${KIVO_INDIGO_LIGHT}, ${(0.5 * Math.pow(1 - age, 1.6)).toFixed(3)})`;
      ctx.lineWidth = 2 + 2 * (1 - age);
      ctx.beginPath();
      ctx.roundRect(w / 2 - s / 2, h / 2 - s / 2, s, s, s * 0.2);
      ctx.stroke();
    }

    // Logo plate, like the app icon, then the six logo parts.
    const ps = plate * (1 + 0.04 * pulse);
    ctx.fillStyle = `rgba(${KIVO_INDIGO}, ${(0.62 + 0.2 * pulse).toFixed(3)})`;
    ctx.beginPath();
    ctx.roundRect(w / 2 - ps / 2, h / 2 - ps / 2, ps, ps, ps * 0.22);
    ctx.fill();

    const sc = logoH / LOGO_H;
    const level = (i: number) => (bands ? bands[Math.min(bands.length - 1, i)] : 0);
    const part = (p: Path2D, l: number, tx = 0, sy = 1) => {
      ctx.save();
      ctx.translate(tx, 0);
      if (sy !== 1) {
        ctx.translate(0, LOGO_BAR_BASE);
        ctx.scale(1, sy);
        ctx.translate(0, -LOGO_BAR_BASE);
      }
      ctx.fillStyle = `rgba(${KIVO_INK}, ${(0.7 + 0.3 * l).toFixed(3)})`;
      ctx.fill(p);
      ctx.restore();
    };
    ctx.save();
    ctx.translate(w / 2 - (LOGO_W / 2) * sc, h / 2 - (LOGO_H / 2) * sc);
    ctx.scale(sc, sc);
    const open = 9 * pulse;
    part(paths.k, level(17));
    part(paths.v, level(15));
    part(paths.parenL, pulse, -open);
    part(paths.parenR, pulse, open);
    part(paths.bar1, level(8), 0, bands ? 0.45 + 0.55 * level(8) : 1);
    part(paths.bar2, level(11), 0, bands ? 0.45 + 0.55 * level(11) : 1);
    ctx.restore();
  };
};

/** EMPA brand colours, from empa.co: black ground, lime accent, deep navy plate, steel blue-grey. Fixed, like the kivo scene. */
const EMPA_LIME = "203, 244, 41";
const EMPA_OLIVE = "162, 195, 33";
const EMPA_NAVY = "10, 53, 86";
const EMPA_STEEL = "108, 134, 154";

/** Drifting rounded "pixels" like the ones on the site's hero. Seeded, so the layout is the same on every load. */
const EMPA_SPARKS = (() => {
  const rnd = seeded(2024);
  return Array.from({ length: 30 }, () => ({
    x: rnd(),
    y: rnd(),
    size: 5 + rnd() * 9,
    speed: 0.006 + rnd() * 0.014,
    sway: rnd() * 6.28,
    kind: rnd(),
  }));
})();

/** The gem above the plate: a low-poly diamond, in units of a fifth of the plate. Edges index into the vertex list. */
const EMPA_GEM = [[0, -1.15], [-0.7, -0.45], [0.7, -0.45], [-0.95, 0.15], [0.95, 0.15], [0, 1.0], [0, -0.3]] as const;
const EMPA_GEM_EDGES = [[0, 1], [0, 2], [1, 2], [1, 3], [2, 4], [3, 5], [4, 5], [0, 6], [1, 6], [2, 6], [3, 6], [4, 6], [5, 6]] as const;
const EMPA_GEM_OUTLINE = [0, 1, 3, 5, 4, 2] as const;

/**
 * EMPA: black ground and a dot grid like the site's hero, with a navy slab and a lime wireframe gem (its "AI on a data
 * foundation" picture) low in the middle.
 *  - With REAL EQ on, the dot grid is a spectrum in rings around the slab: the bass is the ring at its edge, the treble the
 *    outermost. The drifting pixels each follow one band, growing and brightening with it. The gem lifts and glows with the
 *    bass, and a kick sends a ripple across the slab's plane.
 *  - Without it the dots breathe slowly and the pixels drift, so the backdrop stays mute. Reduced motion paints one still frame.
 */
const empaScene: Scene = (w, h) => {
  const gap = Math.max(22, Math.min(34, w / 44));
  const cols = Math.ceil(w / gap) + 1;
  const rows = Math.ceil(h / gap) + 1;
  const cx = w / 2;
  const cy = h * 0.62;
  const plate = Math.min(w, h) * 0.34;
  const side = plate / Math.SQRT2;
  // Rings are measured on the slab's plane (flattened to half height) from its edge outward.
  const reach = Math.hypot(Math.max(cx, w - cx), 2 * Math.max(cy, h - cy)) - plate / 2;
  const rings: number[] = [];
  let lastRing = -Infinity;
  let prevBass = 0;

  const iso = (ctx: CanvasRenderingContext2D, s: number, dy: number) => {
    ctx.save();
    ctx.translate(cx, cy + dy);
    ctx.scale(1, 0.5);
    ctx.rotate(Math.PI / 4);
    ctx.beginPath();
    ctx.roundRect(-s / 2, -s / 2, s, s, s * 0.18);
    // The path keeps the transform it was built under; restoring now keeps stroke widths un-squashed.
    ctx.restore();
  };

  return (ctx, t, audio) => {
    const bands = audio?.bands.length ? audio.bands : null;
    const pulse = audio ? Math.min(1, audio.bass / 0.4) : 0;
    const treble = audio?.treble ?? 0;

    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    const glow = ctx.createRadialGradient(0, h * 0.8, 0, 0, h * 0.8, Math.max(w, h) * 0.6);
    glow.addColorStop(0, `rgba(${EMPA_NAVY}, ${(0.55 + 0.2 * pulse).toFixed(3)})`);
    glow.addColorStop(1, `rgba(${EMPA_NAVY}, 0)`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    // Dot grid. Each dot's distance from the slab's edge picks its band.
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * gap;
        const y = r * gap;
        const d = Math.max(0, Math.hypot(x - cx, 2 * (y - cy)) - plate / 2) / reach;
        const lit = bands ? bands[Math.min(bands.length - 1, Math.floor(d * bands.length))] : 0;
        if (lit > 0.12) {
          const s = 1 + 1.2 * lit;
          ctx.fillStyle = `rgba(${EMPA_LIME}, ${(0.18 + 0.5 * lit).toFixed(3)})`;
          ctx.fillRect(x - s, y - s, s * 2, s * 2);
        } else {
          const a = 0.2 + 0.1 * Math.sin(t / 1800 + (c + r) * 0.4);
          ctx.fillStyle = `rgba(${EMPA_STEEL}, ${a.toFixed(3)})`;
          ctx.fillRect(x - 1, y - 1, 2, 2);
        }
      }
    }

    // Drifting pixels. With audio each follows one band.
    for (let i = 0; i < EMPA_SPARKS.length; i++) {
      const s = EMPA_SPARKS[i];
      const level = bands ? bands[i % bands.length] : 0;
      const px = s.x * w + Math.sin(t / 2500 + s.sway) * 14;
      const py = ((((s.y - (s.speed * t) / 1000) % 1) + 1) % 1) * h;
      const size = s.size * (1 + 0.9 * level);
      const base = bands ? 0.3 + 0.6 * level : 0.55 + 0.25 * Math.sin(t / 1200 + s.sway);
      const rgb = s.kind < 0.45 ? EMPA_LIME : s.kind < 0.75 ? "255, 255, 255" : EMPA_OLIVE;
      ctx.fillStyle = `rgba(${rgb}, ${Math.min(0.95, base).toFixed(3)})`;
      ctx.beginPath();
      ctx.roundRect(px, py, size, size, size * 0.28);
      ctx.fill();
    }

    // Ripples across the slab's plane on a bass hit.
    if (audio && audio.bass > 0.12 && audio.bass > prevBass + 0.03 && t - lastRing > 220) {
      rings.push(t);
      lastRing = t;
      if (rings.length > 6) rings.shift();
    }
    prevBass = audio?.bass ?? 0;
    for (let i = rings.length - 1; i >= 0; i--) {
      const age = (t - rings[i]) / 1500;
      if (age >= 1) {
        rings.splice(i, 1);
        continue;
      }
      iso(ctx, side * (1 + 4 * age), 0);
      ctx.strokeStyle = `rgba(${EMPA_LIME}, ${(0.55 * Math.pow(1 - age, 1.5)).toFixed(3)})`;
      ctx.lineWidth = 1.5 + 1.5 * (1 - age);
      ctx.stroke();
    }

    // The slab: stacked navy layers for thickness, then a top face with a dashed edge.
    const thick = plate * 0.07;
    const lift = pulse * plate * 0.02;
    for (let dy = thick; dy > 0; dy -= 2) {
      iso(ctx, side, dy - lift);
      ctx.fillStyle = `rgba(6, 30, 50, 1)`;
      ctx.fill();
    }
    iso(ctx, side, -lift);
    ctx.fillStyle = `rgba(${EMPA_NAVY}, ${(0.9 + 0.1 * pulse).toFixed(3)})`;
    ctx.fill();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = "rgba(206, 215, 221, 0.55)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.setLineDash([]);

    // Soft shadow of the gem on the slab, then the gem itself.
    const u = plate * 0.3;
    const bob = Math.sin(t / 900) * plate * 0.02 + pulse * plate * 0.05;
    const gx = cx;
    const gy = cy - plate * 0.3 - bob - lift;
    ctx.fillStyle = `rgba(${EMPA_LIME}, ${(0.1 + 0.08 * pulse).toFixed(3)})`;
    ctx.beginPath();
    ctx.ellipse(cx, cy - lift, u * 0.9, u * 0.28, 0, 0, Math.PI * 2);
    ctx.fill();

    const gs = 1 + 0.1 * pulse;
    const at = (i: number): [number, number] => [gx + EMPA_GEM[i][0] * u * gs, gy + EMPA_GEM[i][1] * u * gs];
    ctx.beginPath();
    EMPA_GEM_OUTLINE.forEach((v, i) => {
      const [x, y] = at(v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = `rgba(${EMPA_LIME}, ${(0.05 + 0.1 * treble + 0.06 * pulse).toFixed(3)})`;
    ctx.fill();
    ctx.strokeStyle = `rgba(${EMPA_LIME}, ${(0.78 + 0.22 * pulse).toFixed(3)})`;
    ctx.lineWidth = 1.3 + 1.2 * pulse;
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (const [a, b] of EMPA_GEM_EDGES) {
      const [ax, ay] = at(a);
      const [bx, by] = at(b);
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
    ctx.stroke();
    ctx.fillStyle = `rgba(${EMPA_LIME}, 1)`;
    for (let i = 0; i < EMPA_GEM.length; i++) {
      const [x, y] = at(i);
      ctx.fillRect(x - 2, y - 2, 4, 4);
    }
  };
};

/** Gruvbox palette (dark, medium contrast). The autumn scene is fixed to these, like the brand scenes. */
const GRUV_BG = "#1d2021";
const GRUV_SKY_LO = "#3c2a1a";
const GRUV_SUN = "250, 189, 47";
const GRUV_LEAVES = ["204, 36, 29", "214, 93, 14", "215, 153, 33", "250, 189, 47", "152, 151, 26", "177, 98, 134"] as const;

/** Falling leaves, seeded so the layout is the same on every load. Each follows one spectrum band. */
const LEAVES = (() => {
  const rnd = seeded(1971);
  return Array.from({ length: 46 }, (_, i) => ({
    x: rnd(),
    y: rnd(),
    size: 7 + rnd() * 10,
    fall: 0.018 + rnd() * 0.03,
    sway: rnd() * 6.28,
    spin: (rnd() - 0.5) * 2,
    colour: GRUV_LEAVES[Math.floor(rnd() * GRUV_LEAVES.length)],
    band: i % 20,
  }));
})();

/** Tree silhouettes: a trunk and three layers of leaf mass, planted along a ridge. Seeded like the leaves. */
const TREES = (() => {
  const rnd = seeded(33);
  return Array.from({ length: 13 }, (_, i) => ({
    x: (i + 0.5 + (rnd() - 0.5) * 0.7) / 13,
    height: 0.12 + rnd() * 0.12,
    layer: rnd() < 0.5 ? 0 : 1,
    colour: GRUV_LEAVES[Math.floor(rnd() * 4)],
    phase: rnd() * 6.28,
  }));
})();

/**
 * Autumn: a dusk sky with a low sun, rows of trees in Gruvbox reds, oranges and yellows, and leaves falling through the
 * air.
 *  - With REAL EQ on, every falling leaf follows one spectrum band: a louder band makes its leaf bigger, brighter and
 *    quicker. The trees sway and flare on the bass and the sun swells with it, and a kick throws a gust of extra leaves.
 *  - Without it the leaves drift slowly and the trees stand still, so the backdrop stays mute. Reduced motion paints one still frame.
 */
const autumnScene: Scene = (w, h) => {
  const hy = h * 0.72;
  let lastGust = -Infinity;
  let prevBass = 0;
  let gust = 0;
  // Each leaf's height is advanced a frame at a time. Computing it as fall x time x speed made every change in a band's
  // level rescale the whole elapsed time, so leaves jumped across the screen whenever the music got louder or quieter.
  const heights = LEAVES.map((l) => l.y);
  let lastT = -1;

  const leaf = (ctx: CanvasRenderingContext2D, x: number, y: number, size: number, angle: number, rgb: string, alpha: number) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = `rgba(${rgb}, ${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.quadraticCurveTo(size * 0.8, -size * 0.2, 0, size);
    ctx.quadraticCurveTo(-size * 0.8, -size * 0.2, 0, -size);
    ctx.fill();
    ctx.restore();
  };

  return (ctx, t, audio) => {
    const bands = audio?.bands.length ? audio.bands : null;
    const pulse = audio ? Math.min(1, audio.bass / 0.4) : 0;

    ctx.fillStyle = GRUV_BG;
    ctx.fillRect(0, 0, w, h);
    const sky = ctx.createLinearGradient(0, 0, 0, hy);
    sky.addColorStop(0, GRUV_BG);
    sky.addColorStop(0.7, "#2d2318");
    sky.addColorStop(1, GRUV_SKY_LO);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, hy);

    const sx = w * 0.72;
    const sr = Math.min(w, h) * (0.1 + 0.012 * pulse);
    const glow = ctx.createRadialGradient(sx, hy - sr * 0.2, sr * 0.3, sx, hy - sr * 0.2, sr * 3.4);
    glow.addColorStop(0, `rgba(${GRUV_SUN}, ${(0.42 + 0.2 * pulse).toFixed(3)})`);
    glow.addColorStop(1, `rgba(${GRUV_SUN}, 0)`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, hy);
    ctx.fillStyle = `rgba(${GRUV_SUN}, 0.9)`;
    ctx.beginPath();
    ctx.arc(sx, hy - sr * 0.2, sr, Math.PI, 0);
    ctx.fill();

    // Ground, then the trees on it. Back row first, so the front row overlaps it.
    ctx.fillStyle = "#17120d";
    ctx.fillRect(0, hy, w, h - hy);
    for (const layer of [0, 1]) {
      for (const tr of TREES) {
        if (tr.layer !== layer) continue;
        const base = hy + (layer === 0 ? 0 : h * 0.05);
        const th = h * tr.height * (layer === 0 ? 1 : 1.35);
        const x = tr.x * w + (bands ? Math.sin(t / 700 + tr.phase) * 3 * pulse : 0);
        const alpha = layer === 0 ? 0.55 : 0.85;
        ctx.fillStyle = `rgba(60, 40, 22, ${alpha})`;
        ctx.fillRect(x - th * 0.04, base - th * 0.5, th * 0.08, th * 0.5);
        for (let k = 0; k < 3; k++) {
          const r = th * (0.34 - k * 0.07) * (1 + 0.1 * pulse);
          ctx.fillStyle = `rgba(${tr.colour}, ${(alpha * (0.55 + 0.2 * k + 0.15 * pulse)).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(x + (k - 1) * th * 0.12, base - th * (0.62 + 0.16 * k), r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // A kick throws a gust: the leaves are pushed sideways for a moment, then settle.
    if (audio && audio.bass > 0.12 && audio.bass > prevBass + 0.03 && t - lastGust > 260) {
      gust = 1;
      lastGust = t;
    }
    prevBass = audio?.bass ?? 0;
    gust *= 0.94;

    const dt = lastT < 0 ? 0 : Math.min(100, Math.max(0, t - lastT));
    lastT = t;
    for (let i = 0; i < LEAVES.length; i++) {
      const l = LEAVES[i];
      const level = bands ? bands[l.band] : 0;
      heights[i] = (((heights[i] + (l.fall * dt) / 1000 * (1 + 2.5 * level)) % 1) + 1) % 1;
      const py = heights[i] * h;
      const px = l.x * w + Math.sin(t / 1400 + l.sway) * 22 + gust * 60 * (1 + l.spin);
      const size = l.size * (1 + 0.8 * level);
      const alpha = bands ? 0.35 + 0.6 * level : 0.55 + 0.2 * Math.sin(t / 1900 + l.sway);
      leaf(ctx, px, py, size, t / 900 * l.spin + l.sway, l.colour, Math.min(0.95, alpha));
    }
  };
};

/** Winter palette. The scene is fixed to it, like the other themed scenes. */
const SNOW_BG = "#0b1424";
const SNOW_SKY_HI = "#070d1a";
const SNOW_SKY_LO = "#17304f";
const SNOW_ICE = "159, 216, 255";
const SNOW_AURORA = ["110, 231, 183", "125, 211, 252", "167, 139, 250"] as const;

/** Snowflakes in three depths (small and slow far away, big and quick near). Seeded; each follows one spectrum band. */
const FLAKES = (() => {
  const rnd = seeded(1225);
  return Array.from({ length: 90 }, (_, i) => {
    const depth = rnd();
    return {
      x: rnd(),
      y: rnd(),
      size: 1 + depth * 3.4,
      fall: 0.02 + depth * 0.05,
      sway: rnd() * 6.28,
      swayAmp: 6 + depth * 18,
      band: i % 20,
      depth,
    };
  });
})();

/** Pine trees on two ridges: a stack of three snow-covered triangles. Seeded like the flakes. */
const PINES = (() => {
  const rnd = seeded(77);
  return Array.from({ length: 16 }, (_, i) => ({
    x: (i + 0.5 + (rnd() - 0.5) * 0.8) / 16,
    height: 0.1 + rnd() * 0.12,
    layer: rnd() < 0.55 ? 0 : 1,
    phase: rnd() * 6.28,
  }));
})();

/** Stars in the upper sky; a few twinkle. Seeded. */
const SNOW_STARS = (() => {
  const rnd = seeded(404);
  return Array.from({ length: 60 }, () => ({ x: rnd(), y: rnd() * 0.5, size: 0.8 + rnd() * 1.4, phase: rnd() * 6.28 }));
})();

/** Santa is a seasonal extra: 1 to 26 December on the viewer's own calendar. */
function isChristmasSeason(now: Date = new Date()): boolean {
  return now.getMonth() === 11 && now.getDate() <= 26;
}

/** The scene clock starts at page load, so the first flight comes a few seconds in, then one every 70 s. */
const SANTA_FIRST_MS = 8000;
const SANTA_PERIOD_MS = 70_000;
const SANTA_FLIGHT_MS = 14_000;

/** One reindeer in local units, facing right and centred on its body. The lead one has a glowing red nose. */
function drawReindeer(ctx: CanvasRenderingContext2D, t: number, i: number, lead: boolean, glow: number): void {
  ctx.save();
  ctx.translate(0, Math.sin(t / 260 + i * 1.7) * 0.5);
  ctx.strokeStyle = "#7a4a2b";
  ctx.lineWidth = 0.35;
  ctx.lineCap = "round";
  for (const [lx, ph] of [[-1.2, 0], [-0.7, 1.4], [1.0, 0.7], [1.5, 2.1]]) {
    const a = Math.sin(t / 150 + i * 2.1 + ph) * 0.7;
    ctx.beginPath();
    ctx.moveTo(lx, 0.5);
    ctx.lineTo(lx + Math.sin(a) * 1.6, 0.5 + Math.cos(a) * 1.4);
    ctx.stroke();
  }
  ctx.fillStyle = "#b8794a";
  ctx.beginPath();
  ctx.ellipse(0, 0, 2, 0.95, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(2.4, -0.9, 0.7, 0.55, -0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#e8d5b0";
  ctx.lineWidth = 0.2;
  ctx.beginPath();
  ctx.moveTo(2.5, -1.4);
  ctx.lineTo(2.2, -2.6);
  ctx.moveTo(2.3, -2.1);
  ctx.lineTo(1.7, -2.3);
  ctx.moveTo(2.7, -1.4);
  ctx.lineTo(3.2, -2.5);
  ctx.moveTo(3.0, -2.0);
  ctx.lineTo(3.5, -2.1);
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(-2, -0.3, 0.35, 0, Math.PI * 2);
  ctx.fill();
  if (lead) {
    const g = ctx.createRadialGradient(3.05, -0.8, 0, 3.05, -0.8, 1.6);
    g.addColorStop(0, `rgba(255, 70, 50, ${(0.55 * glow).toFixed(3)})`);
    g.addColorStop(1, "rgba(255, 70, 50, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(1.4, -2.4, 3.2, 3.2);
    ctx.fillStyle = "#ff3b30";
    ctx.beginPath();
    ctx.arc(3.05, -0.8, 0.28, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Sleigh, Santa, two reindeer and a trail of sparkles, in local units facing right, origin at the sleigh's middle. */
function drawSanta(ctx: CanvasRenderingContext2D, t: number, glow: number): void {
  for (let j = 0; j < 14; j++) {
    const f = 1 - j / 14;
    ctx.fillStyle = `rgba(255, 226, 140, ${(0.8 * f * glow).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(-6 - j * 1.5, 0.5 + Math.sin(j * 1.1 + t / 180) * 1.1, 0.1 + 0.45 * f, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(255, 230, 160, 0.6)";
  ctx.lineWidth = 0.12;
  ctx.beginPath();
  ctx.moveTo(5.4, -0.8);
  ctx.lineTo(9.5, 0);
  ctx.lineTo(15.5, 0);
  ctx.stroke();
  ctx.strokeStyle = "#e0b84a";
  ctx.lineWidth = 0.3;
  ctx.beginPath();
  ctx.moveTo(-4.6, 2.5);
  ctx.lineTo(4.2, 2.5);
  ctx.quadraticCurveTo(6.2, 2.5, 5.6, 0.6);
  ctx.moveTo(-2.5, 1.4);
  ctx.lineTo(-2.5, 2.5);
  ctx.moveTo(2.5, 1.4);
  ctx.lineTo(2.5, 2.5);
  ctx.stroke();
  ctx.fillStyle = "#c0392b";
  ctx.beginPath();
  ctx.moveTo(-4.4, -2);
  ctx.lineTo(4.2, -2.4);
  ctx.quadraticCurveTo(5.6, -2.4, 5.2, -0.6);
  ctx.lineTo(3.8, 1.5);
  ctx.lineTo(-3.4, 1.5);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#e0b84a";
  ctx.lineWidth = 0.25;
  ctx.beginPath();
  ctx.moveTo(-3.6, -0.4);
  ctx.lineTo(4.4, -0.6);
  ctx.stroke();
  ctx.fillStyle = "#8a5a35";
  ctx.beginPath();
  ctx.ellipse(-3.2, -2.9, 1.5, 1.3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#d8392b";
  ctx.beginPath();
  ctx.ellipse(0.2, -2.9, 1.4, 1.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#f2c9a6";
  ctx.beginPath();
  ctx.arc(0.4, -5, 0.75, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.ellipse(0.75, -4.6, 0.6, 0.55, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#d8392b";
  ctx.beginPath();
  ctx.moveTo(-0.5, -5.5);
  ctx.lineTo(1.3, -5.5);
  ctx.lineTo(-1.0, -7.2);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(-0.5, -5.7, 1.8, 0.4);
  ctx.beginPath();
  ctx.arc(-1.0, -7.2, 0.35, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.translate(9.5, 0);
  drawReindeer(ctx, t, 0, false, glow);
  ctx.restore();
  ctx.save();
  ctx.translate(15.5, 0);
  drawReindeer(ctx, t, 1, true, glow);
  ctx.restore();
}

/**
 * Snow: a clear winter night. Stars and a moon, a soft aurora, snowy pines on two ridges and a frozen lake, with snow
 * falling through all of it.
 *  - With REAL EQ on, every snowflake follows one spectrum band: a louder band makes its flake bigger, brighter and quicker.
 *    The aurora ribbons swell and ripple with the bass, the pines shiver, and a kick throws a gust that sweeps the snow
 *    sideways.
 *  - Without it the snow drifts gently and the aurora barely moves, so the backdrop stays mute. Reduced motion paints one
 *    still frame.
 *  - From 1 to 26 December, Santa's sleigh crosses the sky now and then, glowing a little more on a kick. It needs the
 *    animation clock, so under reduced motion he never appears.
 */
const snowScene: Scene = (w, h) => {
  const hy = h * 0.7;
  const christmas = isChristmasSeason();
  let lastGust = -Infinity;
  let prevBass = 0;
  let gust = 0;
  // Heights are advanced a frame at a time, so a change in a band's loudness changes the speed instead of teleporting the
  // flake (computing height as fall x time x speed rescaled all elapsed time on every level change).
  const heights = FLAKES.map((f) => f.y);
  let lastT = -1;
  let auroraPhase = 0;
  let lastAuroraT = -1;
  let auroraPulse = 0;

  // Where the moon can be seen on a portrait screen: the middle of the widest stretch no pine covers. Each pine hides
  // its widest tier (0.3 of its height to each side), so that is the span to keep clear, measured at this screen size.
  const moonX = (() => {
    const spans = PINES.map((p) => {
      const half = h * p.height * (p.layer === 0 ? 1 : 1.4) * 0.3;
      return [p.x * w - half, p.x * w + half] as const;
    }).sort((a, b) => a[0] - b[0]);
    let best = w * 0.5;
    let widest = 0;
    let edge = 0;
    for (const [from, to] of [...spans, [w, w] as const]) {
      if (from - edge > widest) {
        widest = from - edge;
        best = (from + edge) / 2;
      }
      edge = Math.max(edge, to);
    }
    return best;
  })();

  const pine = (ctx: CanvasRenderingContext2D, x: number, base: number, th: number, alpha: number, shiver: number) => {
    ctx.fillStyle = `rgba(8, 18, 32, ${alpha})`;
    ctx.fillRect(x - th * 0.035, base - th * 0.14, th * 0.07, th * 0.14);
    for (let k = 0; k < 3; k++) {
      const half = th * (0.3 - k * 0.07);
      const top = base - th * (0.26 + k * 0.27);
      const bottom = base - th * (0.12 + k * 0.2);
      const sx = x + shiver * (k + 1) * 0.4;
      ctx.fillStyle = `rgba(14, 34, 52, ${alpha})`;
      ctx.beginPath();
      ctx.moveTo(sx, top - th * 0.2);
      ctx.lineTo(x + half, bottom);
      ctx.lineTo(x - half, bottom);
      ctx.closePath();
      ctx.fill();
      // Snow lies on the upper side of each tier.
      ctx.fillStyle = `rgba(226, 240, 252, ${alpha * 0.85})`;
      ctx.beginPath();
      ctx.moveTo(sx, top - th * 0.2);
      ctx.lineTo(x + half * 0.62, bottom - (bottom - top + th * 0.2) * 0.38);
      ctx.lineTo(x - half * 0.62, bottom - (bottom - top + th * 0.2) * 0.38);
      ctx.closePath();
      ctx.fill();
    }
  };

  return (ctx, t, audio) => {
    const bands = audio?.bands.length ? audio.bands : null;
    const pulse = audio ? Math.min(1, audio.bass / 0.4) : 0;

    const sky = ctx.createLinearGradient(0, 0, 0, hy);
    sky.addColorStop(0, SNOW_SKY_HI);
    sky.addColorStop(0.65, SNOW_BG);
    sky.addColorStop(1, SNOW_SKY_LO);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    for (const s of SNOW_STARS) {
      const a = 0.35 + 0.35 * Math.sin(t / 900 + s.phase);
      ctx.fillStyle = `rgba(230, 241, 251, ${a.toFixed(3)})`;
      ctx.fillRect(s.x * w, s.y * hy, s.size, s.size);
    }

    // Aurora: three translucent ribbons across the upper sky. They swell with the bass and ripple faster with the mids.
    // The ripple phase is advanced a frame at a time: writing it as (t / 2600) * speed multiplied ALL elapsed time by the
    // current speed, so every change in the mids made the ribbons jump instead of just speeding up.
    const mids = bands ? (bands[5] + bands[8] + bands[11]) / 3 : 0;
    const adt = lastAuroraT < 0 ? 0 : Math.min(100, Math.max(0, t - lastAuroraT));
    lastAuroraT = t;
    auroraPhase += (adt / 2600) * (1 + 2.2 * mids);
    // The raw bass pulse steps from ~0 to 1 in one frame on a kick, which snapped the ribbons by ~2% of the height.
    // Ease it (attack ~60 ms, release ~350 ms) so a kick swells them instead.
    auroraPulse += (pulse - auroraPulse) * (1 - Math.exp(-adt / (pulse > auroraPulse ? 60 : 350)));
    for (let k = 0; k < 3; k++) {
      const baseY = hy * (0.2 + k * 0.11);
      const amp = h * (0.035 + 0.02 * auroraPulse + 0.015 * mids);
      ctx.beginPath();
      ctx.moveTo(0, baseY);
      for (let x = 0; x <= w; x += 12) {
        ctx.lineTo(x, baseY + Math.sin(x / (170 + k * 60) + auroraPhase + k * 2) * amp + Math.sin(x / 70 + t / 1700 + k) * amp * 0.35);
      }
      ctx.lineTo(w, baseY + h * 0.2);
      ctx.lineTo(0, baseY + h * 0.2);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, baseY - amp, 0, baseY + h * 0.2);
      const a = 0.14 + 0.16 * auroraPulse + 0.05 * k;
      g.addColorStop(0, `rgba(${SNOW_AURORA[k]}, 0)`);
      g.addColorStop(0.3, `rgba(${SNOW_AURORA[k]}, ${a.toFixed(3)})`);
      g.addColorStop(1, `rgba(${SNOW_AURORA[k]}, 0)`);
      ctx.fillStyle = g;
      ctx.fill();
    }

    // Moon with a halo.
    // The panels cover the top of the page. Wide screens have room low-left of centre. On a portrait screen the panels
    // reach almost down to the horizon and the pines are drawn over the moon, so it rises on the ridge in the widest gap
    // between pines (see moonX), the only place left where it can be seen.
    const portrait = w < h;
    const mr = Math.min(w, h) * 0.045;
    const mx = portrait ? moonX : w * 0.12;
    const my = portrait ? hy - h * 0.03 - mr * 0.4 : hy * 0.62;
    const halo = ctx.createRadialGradient(mx, my, mr * 0.5, mx, my, mr * 5);
    halo.addColorStop(0, `rgba(${SNOW_ICE}, ${(0.28 + 0.12 * pulse).toFixed(3)})`);
    halo.addColorStop(1, `rgba(${SNOW_ICE}, 0)`);
    ctx.fillStyle = halo;
    ctx.fillRect(mx - mr * 5, my - mr * 5, mr * 10, mr * 10);
    ctx.fillStyle = "#eaf4fd";
    ctx.beginPath();
    ctx.arc(mx, my, mr, 0, Math.PI * 2);
    ctx.fill();

    // Santa: one flight every SANTA_PERIOD_MS, alternating direction, drawn in front of the moon and behind the pines and
    // snow. Reduced motion passes t = 0, which is before the first flight, so he never shows there.
    if (christmas && t >= SANTA_FIRST_MS) {
      const since = (t - SANTA_FIRST_MS) % SANTA_PERIOD_MS;
      if (since < SANTA_FLIGHT_MS) {
        const p = since / SANTA_FLIGHT_MS;
        const dir = Math.floor((t - SANTA_FIRST_MS) / SANTA_PERIOD_MS) % 2 === 0 ? 1 : -1;
        const u = Math.max(5, Math.min(w, h) * 0.009);
        const x = dir === 1 ? -30 * u + p * (w + 60 * u) : w + 30 * u - p * (w + 60 * u);
        const y = hy * 0.5 - Math.sin(p * Math.PI) * hy * 0.05;
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(dir * u, u);
        drawSanta(ctx, t, 0.7 + 0.3 * auroraPulse);
        ctx.restore();
      }
    }

    // Far ridge of snow, then pines, then the frozen lake.
    ctx.fillStyle = "#1b2f48";
    ctx.beginPath();
    ctx.moveTo(0, hy);
    for (let x = 0; x <= w; x += 20) ctx.lineTo(x, hy - h * 0.03 - Math.sin(x / 190) * h * 0.02 - Math.sin(x / 70 + 1) * h * 0.008);
    ctx.lineTo(w, hy + 2);
    ctx.lineTo(0, hy + 2);
    ctx.closePath();
    ctx.fill();
    for (const layer of [0, 1]) {
      for (const p of PINES) {
        if (p.layer !== layer) continue;
        const base = hy + (layer === 0 ? 2 : h * 0.045);
        const th = h * p.height * (layer === 0 ? 1 : 1.4);
        // Tip sway in px: a base amount plus a share of the tree's height, so tall trees swing visibly further. It uses
        // the eased pulse, so a kick swings the tips out and back instead of snapping them.
        const shiver = bands ? Math.sin(t / 150 + p.phase) * (2 + th * 0.02) * auroraPulse : 0;
        pine(ctx, p.x * w, base, th, layer === 0 ? 0.7 : 0.97, shiver);
      }
    }
    const lake = ctx.createLinearGradient(0, hy, 0, h);
    lake.addColorStop(0, "#1d3a5a");
    lake.addColorStop(1, "#0a1626");
    ctx.fillStyle = lake;
    ctx.fillRect(0, hy + h * 0.045, w, h - hy - h * 0.045);
    // The moon's reflection on the ice: a soft elongated glow, not a rectangle, so it has no hard edges to read as a
    // square. It uses the eased pulse, so a kick brightens it gradually instead of stepping it.
    const ry = hy + h * 0.05;
    ctx.save();
    ctx.translate(mx, ry);
    ctx.scale(1, (h - ry) / (mr * 2.6));
    const refl = ctx.createRadialGradient(0, 0, 0, 0, 0, mr * 2.6);
    refl.addColorStop(0, `rgba(${SNOW_ICE}, ${(0.2 + 0.12 * auroraPulse).toFixed(3)})`);
    refl.addColorStop(0.45, `rgba(${SNOW_ICE}, ${(0.08 + 0.05 * auroraPulse).toFixed(3)})`);
    refl.addColorStop(1, `rgba(${SNOW_ICE}, 0)`);
    ctx.fillStyle = refl;
    ctx.fillRect(-mr * 2.6, 0, mr * 5.2, mr * 2.6);
    ctx.restore();

    // A kick throws a gust that sweeps the snow sideways, then settles.
    if (audio && audio.bass > 0.12 && audio.bass > prevBass + 0.03 && t - lastGust > 260) {
      gust = 1;
      lastGust = t;
    }
    prevBass = audio?.bass ?? 0;
    gust *= 0.94;

    const dt = lastT < 0 ? 0 : Math.min(100, Math.max(0, t - lastT));
    lastT = t;
    for (let i = 0; i < FLAKES.length; i++) {
      const f = FLAKES[i];
      const level = bands ? bands[f.band] : 0;
      heights[i] = (((heights[i] + (f.fall * dt) / 1000 * (1 + 2.2 * level)) % 1) + 1) % 1;
      const px = f.x * w + Math.sin(t / 1500 + f.sway) * f.swayAmp + gust * 70 * (0.4 + f.depth);
      const size = f.size * (1 + 0.7 * level);
      const alpha = bands ? 0.3 + 0.65 * level : 0.5 + 0.25 * Math.sin(t / 2100 + f.sway);
      ctx.fillStyle = `rgba(240, 248, 255, ${Math.min(0.95, alpha).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(px, heights[i] * h, size, 0, Math.PI * 2);
      ctx.fill();
    }
  };
};

const SCENES: Record<BackgroundId, Scene> = {
  sunset: sunsetScene,
  sunrise: sunriseScene,
  matrix: matrixScene,
  night: nightScene,
  kivo: kivoScene,
  empa: empaScene,
  autumn: autumnScene,
  snow: snowScene,
  plain: plainScene,
};

/** The page backdrop. Static for reduced-motion users; otherwise it drifts, and pulses on the real spectrum only while REAL EQ is on. */
export function Backdrop() {
  const { bg, theme } = useLook();
  return <CanvasBackdrop bg={bg} theme={theme} />;
}

function CanvasBackdrop({ bg, theme }: { bg: BackgroundId; theme: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);

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
    const draw = (t: number) => {
      const a = calm ? null : drive(readLevels(), t);
      // The matrix is veiled at 22% in CSS; with real audio the veil lifts so the spectrum reads.
      if (a) el.dataset.live = "1";
      else delete el.dataset.live;
      painter(ctx, calm ? 0 : t, a);
    };
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
