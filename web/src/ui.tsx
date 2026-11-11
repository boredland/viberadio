import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { colors } from "./theme";
import { getBeat } from "./beat";
import { readLevels } from "./tabAudio";

export const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A Winamp-style window: striped title bar over a bevelled body. */
export function Win({ title, children, className = "" }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={`win ${className}`}>
      <div className="titlebar">
        <span>{title}</span>
      </div>
      <div className="win-body">{children}</div>
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

const BARS = 20;

/**
 * Decorative spectrum. The YouTube iframe exposes no audio data, so the bars are synthetic: they pulse on the beat
 * (station clock) and move randomly between beats. They fall to zero when nothing plays.
 */
export function Visualizer({ active }: { active: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const calm = reducedMotion();
    const level = new Array<number>(BARS).fill(0);
    const target = new Array<number>(BARS).fill(0);
    const peak = new Array<number>(BARS).fill(0);
    let raf = 0;
    let last = 0;

    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      if (t - last < 45) return;
      last = t;
      const w = el.width;
      const h = el.height;
      const bw = w / BARS;
      ctx.clearRect(0, 0, w, h);
      // One read per frame, shared by every bar.
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
        level[i] += (target[i] - level[i]) * 0.45;
        peak[i] = Math.max(level[i], peak[i] - 0.03);
        const segs = Math.round(level[i] * 10);
        for (let s = 0; s < segs; s++) {
          const c = colors();
          ctx.fillStyle = s < 6 ? c.accent : s < 8 ? c.vizMid : c.vizHi;
          ctx.fillRect(i * bw + 1, h - (s + 1) * (h / 10) + 1, bw - 2, h / 10 - 1);
        }
        const p = Math.round(peak[i] * 10);
        if (p > 0) {
          ctx.fillStyle = colors().peak;
          ctx.fillRect(i * bw + 1, h - p * (h / 10), bw - 2, 2);
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas className="viz" ref={canvas} width={160} height={50} aria-hidden />;
}
