import { botTokenFor } from "./install";
import type { Env } from "./index";
import { slackApi } from "./slack";

/** Shown for adds from the PWA share target, which carries no identity. */
export const WEB_ADDER = "web share";

/** A resolved name is stable for a long time; a failed lookup (missing scope, deleted user, network) is retried sooner. */
const HIT_TTL_MS = 6 * 60 * 60_000;
const MISS_TTL_MS = 10 * 60_000;
/** Bound on one lookup so a slow Slack never holds up queueing the track. */
const LOOKUP_TIMEOUT_MS = 2500;
const CACHE_CAP = 500;

const cache = new Map<string, { name: string | null; until: number }>();

type UserInfo = {
  ok: boolean;
  error?: string;
  user?: { deleted?: boolean; real_name?: string; profile?: { display_name?: string; real_name?: string } };
};

/**
 * Slack user id -> display name, or null when it cannot be resolved (the bot lacks `users:read`, the user is gone, Slack
 * is slow, the workspace has no token). Callers treat null as "unknown" and the UI shows nothing rather than an opaque
 * id. Never throws.
 *
 * The cache is per isolate and per Worker, not per station: the same person posts in many stations, and a name lookup is
 * a Slack API call counted against the 50-subrequest budget of the invocation, so it must not repeat for every track.
 * It is keyed by workspace as well, since ids are only guaranteed unique within one.
 */
export async function resolveSlackName(env: Env, teamId: string, userId: string | undefined): Promise<string | null> {
  if (!userId || !/^[UW][A-Z0-9]+$/.test(userId)) return null;
  const key = `${teamId}:${userId}`;
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.name;

  let name: string | null = null;
  try {
    const token = await botTokenFor(env, teamId);
    if (!token) return null;
    const res = await slackApi(env, "users.info", token, { user: userId }, LOOKUP_TIMEOUT_MS);
    const body = (await res.json()) as UserInfo;
    if (body.ok && body.user) {
      name = body.user.profile?.display_name?.trim() || body.user.profile?.real_name?.trim() || body.user.real_name?.trim() || null;
    } else if (body.error !== "missing_scope") {
      console.error("users.info failed:", body.error);
    }
  } catch (err) {
    console.error("users.info threw:", err);
  }

  if (cache.size >= CACHE_CAP) cache.delete(cache.keys().next().value as string);
  cache.set(key, { name, until: Date.now() + (name ? HIT_TTL_MS : MISS_TTL_MS) });
  return name;
}
