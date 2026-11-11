import { BACKGROUNDS, THEMES, setBackground, setTheme, useLook } from "./theme";
import { Win } from "./ui";

/** Colour theme and backdrop pickers. The choice is saved on this device and applies to every page. */
export function Look() {
  const look = useLook();
  return (
    <Win title="LOOK" fold={{ key: "look", label: "LOOK" }}>
      <div role="group" aria-label="Colour theme" className="chips">
        {THEMES.map((t) => (
          <button
            key={t.id}
            type="button"
            className="btn chip"
            aria-pressed={look.theme === t.id}
            onClick={() => setTheme(t.id)}
          >
            <span className="sw" style={{ background: t.swatch }} aria-hidden />
            {t.label}
          </button>
        ))}
      </div>
      <div role="group" aria-label="Background" className="chips">
        {BACKGROUNDS.map((b) => (
          <button
            key={b.id}
            type="button"
            className="btn chip"
            aria-pressed={look.bg === b.id}
            onClick={() => setBackground(b.id)}
          >
            {b.label}
          </button>
        ))}
      </div>
    </Win>
  );
}
