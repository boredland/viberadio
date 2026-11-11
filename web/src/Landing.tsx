import { useEffect, useState } from "react";
import { Look } from "./Look";
import { InstallBar } from "./pwa";
import { Win } from "./ui";

const LOGO = String.raw`
 __   _____ ___ ___ ___    _   ___ ___ ___
 \ \ / /_ _| _ ) __| _ \  /_\ |   \_ _/ _ \
  \ V / | || _ \ _||   / / _ \| |) | | (_) |
   \_/ |___|___/___|_|_\/_/ \_\___/___\___/`;

type Result = "ok" | "cancelled" | "failed";

/** Which outcome the OAuth callback redirected back with; anything else shows nothing. The page words it, not the URL. */
function installResult(): Result | null {
  const v = new URLSearchParams(location.search).get("install");
  return v === "ok" || v === "cancelled" || v === "failed" ? v : null;
}

const STEPS = [
  "add the viberadio bot to your Slack workspace",
  "invite it to a public channel: /invite @viberadio",
  "post YouTube links or playlists there",
  "open the tune-in link the bot posts. everyone hears the same thing",
];

/** The page at "/": what this is, and the way in. */
export function Landing({ online }: { online: boolean }) {
  const [installable, setInstallable] = useState<boolean | null>(null);
  // Read once at mount. The effect below removes the flag from the URL, and every later render would otherwise see none.
  const [result] = useState(installResult);

  useEffect(() => {
    // Drop the flag so a reload or a shared link does not replay the banner.
    if (result) history.replaceState(null, "", location.pathname);
    let live = true;
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : { installable: false }))
      .then((c: { installable?: boolean }) => live && setInstallable(c.installable === true))
      .catch(() => live && setInstallable(false));
    return () => {
      live = false;
    };
    // `result` is fixed for the life of the component, so it is deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="stack">
      <Win title="VIBERADIO">
        <pre className="logo">{LOGO}</pre>
        <p className="boot">
          {"> "}one channel. one radio. everyone in sync.
          <span className="blink">_</span>
        </p>
      </Win>

      {result === "ok" && (
        <Win title="INSTALLED">
          <p className="lcd-text">★ VIBERADIO IS IN YOUR WORKSPACE</p>
          <p className="dim">Invite it to a channel with /invite @viberadio and it will post the tune-in link.</p>
        </Win>
      )}
      {result === "cancelled" && <p className="banner">INSTALL CANCELLED. NOTHING WAS ADDED.</p>}
      {result === "failed" && <p className="banner">INSTALL DIDN'T COMPLETE. TRY AGAIN.</p>}

      <Win title="ADD TO SLACK">
        {installable === true && (
          <a href="/slack/install" style={{ display: "block", textAlign: "center" }}>
            <img alt="Add to Slack" height="40" width="139" src="https://platform.slack-edge.com/img/add_to_slack.png" srcSet="https://platform.slack-edge.com/img/add_to_slack.png 1x, https://platform.slack-edge.com/img/add_to_slack@2x.png 2x" />
          </a>
        )}
        {installable === false && (
          <p className="dim">Installing from this page is not switched on yet, so there is no button here.</p>
        )}
        <ol className="steps">
          {STEPS.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <p className="dim">Already running in a channel? Run /viberadio there to get its link again.</p>
      </Win>

      <Win title="HOW IT PLAYS">
        <p className="dim">
          Posted links play in order. When nothing is queued, every track ever posted in the channel plays in shuffled
          order. Playlist links add their first 15 videos to that shuffle. Anyone with the link can press NEXT.
        </p>
      </Win>

      {!online && (
        <Win title="OFFLINE">
          <p className="lcd-text err">NO SIGNAL</p>
          <p className="dim">You're offline. Open your station link once you're back online.</p>
        </Win>
      )}
      <Look />
      <InstallBar />
    </main>
  );
}
