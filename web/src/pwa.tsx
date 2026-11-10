import { useEffect, useState } from "react";
import { Win } from "./ui";

type InstallPromptEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

/**
 * `beforeinstallprompt` fires once, usually before React has mounted, so it is captured at module load and handed to
 * whichever component asks for it later.
 */
let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    notify();
  });
}

export function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari sets this instead of the media query.
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** iPadOS reports a desktop Mac user agent, hence the touch-point check. */
function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => console.error("service worker registration failed:", err));
  });
}

const LAST_KEY = "viberadio:last-station";

export function rememberStation(token: string): void {
  try {
    localStorage.setItem(LAST_KEY, token);
  } catch {
    // private mode / storage disabled: the app just opens on the landing page next time
  }
}

export function lastStation(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

/** Shown only where installing is possible and has not happened; renders nothing in the installed app. */
export function InstallBar() {
  const [, rerender] = useState(0);
  useEffect(() => {
    const l = () => rerender((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);

  if (isStandalone()) return null;
  if (deferred) {
    const evt = deferred;
    return (
      <Win title="APP">
        <button
          className="btn"
          onClick={async () => {
            await evt.prompt();
            await evt.userChoice;
            // The event can be used once; a dismissed prompt is offered again by the browser later.
            deferred = null;
            notify();
          }}
        >
          ⬇ INSTALL VIBERADIO
        </button>
      </Win>
    );
  }
  if (isIos()) {
    return (
      <Win title="APP">
        <p className="dim">To install: tap Share, then “Add to Home Screen”.</p>
      </Win>
    );
  }
  return null;
}
