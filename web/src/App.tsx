import { Station } from "./Station";
import { MatrixRain, Win } from "./ui";

const LOGO = String.raw`
 __   _____ ___ ___ ___    _   ___ ___ ___
 \ \ / /_ _| _ ) __| _ \  /_\ |   \_ _/ _ \
  \ V / | || _ \ _||   / / _ \| |) | | (_) |
   \_/ |___|___/___|_|_\/_/ \_\___/___\___/`;

export function App() {
  const { pathname } = location;
  const token = pathname.startsWith("/s/") ? pathname.slice(3).split("/")[0] : "";
  return (
    <>
      <MatrixRain />
      {token ? (
        <Station token={decodeURIComponent(token)} />
      ) : (
        <main className="stack">
          <Win title="VIBERADIO">
            <pre className="logo">{LOGO}</pre>
            <p className="boot">
              {"> "}one channel. one radio. everyone in sync.
              {"\n> "}add the <b>viberadio</b> bot to a Slack channel
              {"\n> "}run <b>/viberadio</b> for your link
              {"\n> "}post YouTube links to queue tracks
              <span className="blink">_</span>
            </p>
          </Win>
        </main>
      )}
    </>
  );
}
