// Keeps the app on the phone so it opens with no signal (D32). Bump VERSION when a file changes.
const VERSION = "tt-ratings-2";
const FILES = ["./", "index.html", "app.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;  // Google sign-in and Drive go to the network
  // The app's own files: from the phone first, refreshed in the background when there is signal.
  e.respondWith(caches.open(VERSION).then((cache) => cache.match(e.request, { ignoreSearch: true }).then((hit) => {
    const fresh = fetch(e.request).then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; }).catch(() => hit);
    return hit || fresh;
  })));
});
