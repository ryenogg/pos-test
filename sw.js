// Keeps a copy of the app on the device so it opens with no internet.
// Change VERSION whenever you upload a new index.html, so old copies are replaced.
const VERSION = "pos-v7";
const FILES = ["./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Open instantly from the saved copy, and refresh that copy in the background when online.
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // API responses may contain account/session state and must never be cached offline.
  if (url.pathname.startsWith("/api/")) return;
  if (req.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      const network = fetch(req.url, { cache: "no-cache" })
        .then((res) => {
          if (res && res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => cached || (req.mode === "navigate" ? caches.match("index.html") : undefined));
      e.waitUntil(network.catch(() => {}));
      return cached || network;
    })
  );
});
