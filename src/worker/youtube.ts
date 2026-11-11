import { MAX_PLAYLIST_VIDEOS } from "../../shared/video";

export type VideoMeta = { title: string; author: string; thumbnailUrl: string };

/** oEmbed answers non-200 for removed, private and embedding-disabled videos. */
export async function fetchVideoMeta(videoId: string): Promise<VideoMeta | null> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
    if (res.status !== 200) return null;
    const j = (await res.json()) as { title: string; author_name: string; thumbnail_url: string };
    return { title: j.title, author: j.author_name, thumbnailUrl: j.thumbnail_url };
  } catch {
    return null;
  }
}

/** Short, because this runs inside the add path and the track advance: a slow YouTube must delay neither for long. */
const CATEGORY_TIMEOUT_MS = 3000;

/**
 * The category the uploader gave a video ("Music", "Education", ...), from the same player endpoint the watch page calls.
 * That answer is about 10 KB, where the watch page is about 1.4 MB. It is not a documented API, so any failure (blocked
 * address, changed shape, timeout) is null and callers must treat null as "unknown", never as "not music".
 */
export async function fetchVideoCategory(videoId: string): Promise<string | null> {
  try {
    const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://www.youtube.com" },
      body: JSON.stringify({
        videoId,
        // hl=en so the name is English: the check below compares names.
        context: { client: { clientName: "WEB", clientVersion: "2.20250101.00.00", hl: "en" } },
        contentCheckOk: true,
        racyCheckOk: true,
      }),
      signal: AbortSignal.timeout(CATEGORY_TIMEOUT_MS),
    });
    if (res.status !== 200) return null;
    const m = /"category":"((?:[^"\\]|\\.)+)"/.exec(await res.text());
    return m ? m[1].replace(/\\u0026/g, "&") : null;
  } catch {
    return null;
  }
}

/** YouTube's fixed category names other than Music. */
const NON_MUSIC_CATEGORIES = new Set([
  "Film & Animation",
  "Autos & Vehicles",
  "Pets & Animals",
  "Sports",
  "Travel & Events",
  "Gaming",
  "People & Blogs",
  "Comedy",
  "Entertainment",
  "News & Politics",
  "Howto & Style",
  "Education",
  "Science & Technology",
  "Nonprofits & Activism",
]);

/**
 * True only for a category that is certainly not music. A missing category, or a name not on the list (a localized one, or a
 * category YouTube adds later), is not enough to turn a link away, so the filter fails open.
 */
export function isNonMusic(category: string | null): category is string {
  return category !== null && NON_MUSIC_CATEGORIES.has(category);
}

export type PlaylistVideo = VideoMeta & { videoId: string };
export type Playlist = { title: string; videos: PlaylistVideo[] };

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

// One pass, so `&amp;lt;` becomes the text `&lt;` and not `<`. Unknown entities are left as they are.
function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (m, dec?: string, hex?: string, name?: string) => {
    const cp = dec ? Number(dec) : hex ? parseInt(hex, 16) : null;
    if (cp !== null) return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    return NAMED_ENTITIES[name!.toLowerCase()] ?? m;
  });
}

/**
 * Reads a public playlist from YouTube's RSS feed: no key, and each entry already carries title, author and thumbnail,
 * so no per-video oEmbed call is needed. Null for private playlists, album playlists (OLAK…), unknown ids and any failure.
 */
export async function fetchPlaylist(playlistId: string): Promise<Playlist | null> {
  try {
    const res = await fetch(`https://www.youtube.com/feeds/videos.xml?playlist_id=${encodeURIComponent(playlistId)}`);
    if (res.status !== 200) return null;
    const [head, ...entries] = (await res.text()).split("<entry>");
    const videos: PlaylistVideo[] = [];
    for (const e of entries) {
      const videoId = e.match(/<yt:videoId>([A-Za-z0-9_-]{11})<\/yt:videoId>/)?.[1];
      const title = e.match(/<title>([^<]*)<\/title>/)?.[1];
      if (!videoId || title === undefined) continue;
      videos.push({
        videoId,
        title: decodeEntities(title),
        author: decodeEntities(e.match(/<author>\s*<name>([^<]*)<\/name>/)?.[1] ?? ""),
        thumbnailUrl: decodeEntities(e.match(/<media:thumbnail url="([^"]+)"/)?.[1] ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`),
      });
    }
    return { title: decodeEntities(head.match(/<title>([^<]*)<\/title>/)?.[1] ?? ""), videos: videos.slice(0, MAX_PLAYLIST_VIDEOS) };
  } catch {
    return null;
  }
}
