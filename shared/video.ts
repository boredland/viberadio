/** YouTube's playlist RSS feed lists at most this many videos, whatever the playlist's real length. */
export const MAX_PLAYLIST_VIDEOS = 15;

const SLACK_LINK = /<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/g;
// Substring matching also covers music.youtube.com and m.youtube.com. Playlist-only URLs yield nothing.
const VIDEO_URL =
  /(?:youtube\.com\/watch\?(?:[^\s]*&)?v=|youtu\.be\/|youtube\.com\/(?:shorts|live|embed)\/)([A-Za-z0-9_-]{11})/g;
const URL_TOKEN = /https?:\/\/[^\s<>|]+/g;
// Real ids are 13 (some mixes) to 41 (albums) characters; the bounds only reject obvious junk.
const PLAYLIST_ID = /^[A-Za-z0-9_-]{12,64}$/;

/** Slack link markup unwrapped, and its `&amp;` escape undone: otherwise `watch?list=…&amp;v=…` hides the `v=`. */
function plain(text: string): string {
  return text.replace(SLACK_LINK, "$1").replace(/&amp;/g, "&");
}

/** Video ids in order of appearance, deduplicated. Accepts Slack link markup (`<url|label>`) as well as plain text. */
export function extractVideoIds(text: string): string[] {
  const ids: string[] = [];
  for (const m of plain(text).matchAll(VIDEO_URL)) {
    if (!ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

/**
 * Playlist ids from `/playlist?list=` links, or `/watch?list=` links that carry no `v`. A video link that also has
 * `list=` is a video: that is what gets copied while a playlist or mix is playing, not a request to add the whole list.
 */
export function extractPlaylistIds(text: string): string[] {
  const ids: string[] = [];
  for (const raw of plain(text).match(URL_TOKEN) ?? []) {
    let url: URL;
    try {
      // Trailing punctuation belongs to the sentence around the link, not to it.
      url = new URL(raw.replace(/[.,;:!?)\]'"]+$/, ""));
    } catch {
      continue;
    }
    if (url.hostname !== "youtube.com" && !url.hostname.endsWith(".youtube.com")) continue;
    const isList = url.pathname === "/playlist" || (url.pathname === "/watch" && !url.searchParams.has("v"));
    const id = url.searchParams.get("list");
    if (isList && id && PLAYLIST_ID.test(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}
