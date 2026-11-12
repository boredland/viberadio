import { MAX_PLAYLIST_VIDEOS } from "../../shared/video";

export type VideoMeta = { title: string; author: string; thumbnailUrl: string };

/** Short for the same reason as CATEGORY_TIMEOUT_MS: a hung lookup must not hold up an add or a track advance. */
const OEMBED_TIMEOUT_MS = 4000;

/**
 * oEmbed answers 400, 401, 403 and 404 for ids that do not exist and for removed, private and embedding-disabled videos
 * (measured: a made-up id gets 400 or 404): `null`, a verdict on the video. Anything else that is not 200 (408, 429, 5xx),
 * a timeout and a network error say nothing about the video: `undefined`, so a caller that retires rows must not retire
 * one just because YouTube was slow. Both are falsy, so callers that only want a title can test `!meta`.
 */
export async function fetchVideoMeta(videoId: string): Promise<VideoMeta | null | undefined> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, {
      signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS),
    });
    if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) return null;
    if (res.status !== 200) return undefined;
    const j = (await res.json()) as { title: string; author_name: string; thumbnail_url: string };
    return { title: j.title, author: j.author_name, thumbnailUrl: j.thumbnail_url };
  } catch {
    return undefined;
  }
}

/** The part of the Worker environment the category lookup reads. The URL override is for local testing only. */
export type YouTubeEnv = { YOUTUBE_API_KEY?: string; YOUTUBE_API_URL?: string };

export type VideoCategory = { id: string; name: string; musicTopic: boolean };

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
 * What a category lookup learned. `categories` holds the ids the API gave a category for. `answered` holds every id it
 * answered for, which also covers a video it returned no entry for: a deleted or private video is "answered, no category",
 * which is final, unlike a timeout or an exhausted quota where nothing about the id is known.
 */
export type CategoryLookup = { categories: Map<string, VideoCategory>; answered: Set<string>; badRequest: boolean };

/**
 * The category the uploader gave each video, from the official YouTube Data API (videos.list). Scraping the watch page or
 * the player endpoint does not work from Cloudflare: YouTube answers those with 429 or "sign in to confirm you're not a
 * bot". Only videos the API answered for are in `categories`, so an absent id means "unknown", never "not music": no key,
 * an exhausted quota, a timeout and a private video all leave `categories` without that id, and the filter then lets it
 * through. An id is in `answered` only when its whole batch came back with a 200, so callers can tell a final "no
 * category" from a failed call.
 */
export async function lookupVideoCategories(env: YouTubeEnv, videoIds: string[]): Promise<CategoryLookup> {
  const categories = new Map<string, VideoCategory>();
  const answered = new Set<string>();
  let badRequest = false;
  const key = env.YOUTUBE_API_KEY;
  const unique = [...new Set(videoIds)];
  if (!key || unique.length === 0) return { categories, answered, badRequest };
  const base = env.YOUTUBE_API_URL ?? "https://www.googleapis.com/youtube/v3";
  for (let i = 0; i < unique.length; i += CATEGORY_BATCH) {
    const chunk = unique.slice(i, i + CATEGORY_BATCH);
    try {
      const res = await fetch(`${base}/videos?part=snippet,topicDetails&fields=items(id,snippet(categoryId),topicDetails(topicCategories))&id=${chunk.join(",")}&key=${encodeURIComponent(key)}`, {
        signal: AbortSignal.timeout(CATEGORY_TIMEOUT_MS),
      });
      if (res.status !== 200) {
        console.error("youtube categories", res.status);
        // 400 means this call was malformed or carried an id YouTube refuses, so a smaller call may still be answered. Quota
        // (403), rate limiting (429) and outages (5xx) would fail the same way, so retrying those only burns more calls.
        if (res.status === 400) badRequest = true;
        continue;
      }
      const body = (await res.json()) as {
        items?: { id?: string; snippet?: { categoryId?: string }; topicDetails?: { topicCategories?: string[] } }[];
      };
      for (const id of chunk) answered.add(id);
      for (const item of body.items ?? []) {
        const id = item.id;
        const cat = item.snippet?.categoryId;
        // Wikipedia topic URLs: ".../wiki/Music" is the umbrella topic; ".../wiki/Pop_music" and the like are sub-genres that
        // only ever appear beside it, so the umbrella alone is the test.
        const musicTopic = (item.topicDetails?.topicCategories ?? []).some((u) => u.endsWith("/wiki/Music"));
        if (id && cat) categories.set(id, { id: cat, name: CATEGORY_NAMES[cat] ?? `category ${cat}`, musicTopic });
      }
    } catch (e) {
      console.error("youtube categories", e);
    }
  }
  return { categories, answered, badRequest };
}

/** The categories alone, for callers that only act on a positive answer. */
export async function fetchVideoCategories(env: YouTubeEnv, videoIds: string[]): Promise<Map<string, VideoCategory>> {
  return (await lookupVideoCategories(env, videoIds)).categories;
}

/**
 * True only for a video the API said is neither filed under Music nor tagged with the Music topic. Unknown (no entry) is not
 * enough to turn it away. The topic matters because uploaders pick the category by hand: a label's official video is often
 * filed under People & Blogs or Entertainment, while YouTube's own topic data still says Music.
 */
export function isNonMusic(category: VideoCategory | undefined): category is VideoCategory {
  return category !== undefined && category.id !== MUSIC_CATEGORY_ID && !category.musicTopic;
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
