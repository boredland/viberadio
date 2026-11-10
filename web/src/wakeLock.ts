import { useCallback, useEffect, useRef, useState } from "react";

const PREF_KEY = "viberadio:keep-awake";

/** Screen Wake Lock is Chromium and Safari 16.4+; Firefox on Android lacks it. Absent means the toggle is hidden. */
export const wakeLockSupported = (): boolean => typeof navigator !== "undefined" && "wakeLock" in navigator;

function loadPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === "1";
  } catch {
    return false;
  }
}

function savePref(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? "1" : "0");
  } catch {
    // storage unavailable: the choice just does not survive a reload
  }
}

/**
 * Keeps the screen from sleeping while listening. This does not, and cannot, make the player play in the background:
 * the page stays visible and displayed, which is what the YouTube developer policy requires of a playing embed. The
 * cost is battery, so it is a listener's choice and never on by default.
 *
 * The browser releases a lock whenever the page is hidden, so it is taken again each time the page becomes visible.
 * `active` is true only while a lock is actually held, so the UI never claims more than the browser granted.
 */
export function useKeepAwake(listening: boolean) {
  const [wanted, setWanted] = useState(loadPref);
  const [active, setActive] = useState(false);
  const sentinel = useRef<WakeLockSentinel | null>(null);

  const release = useCallback(() => {
    const s = sentinel.current;
    sentinel.current = null;
    setActive(false);
    void s?.release().catch(() => {});
  }, []);

  const acquire = useCallback(async () => {
    if (!wakeLockSupported() || sentinel.current || document.visibilityState !== "visible") return;
    try {
      const s = await navigator.wakeLock.request("screen");
      // The wanted/listening state may have changed while the request was pending: do not keep a lock nobody asked for.
      if (sentinel.current || document.visibilityState !== "visible") return void s.release().catch(() => {});
      sentinel.current = s;
      setActive(true);
      s.addEventListener("release", () => {
        if (sentinel.current === s) {
          sentinel.current = null;
          setActive(false);
        }
      });
    } catch {
      // Refused (low battery, battery saver, permissions policy): stay inactive and let the toggle show it.
      setActive(false);
    }
  }, []);

  useEffect(() => {
    if (!(wanted && listening)) return release();
    void acquire();
    const onVisible = () => document.visibilityState === "visible" && void acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      release();
    };
  }, [wanted, listening, acquire, release]);

  const toggle = useCallback(() => {
    setWanted((w) => {
      savePref(!w);
      return !w;
    });
  }, []);

  return { supported: wakeLockSupported(), wanted, active, toggle };
}
