import type { Env } from "./index";

/** Must match `oauth_config.scopes.bot` in the Slack app manifests: Slack grants exactly what the authorize URL asks for. */
export const BOT_SCOPES = ["channels:history", "channels:read", "chat:write", "commands", "reactions:write", "users:read"];

export const registry = (env: Env) => env.STATION_REGISTRY.getByName("registry");

/**
 * The bot token to act as in a workspace: the one Slack issued when that workspace installed the app, or else the single
 * `SLACK_BOT_TOKEN` secret, but only for the workspace named by `SLACK_TEAM_ID`. Never another workspace's token, so a
 * workspace without an install gets null instead of a token that belongs to someone else.
 */
export async function botTokenFor(env: Env, teamId: string): Promise<string | null> {
  const install = await registry(env).getInstall(teamId);
  if (install) return install.botToken;
  return env.SLACK_BOT_TOKEN && env.SLACK_TEAM_ID === teamId ? env.SLACK_BOT_TOKEN : null;
}
