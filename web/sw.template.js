// Generated into dist/sw.js by the precache plugin in vite.config.ts; the two placeholders below are filled at build time.
const VERSION = "__VERSION__";
const PRECACHE = __PRECACHE__;
const CACHE = `viberadio-${VERSION}`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("viberadio-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Only the static shell is handled. The station socket, /api and /slack are never intercepted: a cached station
// snapshot would show a dead track as live, and the socket is not a fetch anyway.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/slack/") || url.pathname === "/ws") return;

  if (req.mode === "navigate") {
    // Network first so a deploy is picked up immediately; the cached shell only answers when the network does not.
    // "/" rather than "/index.html": the latter redirects, and a redirected response cannot answer a navigation.
    event.respondWith(fetch(req).catch(() => caches.match("/")));
    return;
  }

  // Hashed assets never change under the same URL, and icons/manifest change only with a new service worker.
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
