const CACHE_NAME = "guanchao-shell-v3";
const SHELL = [
  "/",
  "/index.txt",
  "/fed/",
  "/fed/index.txt",
  "/markets/",
  "/markets/index.txt",
  "/briefs/",
  "/briefs/index.txt",
  "/hotspots/",
  "/hotspots/index.txt",
  "/articles/fed-june-decision/",
  "/articles/fed-june-decision/index.txt",
  "/articles/fed-july-report/",
  "/articles/fed-july-report/index.txt",
  "/articles/fed-june-minutes-split/",
  "/articles/fed-june-minutes-split/index.txt",
  "/articles/a-share-close-0716/",
  "/articles/a-share-close-0716/index.txt",
  "/articles/hk-close-0716/",
  "/articles/hk-close-0716/index.txt",
  "/articles/us-close-0716/",
  "/articles/us-close-0716/index.txt",
  "/articles/hot-inflation/",
  "/articles/hot-inflation/index.txt",
  "/articles/hot-china-gdp/",
  "/articles/hot-china-gdp/index.txt",
  "/articles/hot-ai-rotation/",
  "/articles/hot-ai-rotation/index.txt",
  "/articles/hot-fomc-window/",
  "/articles/hot-fomc-window/index.txt",
  "/articles/hot-cross-market/",
  "/articles/hot-cross-market/index.txt",
  "/manifest.webmanifest",
  "/favicon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request).then((response) => response || caches.match("/")))
    );
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
