export type SlackEnv = {
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
};

const encoder = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The signature covers the raw bytes, so callers must pass the body from a single `request.text()`. */
export async function verifySlackRequest(
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${timestamp}:${rawBody}`));
  const expected = `v0=${hex(mac)}`;
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

const SLACK_LINK = /<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/g;
const VIDEO_URL =
  /(?:youtube\.com\/watch\?(?:[^\s]*&)?v=|youtu\.be\/|youtube\.com\/(?:shorts|live|embed)\/)([A-Za-z0-9_-]{11})/g;

export function extractVideoIds(text: string): string[] {
  const plain = text.replace(SLACK_LINK, "$1");
  const ids: string[] = [];
  for (const m of plain.matchAll(VIDEO_URL)) {
    if (!ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

export type SlackMessage = {
  type?: string;
  subtype?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
};

export function isUserMessage(m: SlackMessage): boolean {
  return m.type === "message" && m.subtype === undefined && m.bot_id === undefined;
}

export function slackApi(method: string, token: string, params: Record<string, string>): Promise<Response> {
  return fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: new URLSearchParams(params),
  });
}

/** Never retried: retrying a bot message is how event storms start. */
export async function slackChatPost(
  env: SlackEnv,
  channel: string,
  text: string,
  threadTs?: string,
): Promise<void> {
  try {
    const res = await slackApi("chat.postMessage", env.SLACK_BOT_TOKEN, {
      channel,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    const body = (await res.json()) as { ok: boolean; error?: string };
    if (!body.ok) console.error("chat.postMessage failed:", body.error);
  } catch (err) {
    console.error("chat.postMessage threw:", err);
  }
}

/** `already_reacted` is expected when Slack redelivers an event, so it is not logged. Never retried, like chat posts. */
export async function slackReact(env: SlackEnv, channel: string, ts: string, name: string): Promise<void> {
  try {
    const res = await slackApi("reactions.add", env.SLACK_BOT_TOKEN, { channel, timestamp: ts, name });
    const body = (await res.json()) as { ok: boolean; error?: string };
    if (!body.ok && body.error !== "already_reacted") console.error("reactions.add failed:", body.error);
  } catch (err) {
    console.error("reactions.add threw:", err);
  }
}
