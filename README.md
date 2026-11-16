# viberadio

Synchronized YouTube radio driven by a Slack channel. Every YouTube link posted in a channel with the bot joins the rotation; everyone on the station link `/s/<token>` hears the same position. When the queue is empty, the channel's link history plays in shuffled order: every track once, then a fresh shuffle (the previous track never repeats back to back).

**Playlists.** A playlist link (`/playlist?list=…`, or `/watch?list=…` with no video) adds its videos to the shuffle without queueing them. A video link that merely carries `list=` is just that video. YouTube's public feed lists at most 15 videos per playlist and says nothing about private playlists or albums (those are reported as unreadable), so longer playlists contribute their first 15.

Cloudflare Workers + SQLite-backed Durable Objects (`StationRegistry`, `Station`), React frontend served from `dist`.

## Setup

1. Create the Slack app from `slack-app-manifest.yml` (api.slack.com/apps → From an app manifest).
2. **Signing secret** (Basic Information → App Credentials): `wrangler secret put SLACK_SIGNING_SECRET`.
3. **Public install.** The landing page at `/` shows "Add to Slack" once `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` (same page) are set as secrets. Each workspace that installs gets its own bot token, stored in `StationRegistry` and replaced on reinstall; uninstalling (or a revoked token) deletes it. In the Slack app: Manage Distribution → turn on "Remove Hard Coded Information" and activate public distribution, or other workspaces cannot install it.
4. **Your own workspace, without OAuth:** set `SLACK_BOT_TOKEN` and `SLACK_TEAM_ID` instead. That token is used only for the workspace named by `SLACK_TEAM_ID`; an install from OAuth takes precedence when both exist.
5. **Music only (optional).** With `YOUTUBE_API_KEY` set (a Google Cloud API key with the YouTube Data API v3 enabled), videos YouTube files under any category other than Music are turned away when posted and skipped in the shuffle. One `videos.list` call checks a whole message or playlist for 1 quota unit of the 10,000 free per day. Without the key, or when the API answers an error, every link is let through. Scraping YouTube's own pages cannot do this job: they answer a Cloudflare Worker with 429 or "sign in to confirm you're not a bot". `wrangler secret put YOUTUBE_API_KEY`.
6. `cp .dev.vars.example .dev.vars` for local runs, then `npm install && npm run dev` (Slack needs a public URL: `cloudflared tunnel --url http://localhost:8787`).
7. `npm run deploy` publishes to the `routes` entry in `wrangler.jsonc`.

`/invite @viberadio` in a public channel posts the tune-in link; `/viberadio` re-shows it. In a workspace without an install, `/viberadio` points people at the landing page.

## Desktop client and Herdr panel

`client/viberadio` joins a station from a Linux desktop the way the web page does (WebSocket, ping/pong clock offset, `ended` reports) and plays it in mpv at the position everyone else is at. Playback is a systemd user service; the commands only talk to it.

Needs `node` 22+ (`WebSocket` is built in), `mpv` and `yt-dlp`.

```sh
install -m 755 client/viberadio ~/.local/bin/viberadio
install -Dm 644 client/viberadio.service ~/.config/systemd/user/viberadio.service
systemctl --user daemon-reload
viberadio setup 'https://<host>/s/<token>'   # the link is a credential: saved to ~/.config/viberadio/station, mode 600
viberadio start
```

`viberadio status [--json|--waybar]`, `stop`, `toggle`, `volume <0-130|+N|-N>`, `mute`, `skip`. Volume and mute only touch this computer; **`skip` skips the track for everyone on the station**, as in the web page. A track this computer cannot play is retried and only reported to the station when nobody else is listening. The shebang runs node through `mise exec node@22`; change the first line if you get node another way.

`herdr/mods/viberadio` is a popup for the [Herdr](https://herdr.dev) app that drives the same commands: now playing, listeners, sync offset, tune in or out, mute, volume, and a two-click skip. Copy the folder to `~/.config/herdr-app/mods/` and bind it in `~/.config/herdr-app/keys.json` (see `herdr/keys.json`: `ctrl-shift-r`).

## Licence

MIT, see `LICENSE`.
