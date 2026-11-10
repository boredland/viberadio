export type Track = {
  /** `${Date.now()}-${videoId}`, unique per play */
  id: string;
  videoId: string;
  title: string;
  author: string;
  thumbnailUrl: string;
  source: "queue" | "history";
};

export type CurrentTrack = Track & { startedAtMs: number };

export type StateMessage = {
  type: "state";
  serverNow: number;
  now: CurrentTrack | null;
  queue: Track[];
  listeners: number;
  librarySize: number;
  indexing: boolean;
};

export type ServerMessage = StateMessage | { type: "pong"; t0: number; serverNow: number };

export type ClientMessage =
  | { type: "ping"; t0: number }
  | { type: "next" }
  | { type: "ended"; id: string }
  | { type: "error"; id: string; code: number }
  /** Drops a track (by Track.id) from the queue and from history rotation; skips it if it is playing. */
  | { type: "remove"; id: string }
  /** Same, by video id: for entries that exist only in the history rotation and have no queue/current Track id. */
  | { type: "removeVideo"; videoId: string };

export type LibraryRow = { videoId: string; title: string | null; author: string | null };
/** GET /api/station/:token/library: one page of the rotation, newest post first. */
export type LibraryPage = { rows: LibraryRow[]; total: number; offset: number };
