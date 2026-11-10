# viberadio

Synchronized YouTube radio driven by a Slack channel. Every YouTube link posted in a channel with the bot joins the rotation; everyone on the station link `/s/<token>` hears the same position. When the queue is empty, the channel's link history plays in shuffled order: every track once, then a fresh shuffle (the previous track never repeats back to back).

**Playlists.** A playlist link (`/playlist?list=…`, or `/watch?list=…` with no video) adds its videos to the shuffle without queueing them. A video link that merely carries `list=` is just that video. YouTube's public feed lists at most 15 videos per playlist and says nothing about private playlists or albums (those are reported as unreadable), so longer playlists contribute their first 15.

Cloudflare Workers + SQLite-backed Durable Objects (`StationRegistry`, `Station`), React frontend served from `dist`.

## Setup

1. Create the Slack app from `slack-app-manifest.yml` (api.slack.com/apps → From an app manifest) and install it.
2. `cp .dev.vars.example .dev.vars` and fill in the bot token and signing secret. For production:
   `wrangler secret put SLACK_BOT_TOKEN` and `wrangler secret put SLACK_SIGNING_SECRET`.
3. `npm install && npm run dev` (Slack needs a public URL: `cloudflared tunnel --url http://localhost:8787`).
4. `npm run deploy` publishes to the `routes` entry in `wrangler.jsonc`.

`/invite @viberadio` in a public channel posts the tune-in link; `/viberadio` re-shows it.
