const SLACK_LINK = /<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/g;
// Substring matching also covers music.youtube.com and m.youtube.com. Playlist-only URLs yield nothing.
const VIDEO_URL =
  /(?:youtube\.com\/watch\?(?:[^\s]*&)?v=|youtu\.be\/|youtube\.com\/(?:shorts|live|embed)\/)([A-Za-z0-9_-]{11})/g;

/** Video ids in order of appearance, deduplicated. Accepts Slack link markup (`<url|label>`) as well as plain text. */
export function extractVideoIds(text: string): string[] {
  const plain = text.replace(SLACK_LINK, "$1");
  const ids: string[] = [];
  for (const m of plain.matchAll(VIDEO_URL)) {
    if (!ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}
