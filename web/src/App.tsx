import { Station } from "./Station";

export function App() {
  const { pathname } = location;
  if (pathname.startsWith("/s/")) {
    const token = pathname.slice(3).split("/")[0];
    if (token) return <Station token={decodeURIComponent(token)} />;
  }
  return (
    <main className="card">
      <h1>viberadio</h1>
      <p>
        Add the viberadio bot to a Slack channel, run <code>/viberadio</code> for your link.
      </p>
    </main>
  );
}
