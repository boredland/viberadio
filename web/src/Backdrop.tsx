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

const SCENES: Record<BackgroundId, Scene> = {
  sunset: sunsetScene,
  sunrise: sunriseScene,
  matrix: matrixScene,
  night: nightScene,
  kivo: kivoScene,
  empa: empaScene,
  autumn: autumnScene,
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
