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

/** Falling glyphs in the theme's accent colour; they brighten with the bass when REAL EQ is on. */
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
      ctx.fillText(GLYPHS[(Math.random() * GLYPHS.length) | 0], i * MATRIX_SIZE, drops[i] * MATRIX_SIZE);
      if (drops[i] * MATRIX_SIZE > h && Math.random() > 0.975) drops[i] = 0;
      drops[i] += 1;
    }
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

/** The canvas scenes. Kivo is not one: it is DOM-based (KivoBackdrop), so Backdrop branches to it before painting here. */
const SCENES: Record<Exclude<BackgroundId, "kivo">, Scene> = {
  sunset: sunsetScene,
  sunrise: sunriseScene,
  matrix: matrixScene,
  night: nightScene,
  plain: plainScene,
};

/**
 * Kivo: the supplied morphing-heart loop (web/public/kivo-heart-morph.webp, 33 frames, 70 ms each) plays behind the panels,
 * with a big centre tile over a mirrored field. With REAL EQ on, the centre tile scales with the bass and the wash with the
 * treble; without it the loop just plays, so the backdrop stays mute.
 *
 * Reduced motion: the source WebP cannot be paused or seeked, so it is shown only as a decorative background, which
 * WCAG 2.2.2 allows. A truly still variant would need a frame extracted from it.
 */
function KivoBackdrop() {
  const pulse = useRef<HTMLDivElement>(null);
  const hue = useRef<HTMLDivElement>(null);
  const big = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const calm = reducedMotion();
    let raf = 0;
    let last = 0;
    const drive = createDrive();
    const draw = (t: number) => {
      const a = calm ? null : drive(readLevels(), t);
      if (pulse.current) pulse.current.style.opacity = a ? String(0.06 + 0.2 * a.bass) : "0";
      if (hue.current) hue.current.style.opacity = a ? String(0.03 + 0.09 * a.treble) : "0";
      if (big.current) big.current.style.transform = `scale(${1 + (a?.bass ?? 0) * 0.06})`;
    };
    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      if (t - last < 33) return;
      last = t;
      draw(t);
    };
    if (!calm) raf = requestAnimationFrame(frame);
    draw(0);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="backdrop kivo-scene" aria-hidden>
      <div className="kivo-tiles">
        {Array.from({ length: 16 }, (_, i) => (
          <img key={i} src="/kivo-heart-morph.webp" alt="" />
        ))}
      </div>
      <div ref={big} className="kivo-big">
        <img src="/kivo-heart-morph.webp" alt="" />
      </div>
      <div ref={pulse} className="kivo-pulse" />
      <div ref={hue} className="kivo-hue" />
    </div>
  );
}

/** The page backdrop. Static for reduced-motion users; otherwise it drifts, and pulses on the real spectrum only while REAL EQ is on. */
export function Backdrop() {
  const { bg, theme } = useLook();
  return bg === "kivo" ? <KivoBackdrop /> : <CanvasBackdrop bg={bg} theme={theme} />;
}

function CanvasBackdrop({ bg, theme }: { bg: BackgroundId; theme: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  // `theme` is a dependency because the scenes read the theme's colours when they paint: a new theme needs a new frame.
  useEffect(() => {
    if (bg === "kivo") return;
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const calm = reducedMotion();
    let w = 0;
    let h = 0;
    let painter: Painter = () => {};

    const drive = createDrive();
    const draw = (t: number) => painter(ctx, calm ? 0 : t, calm ? null : drive(readLevels(), t));
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
