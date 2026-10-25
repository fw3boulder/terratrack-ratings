// Keeps the app on the phone so it opens with no signal (D32). Bump VERSION when a file changes.
const VERSION = "tt-ratings-5";
const TILE_CACHE = "tt-tiles";  // topo map tiles saved per trip day; kept across versions
const FILES = ["./", "index.html", "app.js", "manifest.webmanifest", "icon-192.png", "icon-512.png",
               "lib/leaflet.js", "lib/leaflet.css"];

self.addEventListener("install", (e) => {
  // cache: "reload" skips the browser's own short-term cache, so an update never re-saves old files.
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== TILE_CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === "GET" && url.hostname === "basemap.nationalmap.gov") {
    // Map tiles: the saved copy first, so the map works with no signal.
    e.respondWith(caches.open(TILE_CACHE).then((cache) => cache.match(e.request.url).then((hit) => hit ||
      fetch(e.request).then((res) => { cache.put(e.request.url, res.clone()); return res; }))));
    return;
  }
  if (e.request.method !== "GET" || url.origin !== location.origin) return;  // Google sign-in and Drive go to the network
  // The app's own files: from the phone first, refreshed in the background when there is signal.
  e.respondWith(caches.open(VERSION).then((cache) => cache.match(e.request, { ignoreSearch: true }).then((hit) => {
    const fresh = fetch(e.request, { cache: "no-cache" }).then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; }).catch(() => hit);
    return hit || fresh;
  })));
});
