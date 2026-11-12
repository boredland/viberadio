import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { colors } from "./theme";
import { getBeat } from "./beat";
import { readLevels } from "./tabAudio";
import { BARS, PAINTERS, loadViz, newVizState, nextViz, saveViz, vizLabel, type VizId } from "./viz";

export const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Phones: the stacked windows fill the screen and cover the backdrop, so some windows start folded there. */
const NARROW = "(max-width: 600px)";

function loadFolded(key: string, foldedOnNarrow?: boolean): boolean {
  try {
    const saved = localStorage.getItem(`viberadio:fold:${key}`);
    if (saved !== null) return saved === "1";
  } catch {
    // storage unavailable: fall through to the default
  }
  return Boolean(foldedOnNarrow) && window.matchMedia(NARROW).matches;
}

/** Without `fold` a window is a plain frame. With it the body can be hidden behind a button, and the choice is saved per device. */
type Fold = {
  /** Storage key, shared by every page that shows this window. */
  key: string;
  /** Noun in the button: "SHOW <label>" / "HIDE <label>". */
  label: string;
  /**
   * Keep the content laid out (off-screen) while folded. The YouTube player must: a display:none iframe can be refused
   * playback, and the IFrame API needs a viewport of at least 200x200.
   */
  keepLive?: boolean;
  /** Start folded on a narrow screen when this device has no saved choice. The window's own choice, once made, always wins. */
  foldedOnNarrow?: boolean;
};

/** A Winamp-style window: striped title bar over a bevelled body. */
export function Win({ title, children, className = "", fold }: { title: string; children: ReactNode; className?: string; fold?: Fold }) {
  const [folded, setFolded] = useState(() => (fold ? loadFolded(fold.key, fold.foldedOnNarrow) : false));
  const toggle = () => {
    if (!fold) return;
    setFolded((f) => {
      const next = !f;
      try {
        localStorage.setItem(`viberadio:fold:${fold.key}`, next ? "1" : "0");
      } catch {
        // storage unavailable: the fold still works for this visit
      }
      return next;
    });
  };
  return (
    <section className={`win ${className}`}>
      <div className="titlebar">
        <span>{title}</span>
      </div>
      <div className="win-body">
        {fold && (
          <button type="button" className="btn quiet" aria-expanded={!folded} onClick={toggle}>
            {folded ? `▼ SHOW ${fold.label}` : `▲ HIDE ${fold.label}`}
          </button>
        )}
        {fold ? <div className={`fold-inner${folded ? (fold.keepLive ? " fold-away" : " fold-hidden") : ""}`}>{children}</div> : children}
      </div>
    </section>
  );
}

/** Scrolls only when the text overflows, like the classic song-title ticker. */
export function Marquee({ text }: { text: string }) {
  const box = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [width, setWidth] = useState(0);

  // Measured on a hidden single copy: the visible one is duplicated while scrolling, which would skew its own width.
  useLayoutEffect(() => {
    if (!box.current || !probe.current) return;
    const w = probe.current.offsetWidth;
    setWidth(w);
    setOverflow(w > box.current.clientWidth);
  }, [text]);

  return (
    <div className="marquee" ref={box} title={text}>
      <span className="marquee-probe" ref={probe} aria-hidden>
        {text}
      </span>
      {overflow ? (
        <span className="marquee-run" style={{ ["--dur" as string]: `${Math.max(8, width / 38)}s` }}>
          <span>{text}</span>
          <span aria-hidden>{text}</span>
        </span>
      ) : (
        <span>{text}</span>
      )}
    </div>
  );
}

/**
 * Decorative spectrum with five displays; clicking cycles them and the choice is saved. Without REAL EQ the YouTube iframe
 * exposes no audio, so the levels are synthetic: they pulse on the beat (station clock) and move randomly between beats.
 * They fall to zero when nothing plays.
 */
export function Visualizer({ active }: { active: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [mode, setMode] = useState<VizId>(loadViz);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  /** rAF timestamp until which the mode name is drawn over the display. */
  const flashUntil = useRef(0);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const calm = reducedMotion();
    const s = newVizState();
    const target = new Array<number>(BARS).fill(0);
    let raf = 0;
    let last = 0;

    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      if (t - last < 33) return;
      last = t;
      const w = el.width;
      const h = el.height;
      ctx.clearRect(0, 0, w, h);
      // One read per frame, shared by every display.
      const real = activeRef.current && !calm ? readLevels() : null;
      for (let i = 0; i < BARS; i++) {
        if (activeRef.current && !calm) {
          if (real) {
            target[i] = real[i];
          } else {
            const beat = getBeat();
            const pulse = beat === null ? 0 : Math.exp(-(beat - Math.floor(beat)) * 5);
            const base = Math.random() < 0.35 ? Math.random() * (1 - (i / BARS) * 0.55) : target[i] * 0.92;
            target[i] = Math.max(base, pulse * (1 - (i / BARS) * 0.3));
          }
        } else {
          target[i] = 0;
        }
        // Snap up on a rise, fall back more slowly: a kick should land when it is heard, not a few frames later.
        s.level[i] += (target[i] - s.level[i]) * (target[i] > s.level[i] ? 0.85 : 0.4);
        s.peak[i] = Math.max(s.level[i], s.peak[i] - 0.03);
      }
      s.head = (s.head + 1) % s.history.length;
      for (let i = 0; i < BARS; i++) s.history[s.head][i] = s.level[i];
      PAINTERS[modeRef.current](ctx, w, h, s);

      if (t < flashUntil.current) {
        const label = vizLabel(modeRef.current);
        ctx.font = "bold 15px ui-monospace, Menlo, monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const c = colors();
        const tw = ctx.measureText(label).width + 12;
        ctx.fillStyle = `rgba(${c.bgRgb}, 0.82)`;
        ctx.fillRect((w - tw) / 2, h / 2 - 11, tw, 22);
        ctx.fillStyle = c.accent;
        ctx.fillText(label, w / 2, h / 2 + 1);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const cycle = () => {
    // The updater form advances from the latest state, so two clicks before a re-render still move two modes.
    setMode((m) => {
      const next = nextViz(m);
      saveViz(next);
      return next;
    });
    flashUntil.current = performance.now() + 1100;
  };

  return (
    <button
      type="button"
      className="viz-btn"
      onClick={cycle}
      aria-label={`Display: ${vizLabel(mode)}. Press to change`}
      title={`${vizLabel(mode)} (click to change)`}
    >
      <canvas className="viz" ref={canvas} width={160} height={50} aria-hidden />
    </button>
  );
}
