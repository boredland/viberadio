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

  const acquire = useCallback(async (live: () => boolean) => {
    if (!wakeLockSupported() || sentinel.current || document.visibilityState !== "visible") return;
    try {
      const s = await navigator.wakeLock.request("screen");
      // The request can resolve after the listener turned the toggle off, left the station, or hid the page. Holding the
      // lock then would keep the screen on with nothing asking for it, so hand it straight back.
      if (!live() || sentinel.current || document.visibilityState !== "visible") return void s.release().catch(() => {});
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
    // One flag per effect run: cleanup flips it, so a request still pending from this run cannot keep a lock afterwards.
    let live = true;
    const isLive = () => live;
    void acquire(isLive);
    const onVisible = () => document.visibilityState === "visible" && void acquire(isLive);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
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
