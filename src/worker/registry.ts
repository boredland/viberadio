import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

function newToken(): string {
  // alphabet length is 64, so `& 63` is unbiased
  const bytes = crypto.getRandomValues(new Uint8Array(21));
  return Array.from(bytes, (b) => ALPHABET[b & 63]).join("");
}

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
}
