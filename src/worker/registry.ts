import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

function newToken(): string {
  // alphabet length is 64, so `& 63` is unbiased
  const bytes = crypto.getRandomValues(new Uint8Array(21));
  return Array.from(bytes, (b) => ALPHABET[b & 63]).join("");
}

export type Install = { teamId: string; teamName: string; botToken: string; botUserId: string; installedAt: number };

/** An OAuth `state` is single-use and short-lived: it ties the callback to the browser that started the install. */
const STATE_TTL_MS = 10 * 60_000;
/** Outstanding installs at once; far above any real use, low enough that spamming /slack/install cannot fill storage. */
const MAX_STATES = 200;
/** Durable Object storage.delete(keys) limit. */
const DELETE_BATCH = 128;

export class StationRegistry extends DurableObject<Env> {
  async ensureStation(teamId: string, channelId: string): Promise<{ token: string; created: boolean }> {
    const key = `ch:${teamId}:${channelId}`;
    const existing = await this.ctx.storage.get<string>(key);
    if (existing) return { token: existing, created: false };
    const token = newToken();
    await this.ctx.storage.put({ [key]: token, [`tok:${token}`]: { teamId, channelId } });
    return { token, created: true };
  }

  /** Gates every capability URL so garbage tokens never instantiate a Station DO. */
  async lookupToken(token: string): Promise<{ teamId: string; channelId: string } | null> {
    return (await this.ctx.storage.get<{ teamId: string; channelId: string }>(`tok:${token}`)) ?? null;
  }

  /** Reinstalling replaces the token: Slack issues a fresh one each time, and the old one stops working. */
  async saveInstall(install: Install): Promise<void> {
    await this.ctx.storage.put(`inst:${install.teamId}`, install);
  }

  async getInstall(teamId: string): Promise<Install | null> {
    return (await this.ctx.storage.get<Install>(`inst:${teamId}`)) ?? null;
  }

  /** Called on app_uninstalled / tokens_revoked: the token is dead, so keeping it would only produce invalid_auth. */
  async removeInstall(teamId: string): Promise<void> {
    await this.ctx.storage.delete(`inst:${teamId}`);
  }

  /**
   * A fresh random state, remembered until it is used or expires. Anyone can request one, so expired ones are swept first
   * and the total is capped: null means "too many outstanding", and the caller answers 429 instead of growing storage.
   */
  async newState(): Promise<string | null> {
    const live = await this.sweepStates();
    if (live >= MAX_STATES) return null;
    const state = newToken();
    await this.ctx.storage.put(`state:${state}`, Date.now() + STATE_TTL_MS);
    return state;
  }

  /** True once per state: it is deleted on the first check, so a replayed callback is refused. */
  async consumeState(state: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{21}$/.test(state)) return false;
    const key = `state:${state}`;
    const until = await this.ctx.storage.get<number>(key);
    if (until === undefined) return false;
    await this.ctx.storage.delete(key);
    return until > Date.now();
  }

  /** Drops expired states and returns how many are still live. */
  private async sweepStates(): Promise<number> {
    const states = await this.ctx.storage.list<number>({ prefix: "state:" });
    const now = Date.now();
    const dead: string[] = [];
    for (const [k, until] of states) if (until <= now) dead.push(k);
    // delete(keys) accepts at most 128 keys per call, and a burst of abandoned installs can leave more than that expired.
    for (let i = 0; i < dead.length; i += DELETE_BATCH) await this.ctx.storage.delete(dead.slice(i, i + DELETE_BATCH));
    return states.size - dead.length;
  }
}
