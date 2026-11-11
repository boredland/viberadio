import { useState } from "react";
import { EQ_FREQS, EQ_MAX_DB, FLAT, PREAMP_MIN_DB, PRESETS, clone, loadEq, saveEq, type EqSettings } from "./eq";
import { setEqBand, setEqPreamp } from "./tabAudio";

const label = (hz: number): string => (hz >= 1000 ? `${hz / 1000}K` : String(hz));

/** Preamp and ten band sliders for the live equalizer. Rendered only while tab audio is in EQ mode. */
export function EqPanel() {
  const [eq, setEq] = useState<EqSettings>(loadEq);

  const apply = (next: EqSettings) => {
    setEq(next);
    saveEq(next);
    setEqPreamp(next.preamp);
    next.bands.forEach((db, i) => setEqBand(i, db));
  };

  const band = (i: number, db: number) => {
    const next = clone(eq);
    next.bands[i] = db;
    setEq(next);
    saveEq(next);
    setEqBand(i, db);
  };

  const preamp = (db: number) => {
    const next = clone(eq);
    next.preamp = db;
    setEq(next);
    saveEq(next);
    setEqPreamp(db);
  };

  return (
    <div className="eqp" role="group" aria-label="Equalizer">
      <div className="eqp-presets">
        {PRESETS.map((p) => (
          <button key={p.name} className="btn chip" onClick={() => apply(clone(p.settings))}>
            {p.name}
          </button>
        ))}
      </div>
      <div className="eqp-sliders">
        <label className="eqp-col">
          <input
            type="range"
            min={PREAMP_MIN_DB}
            max={EQ_MAX_DB}
            step={1}
            value={eq.preamp}
            aria-label="Preamp"
            aria-valuetext={`${eq.preamp} dB`}
            onChange={(e) => preamp(Number(e.target.value))}
            onDoubleClick={() => preamp(FLAT.preamp)}
          />
          <span>PRE</span>
        </label>
        {EQ_FREQS.map((hz, i) => (
          <label className="eqp-col" key={hz}>
            <input
              type="range"
              min={-EQ_MAX_DB}
              max={EQ_MAX_DB}
              step={1}
              value={eq.bands[i]}
              aria-label={`${hz} Hz`}
              aria-valuetext={`${eq.bands[i]} dB`}
              onChange={(e) => band(i, Number(e.target.value))}
              onDoubleClick={() => band(i, 0)}
            />
            <span>{label(hz)}</span>
          </label>
        ))}
      </div>
      <p className="dim">+{EQ_MAX_DB} / -{EQ_MAX_DB} dB. Double-click a slider to centre it.</p>
    </div>
  );
}
