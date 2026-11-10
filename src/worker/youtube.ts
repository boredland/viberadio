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
