import { useEffect, useState } from "react";
import { isStandalone, lastStation, rememberStation } from "./pwa";
import { Landing } from "./Landing";
import { Share } from "./Share";
import { Station } from "./Station";
import { Backdrop } from "./Backdrop";

/** Browsers report this on the window; it flips as the device loses and regains a connection. */
function useOnline(): boolean {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

function stationToken(): string {
  const { pathname } = location;
  return pathname.startsWith("/s/") ? pathname.slice(3).split("/")[0] : "";
}

export function App() {
  const online = useOnline();
  const token = stationToken();

  useEffect(() => {
    if (token) rememberStation(token);
  }, [token]);

  // An installed app opens on start_url ("/"); send it back to the station the listener last used.
  // Only for "/" in standalone mode: other paths (notably /share, the share target) must not be redirected away, and in
  // a browser tab "/" is the landing page and stays so.
  const resume = location.pathname === "/" && isStandalone() ? lastStation() : null;
  useEffect(() => {
    if (resume) location.replace(`/s/${encodeURIComponent(resume)}`);
  }, [resume]);

  return (
    <>
      <Backdrop />
      {location.pathname === "/share" ? (
        <Share />
      ) : token ? (
        <Station token={decodeURIComponent(token)} online={online} />
      ) : resume ? null : (
        <Landing online={online} />
      )}
    </>
  );
}
