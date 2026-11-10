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
  | { type: "error"; id: string; code: number };
