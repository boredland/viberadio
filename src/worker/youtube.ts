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

/** The part of the Worker environment the category lookup reads. The URL override is for local testing only. */
export type YouTubeEnv = { YOUTUBE_API_KEY?: string; YOUTUBE_API_URL?: string };

export type VideoCategory = { id: string; name: string };

/** videos.list takes at most 50 ids per call, and a call costs one quota unit whatever the id count. */
const CATEGORY_BATCH = 50;
/** Short, because this runs inside the add path and the track advance: a slow YouTube must delay neither for long. */
const CATEGORY_TIMEOUT_MS = 4000;
const MUSIC_CATEGORY_ID = "10";

/** YouTube's category ids (language independent, unlike the names). Only used to word a rejection. */
const CATEGORY_NAMES: Record<string, string> = {
  "1": "Film & Animation", "2": "Autos & Vehicles", "10": "Music", "15": "Pets & Animals", "17": "Sports",
  "18": "Short Movies", "19": "Travel & Events", "20": "Gaming", "21": "Videoblogging", "22": "People & Blogs",
  "23": "Comedy", "24": "Entertainment", "25": "News & Politics", "26": "Howto & Style", "27": "Education",
  "28": "Science & Technology", "29": "Nonprofits & Activism", "30": "Movies", "31": "Anime/Animation",
  "32": "Action/Adventure", "33": "Classics", "34": "Comedy", "35": "Documentary", "36": "Drama", "37": "Family",
  "38": "Foreign", "39": "Horror", "40": "Sci-Fi/Fantasy", "41": "Thriller", "42": "Shorts", "43": "Shows", "44": "Trailers",
};

/**
 * The category the uploader gave each video, from the official YouTube Data API (videos.list). Scraping the watch page or
 * the player endpoint does not work from Cloudflare: YouTube answers those with 429 or "sign in to confirm you're not a
 * bot". Only videos the API answered for are in the result, so an absent id means "unknown", never "not music": no key,
 * an exhausted quota, a timeout and a private video all leave the map without that id, and the filter then lets it through.
 */
export async function fetchVideoCategories(env: YouTubeEnv, videoIds: string[]): Promise<Map<string, VideoCategory>> {
  const out = new Map<string, VideoCategory>();
  const key = env.YOUTUBE_API_KEY;
  const unique = [...new Set(videoIds)];
  if (!key || unique.length === 0) return out;
  const base = env.YOUTUBE_API_URL ?? "https://www.googleapis.com/youtube/v3";
  for (let i = 0; i < unique.length; i += CATEGORY_BATCH) {
    const chunk = unique.slice(i, i + CATEGORY_BATCH);
    try {
      const res = await fetch(`${base}/videos?part=snippet&fields=items(id,snippet(categoryId))&id=${chunk.join(",")}&key=${encodeURIComponent(key)}`, {
        signal: AbortSignal.timeout(CATEGORY_TIMEOUT_MS),
      });
      if (res.status !== 200) {
        console.error("youtube categories", res.status);
        continue;
      }
      const body = (await res.json()) as { items?: { id?: string; snippet?: { categoryId?: string } }[] };
      for (const item of body.items ?? []) {
        const id = item.id;
        const cat = item.snippet?.categoryId;
        if (id && cat) out.set(id, { id: cat, name: CATEGORY_NAMES[cat] ?? `category ${cat}` });
      }
    } catch (e) {
      console.error("youtube categories", e);
    }
  }
  return out;
}

/** True only for a video the API said is in a category other than Music. Unknown (no entry) is not enough to turn it away. */
export function isNonMusic(category: VideoCategory | undefined): category is VideoCategory {
  return category !== undefined && category.id !== MUSIC_CATEGORY_ID;
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
