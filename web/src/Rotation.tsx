import { useCallback, useEffect, useRef, useState } from "react";
import type { LibraryPage, LibraryRow } from "../../shared/protocol";
import { Win } from "./ui";

const CONFIRM_MS = 4000;
/** Must match the server's page size (LIBRARY_PAGE): offsets are computed in multiples of it. */
const PAGE_SIZE = 15;

type Props = {
  token: string;
  /** Bumps whenever the station changes, so an open list drops entries removed by someone else. */
  version: string;
  connected: boolean;
  onRemove: (videoId: string) => void;
};

/**
 * The history rotation: every playable video the station would fall back to, newest post first. This is the only place
 * an already-played entry can be removed from, since the playlist above shows just what is playing and queued.
 * Loaded on demand: listing backfilled rows costs a title lookup each, which nobody should pay unless they look.
 */
export function Rotation({ token, version, connected, onRemove }: Props) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<LibraryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  // A response for an older request (or a closed list) must not overwrite a newer one.
  const seq = useRef(0);
  const rowsRef = useRef<LibraryRow[]>([]);
  rowsRef.current = rows;

  const fetchPage = useCallback(
    async (offset: number): Promise<LibraryPage> => {
      const res = await fetch(`/api/station/${encodeURIComponent(token)}/library?offset=${offset}&limit=${PAGE_SIZE}`);
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as LibraryPage;
    },
    [token],
  );

  /** Replaces the list with its first `count` rows, so rows the listener paged in with MORE survive a refresh. */
  const reload = useCallback(
    async (count: number) => {
      const mine = ++seq.current;
      setLoading(true);
      setFailed(false);
      try {
        const offsets = Array.from({ length: Math.max(1, Math.ceil(count / PAGE_SIZE)) }, (_, i) => i * PAGE_SIZE);
        const pages = await Promise.all(offsets.map(fetchPage));
        if (mine !== seq.current) return;
        const seen = new Set<string>();
        setRows(pages.flatMap((p) => p.rows).filter((r) => !seen.has(r.videoId) && seen.add(r.videoId)));
        setTotal(pages[0].total);
      } catch {
        if (mine === seq.current) setFailed(true);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [fetchPage],
  );

  const more = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setFailed(false);
    try {
      const page = await fetchPage(rowsRef.current.length);
      if (mine !== seq.current) return;
      setTotal(page.total);
      setRows((prev) => [...prev, ...page.rows.filter((r) => !prev.some((p) => p.videoId === r.videoId))]);
    } catch {
      if (mine === seq.current) setFailed(true);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [fetchPage]);

  // Reload when opened and whenever the station changes while it is open (a removal by anyone), keeping as many rows as
  // are already shown.
  useEffect(() => {
    if (open) void reload(Math.max(PAGE_SIZE, rowsRef.current.length));
    else seq.current++;
  }, [open, version, reload]);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(null), CONFIRM_MS);
    return () => clearTimeout(t);
  }, [armed]);

  return (
    <Win title="ROTATION" className={open ? "" : "closed"}>
      <button className="btn quiet" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? "▲ HIDE ROTATION" : "▼ SHOW ROTATION (remove old entries)"}
      </button>
      {open && (
        <>
          {failed && <p className="banner">Couldn't load the rotation. Try again.</p>}
          {rows.length > 0 && (
            <ol className="playlist rotation">
              {rows.map((r) => {
                const isArmed = armed === r.videoId;
                const label = r.title ?? r.videoId;
                return (
                  <li key={r.videoId}>
                    <span className="t">
                      {label} {r.author && <small>— {r.author}</small>}
                    </span>
                    {r.addedBy && (
                      <span className="by" title={`Added by ${r.addedBy}`}>
                        +{r.addedBy}
                      </span>
                    )}
                    <button
                      className={isArmed ? "x armed" : "x"}
                      disabled={!connected}
                      aria-label={isArmed ? `Confirm removing ${label}` : `Remove ${label}`}
                      onClick={() => {
                        if (!isArmed) return setArmed(r.videoId);
                        onRemove(r.videoId);
                        setArmed(null);
                        // Gone immediately for this listener; the version bump reloads the authoritative list.
                        setRows((prev) => prev.filter((p) => p.videoId !== r.videoId));
                        setTotal((n) => Math.max(0, n - 1));
                      }}
                    >
                      {isArmed ? "REMOVE?" : "✕"}
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
          {!loading && !failed && rows.length === 0 && <p className="dim">The rotation is empty.</p>}
          {loading && <p className="dim">Loading…</p>}
          {!loading && rows.length < total && (
            <button className="btn" onClick={() => void more()}>
              MORE ({total - rows.length})
            </button>
          )}
        </>
      )}
    </Win>
  );
}
