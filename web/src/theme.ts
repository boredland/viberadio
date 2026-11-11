import { useSyncExternalStore } from "react";

export const THEMES = [
  { id: "phosphor", label: "PHOSPHOR", swatch: "#00ff66" },
  { id: "ice", label: "ICE", swatch: "#3df0ff" },
  { id: "hotpink", label: "HOT PINK", swatch: "#ff4fd8" },
  { id: "violet", label: "VIOLET", swatch: "#b388ff" },
  { id: "mono", label: "MONO", swatch: "#e8e8e8" },
  { id: "sunrise", label: "SUNRISE", swatch: "#ff9f3c" },
] as const;

export const BACKGROUNDS = [
  { id: "sunset", label: "SUNSET" },
  { id: "sunrise", label: "SUNRISE" },
  { id: "matrix", label: "MATRIX" },
  { id: "night", label: "NIGHT" },
  { id: "plain", label: "PLAIN" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];
export type BackgroundId = (typeof BACKGROUNDS)[number]["id"];
export type Look = { theme: ThemeId; bg: BackgroundId };

const THEME_KEY = "viberadio:theme";
const BG_KEY = "viberadio:bg";
const DEFAULT_LOOK: Look = { theme: "phosphor", bg: "sunset" };

/** Top of the sunset sky: also the browser chrome colour while that background is shown. */
export const SUNSET_SKY_TOP = "#08011c";
/** Same for the sunrise sky. */
export const SUNRISE_SKY_TOP = "#0a1a3f";

const SKY_TOP: Record<string, string> = { sunset: SUNSET_SKY_TOP, sunrise: SUNRISE_SKY_TOP };

/** Anything not in the list (an old build's value, a hand-edited one) falls back instead of reaching the DOM. */
function pick<T extends string>(raw: string | null, items: readonly { id: T }[], fallback: T): T {
  return items.find((i) => i.id === raw)?.id ?? fallback;
}

function load(): Look {
  try {
    return {
      theme: pick(localStorage.getItem(THEME_KEY), THEMES, DEFAULT_LOOK.theme),
      bg: pick(localStorage.getItem(BG_KEY), BACKGROUNDS, DEFAULT_LOOK.bg),
    };
  } catch {
    return DEFAULT_LOOK;
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode / storage disabled: the choice holds for this visit only
  }
}

let look: Look = load();
const listeners = new Set<() => void>();

/** CSS reads `data-theme` / `data-bg` on <html>; the browser chrome colour follows the page background. */
function apply(l: Look): void {
  const root = document.documentElement;
  root.dataset.theme = l.theme;
  root.dataset.bg = l.bg;
  const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", SKY_TOP[l.bg] ?? bg);
}

function update(next: Look): void {
  if (next.theme === look.theme && next.bg === look.bg) return;
  look = next;
  apply(next);
  listeners.forEach((l) => l());
}

export function setTheme(theme: ThemeId): void {
  save(THEME_KEY, theme);
  update({ ...look, theme });
}

export function setBackground(bg: BackgroundId): void {
  save(BG_KEY, bg);
  update({ ...look, bg });
}

if (typeof window !== "undefined") {
  apply(look);
  // Another tab changed it: follow, so two open tabs never disagree.
  window.addEventListener("storage", (e) => {
    if (e.key === null || e.key === THEME_KEY || e.key === BG_KEY) update(load());
  });
}

export function useLook(): Look {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => look,
  );
}

export type Colors = {
  accent: string;
  /** "r, g, b" for rgba(): the CSS variable is the single source, so canvas and stylesheet cannot drift. */
  accentRgb: string;
  bg: string;
  bgRgb: string;
  vizMid: string;
  vizHi: string;
  peak: string;
};

function hexRgb(h: string): string {
  const n = parseInt(h.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

let cached: { look: Look; colors: Colors } | null = null;

/** The active theme's colours for canvas drawing, read from the stylesheet once per change. */
export function colors(): Colors {
  if (cached?.look === look) return cached.colors;
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  const bg = v("--bg");
  const c: Colors = {
    accent: v("--accent"),
    accentRgb: v("--accent-rgb"),
    bg,
    bgRgb: hexRgb(bg),
    vizMid: v("--viz-mid"),
    vizHi: v("--viz-hi"),
    peak: v("--peak"),
  };
  cached = { look, colors: c };
  return c;
}
