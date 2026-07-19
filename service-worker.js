// ============================================================
// service-worker.js — ClassTrack
//
// Bump CACHE_VERSION whenever app.js / style.css / index.html
// change. Network-first for the app shell means a browser that
// already has the app installed will always try to fetch the
// latest index.html / app.js / style.css from the network first,
// only falling back to the cached copy when offline. This avoids
// the classic PWA trap where an old service worker keeps serving
// a stale app.js forever and code changes never seem to "take".
// ============================================================

const CACHE_VERSION = "classtrack-v1";
const APP_SHELL = ["./index.html", "./style.css", "./app.js", "./manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const isAppShell = APP_SHELL.some((path) => request.url.endsWith(path.replace("./", "")));

  if (isAppShell) {
    // Network-first: always prefer the freshest code; cache is only
    // the offline fallback.
    event.respondWith(
      fetch(request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Everything else (icons, Firebase SDK, etc.): cache-first is fine.
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});