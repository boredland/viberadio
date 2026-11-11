import { useMemo, useRef, useState } from "react";
import { MAX_PLAYLIST_VIDEOS, extractPlaylistIds, extractVideoIds } from "../../shared/video";
import { forgetStation, lastStation } from "./pwa";
import { Win } from "./ui";

type Result = {
  added: { videoId: string; title: string }[];
  alreadyQueued?: { videoId: string; title: string }[];
  playlists?: { id: string; title: string; added: number; truncated: boolean }[];
  playlistsFailed?: string[];
  unavailable: string[];
  rejected?: { videoId: string; category: string }[];
};
type Phase = { kind: "idle" } | { kind: "sending" } | { kind: "done"; result: Result } | { kind: "error"; message: string };

/**
 * Landing page of the PWA share target (manifest `share_target`, GET /share?title&text&url).
 * Adding needs a tap rather than happening on load: opening /share is a plain GET, and any page could link here, so a
 * visit alone must not change the station.
 */
export function Share() {
  const { ids, playlists } = useMemo(() => {
    const q = new URLSearchParams(location.search);
    // YouTube's share sheet puts the link in `text` on Android and `url` elsewhere; scan all three.
    const shared = ["title", "text", "url"].map((k) => q.get(k) ?? "").join(" ");
    return { ids: extractVideoIds(shared), playlists: extractPlaylistIds(shared) };
  }, []);
  const [token] = useState(() => lastStation());
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // State updates after the next render, so a fast second tap would still see "idle"; a ref blocks it synchronously.
  const inFlight = useRef(false);

  const add = async () => {
    if (!token || inFlight.current) return;
    inFlight.current = true;
    setPhase({ kind: "sending" });
    try {
      const text = [
        ...ids.map((id) => `https://youtu.be/${id}`),
        ...playlists.map((id) => `https://www.youtube.com/playlist?list=${id}`),
      ].join(" ");
      const res = await fetch(`/api/station/${encodeURIComponent(token)}/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (res.status === 404) {
        forgetStation(token);
        return setPhase({ kind: "error", message: "That station no longer exists. Open a station link first." });
      }
      if (res.status === 422) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        return setPhase({
          kind: "error",
          message:
            body.error === "none_playable"
              ? "Nothing there can be played here: the video is unavailable or can't be embedded, or the playlist is private or an album."
              : body.error === "not_music"
                ? "Only music goes on this radio, and what you shared is filed under another category on YouTube."
                : body.error === "nothing_new"
                  ? "The playlist was read, but its videos are the ones already in what you shared."
                  : "No YouTube video in what you shared.",
        });
      }
      if (!res.ok) return setPhase({ kind: "error", message: `Couldn't add it (${res.status}). Try again.` });
      setPhase({ kind: "done", result: (await res.json()) as Result });
    } catch {
      setPhase({ kind: "error", message: "No connection. Try again when you're back online." });
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <main className="stack">
      <Win title="SHARE">
        {ids.length + playlists.length === 0 ? (
          <>
            <p className="lcd-text err">NO VIDEO FOUND</p>
            <p className="dim">Share a YouTube or YouTube Music link to add it to your radio.</p>
          </>
        ) : !token ? (
          <>
            <p className="lcd-text err">NO STATION</p>
            <p className="dim">Open your station link once (from Slack, with /viberadio), then share again.</p>
          </>
        ) : phase.kind === "done" ? (
          <>
            <p className="lcd-text">
              {phase.result.added.length === 0 && (phase.result.alreadyQueued?.length ?? 0) > 0 && !phase.result.playlists?.length
                ? "ALREADY IN THE QUEUE"
                : "★ ADDED TO RADIO"}
            </p>
            <ul className="shared">
              {phase.result.added.map((a) => (
                <li key={a.videoId}>{a.title}</li>
              ))}
            </ul>
            {(phase.result.alreadyQueued?.length ?? 0) > 0 && (
              <p className="dim">{phase.result.alreadyQueued!.length} already in the queue or playing, not queued again</p>
            )}
            {phase.result.playlists?.map((p) => (
              <p key={p.id} className="dim">
                {p.added} {p.added === 1 ? "video" : "videos"} from “{p.title}”
                {p.truncated ? ` (YouTube's feed lists at most ${MAX_PLAYLIST_VIDEOS} per playlist)` : ""}
              </p>
            ))}
            {(phase.result.playlistsFailed?.length ?? 0) > 0 && (
              <p className="banner">{phase.result.playlistsFailed!.length} playlist(s) couldn't be read, skipped</p>
            )}
            {phase.result.unavailable.length > 0 && (
              <p className="banner">{phase.result.unavailable.length} unavailable or not embeddable, skipped</p>
            )}
            {(phase.result.rejected?.length ?? 0) > 0 && (
              <p className="banner">{phase.result.rejected!.length} not music, skipped</p>
            )}
          </>
        ) : (
          <>
            <p className="lcd-text">
              {[
                ids.length > 0 && `${ids.length} ${ids.length === 1 ? "TRACK" : "TRACKS"}`,
                playlists.length > 0 && `${playlists.length} ${playlists.length === 1 ? "PLAYLIST" : "PLAYLISTS"}`,
              ]
                .filter(Boolean)
                .join(" + ")}{" "}
              DETECTED
            </p>
            <ul className="shared">
              {ids.map((id) => (
                <li key={id}>youtu.be/{id}</li>
              ))}
              {playlists.map((id) => (
                <li key={id}>playlist {id}</li>
              ))}
            </ul>
            {phase.kind === "error" && <p className="banner">{phase.message}</p>}
            <button className="btn tune" disabled={phase.kind === "sending"} onClick={add}>
              {phase.kind === "sending" ? "ADDING…" : "+ ADD TO RADIO"}
            </button>
          </>
        )}
        {token && (
          <a className="btn link" href={`/s/${encodeURIComponent(token)}`}>
            {phase.kind === "done" ? "OPEN STATION ▶" : "OPEN STATION"}
          </a>
        )}
        {!token && (
          <a className="btn link" href="/">
            HOME
          </a>
        )}
      </Win>
    </main>
  );
}
