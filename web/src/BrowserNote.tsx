import { useState } from "react";
import { tabAudioSupported } from "./tabAudio";

const KEY = "viberadio:browser-notice-dismissed";

/**
 * One dismissible note when the station is opened outside desktop Chrome or Edge. The station itself plays everywhere;
 * what is missing there is tab audio, so the visuals can only follow nothing (or an invented pulse on the bars). The same
 * support test as the REAL EQ toggle decides, so the note and the button never disagree.
 */
export function BrowserNote() {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(KEY) === "1";
    } catch {
      return false;
    }
  });

  if (tabAudioSupported() || dismissed) return null;
  return (
    <p className="banner browser-note" role="note">
      BEST IN DESKTOP CHROME OR EDGE. THE STATION PLAYS ANYWHERE, BUT THE REAL SOUND EQ NEEDS IT.
      <button
        className="btn chip"
        onClick={() => {
          try {
            localStorage.setItem(KEY, "1");
          } catch {
            // private mode: dismissed for this visit only
          }
          setDismissed(true);
        }}
        aria-label="Dismiss browser note"
      >
        GOT IT
      </button>
    </p>
  );
}
