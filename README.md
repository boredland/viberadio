# viberadio

Synchronized YouTube radio driven by a Slack channel. Every YouTube link posted in a channel with the bot joins the rotation; everyone on the station link `/s/<token>` hears the same position. When the queue is empty, the channel's link history plays in shuffled order: every track once, then a fresh shuffle (the previous track never repeats back to back).

**Playlists.** A playlist link (`/playlist?list=…`, or `/watch?list=…` with no video) adds its videos to the shuffle without queueing them. A video link that merely carries `list=` is just that video. YouTube's public feed lists at most 15 videos per playlist and says nothing about private playlists or albums (those are reported as unreadable), so longer playlists contribute their first 15.

Cloudflare Workers + SQLite-backed Durable Objects (`StationRegistry`, `Station`), React frontend served from `dist`.

## Setup

1. Create the Slack app from `slack-app-manifest.yml` (api.slack.com/apps → From an app manifest).
2. **Signing secret** (Basic Information → App Credentials): `wrangler secret put SLACK_SIGNING_SECRET`.
3. **Public install.** The landing page at `/` shows "Add to Slack" once `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` (same page) are set as secrets. Each workspace that installs gets its own bot token, stored in `StationRegistry` and replaced on reinstall; uninstalling (or a revoked token) deletes it. In the Slack app: Manage Distribution → turn on "Remove Hard Coded Information" and activate public distribution, or other workspaces cannot install it.
4. **Your own workspace, without OAuth:** set `SLACK_BOT_TOKEN` and `SLACK_TEAM_ID` instead. That token is used only for the workspace named by `SLACK_TEAM_ID`; an install from OAuth takes precedence when both exist.
5. `cp .dev.vars.example .dev.vars` for local runs, then `npm install && npm run dev` (Slack needs a public URL: `cloudflared tunnel --url http://localhost:8787`).
6. `npm run deploy` publishes to the `routes` entry in `wrangler.jsonc`.

`/invite @viberadio` in a public channel posts the tune-in link; `/viberadio` re-shows it. In a workspace without an install, `/viberadio` points people at the landing page.
