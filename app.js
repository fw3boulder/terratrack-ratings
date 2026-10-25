// TerraTrack ratings: rate road chunks from memory at stops, offline; sync to Google Drive (D32).
// Everything lives in this phone's storage; Drive gets one ratings file per trip day.
"use strict";

const CLASSES = ["1", "2", "3a", "3b", "4", "5"];
const COLORS = { "1": "var(--c1)", "2": "var(--c2)", "3a": "var(--c3)", "3a/3b?": "var(--c3)", "3b": "var(--c35)",
                 "4": "var(--c4)", "5": "var(--c5)" };
const WORDS = { "1": "paved", "2": "maintained gravel", "3a": "rough dirt", "3a/3b?": "rough dirt, maybe 3b",
                "3b": "rough, knobbies", "4": "rocky two-track", "5": "extreme", "?": "unknown" };
const FOLDER = "TerraTrack ratings";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
// The OAuth client ID of the "TerraTrack" Google Cloud project (not a secret: Google shows it to every
// browser that signs in). Setup can override it.
const CLIENT_ID = "332662345008-oo92i8rssb5ajrpanb3f0fvse7n51ge2.apps.googleusercontent.com";
const $ = (id) => document.getElementById(id);

// --- Storage (wrapped: private windows or cleared data must not break the page) ---------------
function load(key, fallback) {
  try { const v = localStorage.getItem("tt." + key); return v === null ? fallback : JSON.parse(v); }
  catch (e) { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem("tt." + key, JSON.stringify(value)); } catch (e) { /* storage full or blocked */ }
}

let days = load("days", {});          // trip id -> trip-day file from TerraTrack
let ratings = load("ratings", {});    // trip id -> { chunk id -> rating }
let current = load("current", null);  // trip id shown
let drive = load("drive", { folderId: null, files: {} });
let dirty = load("dirty", []);        // trip ids with ratings not yet on Drive
let token = load("token", null);      // { access_token, exp }
let lastSync = load("lastSync", null);
let idx = null;                        // chunk shown on the Rate tab
let draft = null;                      // the card's unsaved choices
let tokenClient = null;

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
const APP_VERSION = 7;  // shown under Setup; keep in step with VERSION in sw.js
if ("serviceWorker" in navigator) {
  // When an update takes over, reload once so the new version shows straight away.
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController && !reloaded) { reloaded = true; location.reload(); }
  });
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((reg) => reg.update()).catch(() => {});
}

// --- Helpers ---------------------------------------------------------------------------------
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function day() { return current && days[current]; }
function dayRatings() { return (ratings[current] = ratings[current] || {}); }
function guessColor(g) { return COLORS[g] || "var(--muted)"; }
function hhmm(iso) { return iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""; }

function startIndex() {
  // First chunk after the last one rated or skipped ("since your last stop").
  const d = day(), r = dayRatings();
  let last = -1;
  d.chunks.forEach((c, i) => { if (r[c.id]) last = i; });
  const next = d.chunks.findIndex((c, i) => i > last && !r[c.id]);
  if (next >= 0) return next;
  const any = d.chunks.findIndex((c) => !r[c.id]);
  return any;  // -1 when everything is done
}

// --- Rate tab --------------------------------------------------------------------------------
function renderRate() {
  const el = $("rate"), d = day();
  if (!d) {
    el.innerHTML = `<div class="card empty"><h2>No trip day yet</h2><p class="muted">Open <b>Setup</b> and load a trip day file from TerraTrack.</p></div>`;
    return;
  }
  if (idx === null) idx = startIndex();
  const r = dayRatings();
  const done = d.chunks.filter((c) => r[c.id] && r[c.id].cls_name).length;
  if (idx < 0) {
    el.innerHTML = `<div class="card empty"><h2>✓ All ${d.chunks.length} rated</h2><p class="muted">${esc(d.name)} · ${d.miles} mi. Change any on the <b>All</b> tab.</p></div>`;
    return;
  }
  const c = d.chunks[idx];
  const saved = r[c.id];
  draft = draft && draft.id === c.id ? draft : { id: c.id, cls: saved?.cls_name || null, liked: saved?.liked || 0, note: saved?.note || "" };
  el.innerHTML = `
    <div class="row"><p class="muted">${done} of ${d.chunks.length} rated · chunk ${idx + 1} · rate the ones you remember</p>
      <button type="button" class="chip" id="pick" style="flex:none">🗺 Pick on map</button></div>
    <div class="card">
      <div id="daymap" class="daymap" role="button" aria-label="Map of the day's ride; tap for a bigger map"></div>
      ${strip(d, r, idx)}
      <h2>${esc(c.roads)}</h2>
      <div class="facts">Mile ${c.from_mi}–${c.to_mi} of ${d.miles} · ${c.miles} mi · climbs ${c.climb_ft} ft</div>
      <div class="facts">${esc(c.start)} ${esc(c.end)}${c.near ? " · near " + esc(c.near) : ""}</div>
      <div class="muted">TerraTrack thought: <span class="guess" style="background:${guessColor(c.guess)}">${esc(c.guess)}</span> ${esc(WORDS[c.guess] || "")}</div>
      <div class="grid" role="group" aria-label="Class">
        ${CLASSES.map((k) => `<button type="button" data-cls="${k}" aria-pressed="${draft.cls === k}" style="border-bottom:5px solid ${guessColor(k)}">${k}</button>`).join("")}
      </div>
      <div class="thumbs">
        <button type="button" data-like="1" aria-pressed="${draft.liked === 1}">👍 Liked it</button>
        <button type="button" data-like="-1" aria-pressed="${draft.liked === -1}">👎 Didn't</button>
      </div>
      <div class="nav">
        <button type="button" id="back" ${idx === 0 ? "disabled" : ""} aria-label="Back">◀</button>
        <button type="button" id="skip" title="Rode it, don't remember">Skip</button>
        <button type="button" id="notRidden" title="Not on the road we rode (a drawing slip or a detour)">Not ridden</button>
        <button type="button" id="next" class="next">${draft.cls ? "Save ▶" : "Next ▶"}</button>
      </div>
      <input id="note" type="text" class="note" placeholder="Note" value="${esc(draft.note)}">
      ${saved ? `<p class="muted">${saved.not_ridden ? "✕ Marked not ridden" : saved.skipped ? "– Skipped" : "✓ Saved " + esc(saved.cls_name)} ${hhmm(saved.rated_at)} · <button type="button" id="clear" class="linkbtn">Clear</button></p>` : ""}
    </div>`;
  el.querySelectorAll("[data-cls]").forEach((b) => b.onclick = () => { draft.cls = draft.cls === b.dataset.cls ? null : b.dataset.cls; renderRate(); });
  el.querySelectorAll("[data-like]").forEach((b) => b.onclick = () => { const v = +b.dataset.like; draft.liked = draft.liked === v ? 0 : v; renderRate(); });
  $("note").oninput = (e) => { draft.note = e.target.value; };
  $("back").onclick = () => { draft = null; fromPick = null; idx = Math.max(0, idx - 1); renderRate(); };
  const where = `${c.roads} (mile ${c.from_mi})`;
  $("skip").onclick = () => { store(c, { skipped: true }); toast(`– Skipped ${where}`); move(); };
  $("notRidden").onclick = () => { store(c, { not_ridden: true }); toast(`✕ Not ridden: ${where}`); move(); };
  if (saved) $("clear").onclick = () => { store(c, {}); delete dayRatings()[c.id]; changed(); toast(`Cleared ${where}`); draft = null; renderRate(); };
  $("next").onclick = () => {
    if (draft.cls) { const k = draft.cls; store(c, { cls_name: k }); toast(`✓ ${k} saved: ${c.roads} (mile ${c.from_mi})`); }
    move();
  };
  el.querySelectorAll("[data-jump]").forEach((b) => b.onclick = () => { draft = null; idx = +b.dataset.jump; renderRate(); });
  miniMap = drawDay(miniMap, "daymap", d, r, idx, false);
  $("daymap").onclick = () => openFull(d, r, idx, false);
  $("pick").onclick = () => openFull(d, r, idx, true);
}

// --- Day map (Leaflet; the topo tiles are saved on the phone when a trip day is loaded) ------
const TILES = "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}";
const TILE_CACHE = "tt-tiles";
const RATED = { "1": "#495057", "2": "#2f9e44", "3a": "#e8b007", "3b": "#f76707", "4": "#d6336c", "5": "#862e9c" };
let miniMap = null, fullMap = null;

function routeOf(d) { return d.route || d.chunks.flatMap((c) => c.coords); }

function drawDay(map, elId, d, r, current, full) {
  if (typeof L === "undefined") { $(elId).textContent = "Map not available."; return null; }
  if (map) map.remove();
  map = L.map(elId, { zoomControl: full, attributionControl: full, dragging: full, scrollWheelZoom: full,
                      doubleClickZoom: full, boxZoom: false, keyboard: false, touchZoom: full, tap: false });
  L.tileLayer(TILES, { maxZoom: 16, maxNativeZoom: 16, attribution: "USGS The National Map" }).addTo(map);
  L.polyline(routeOf(d), { color: "#fff", weight: full ? 8 : 5, opacity: 0.9 }).addTo(map);
  L.polyline(routeOf(d), { color: "#495057", weight: full ? 4 : 3 }).addTo(map);
  d.chunks.forEach((c, i) => {
    const s = r[c.id];
    if (s && s.cls_name && i !== current) L.polyline(c.coords, { color: RATED[s.cls_name], weight: full ? 5 : 4 }).addTo(map);
  });
  const c = d.chunks[current];
  L.polyline(c.coords, { color: "#fff", weight: full ? 11 : 9 }).addTo(map);
  L.polyline(c.coords, { color: "#1c7ed6", weight: full ? 7 : 6 }).addTo(map);
  const route = routeOf(d);
  L.circleMarker(route[0], { radius: 6, color: "#fff", weight: 2, fillColor: "#2f9e44", fillOpacity: 1 }).addTo(map).bindTooltip("Start");
  L.circleMarker(route[route.length - 1], { radius: 6, color: "#fff", weight: 2, fillColor: "#212529", fillOpacity: 1 }).addTo(map).bindTooltip("Finish");
  // Town names: cities and towns always; villages from zoom 10, hamlets from zoom 12 (full map only).
  const labels = L.layerGroup().addTo(map);
  const minZoom = { city: 0, town: 0, village: 10, hamlet: 12 };
  const showTowns = () => {
    labels.clearLayers();
    (d.towns || []).filter((t) => full ? map.getZoom() >= (minZoom[t.kind] ?? 12) : true).slice(0, full ? 60 : 6)
      .forEach((t) => L.marker([t.lat, t.lon], { interactive: false, icon: L.divIcon({ className: "", iconSize: [0, 0],
        html: `<div class="town ${t.kind === "city" || t.kind === "town" ? "big" : ""}">${esc(t.name)}</div>` }) }).addTo(labels));
  };
  if (full) map.on("zoomend", showTowns);
  if (full === "day" || !full) map.fitBounds(L.latLngBounds(route), { padding: full ? [24, 24] : [8, 8] });
  else map.fitBounds(L.latLngBounds(c.coords).pad(0.6));
  if (full) map.on("click", (e) => pickAt(map, d, e.latlng));
  showTowns();
  return map;
}

let picked = null, pickLayer = null;

function pickAt(map, d, at) {
  // Highlights the chunk whose line passes closest to the tap (within about 30 px) and offers it in
  // the bar below; nothing jumps until "Rate this", so double-tap and pinch zoom stay free.
  const p = map.latLngToContainerPoint(at);
  let best = null;
  d.chunks.forEach((c, i) => c.coords.forEach((q, k) => {
    if (k === 0) return;
    const dist = L.LineUtil.pointToSegmentDistance(p, map.latLngToContainerPoint(c.coords[k - 1]), map.latLngToContainerPoint(q));
    if (!best || dist < best.dist) best = { i, dist };
  }));
  if (!best || best.dist > 30) return;
  picked = best.i;
  const c = d.chunks[picked], s = dayRatings()[c.id];
  if (pickLayer) map.removeLayer(pickLayer);
  pickLayer = L.layerGroup([L.polyline(c.coords, { color: "#fff", weight: 13 }), L.polyline(c.coords, { color: "#f59f00", weight: 8 })]).addTo(map);
  $("pickName").innerHTML = `<b>${esc(c.roads)}</b><br><span class="muted">mile ${c.from_mi}–${c.to_mi} · ${c.miles} mi${s && s.cls_name ? " · rated " + esc(s.cls_name) : ""}</span>`;
  $("pickBar").classList.remove("hidden");
  setTimeout(() => map.invalidateSize({ pan: false }), 0);  // the bar takes some of the map's height
}

$("pickGo").onclick = () => {
  if (picked === null) return;
  fromPick = { center: fullMap.getCenter(), zoom: fullMap.getZoom() };
  $("full").classList.add("hidden");
  idx = picked; draft = null; picked = null;
  tab("rate");
  window.scrollTo(0, 0);
};

function openFull(d, r, current, browse, view) {
  $("full").classList.remove("hidden");
  $("pickBar").classList.add("hidden");
  picked = null; pickLayer = null;
  fullMap = drawDay(fullMap, "fullmap", d, r, current, browse ? "day" : "chunk");
  if (view) fullMap.setView(view.center, view.zoom, { animate: false });
  setTimeout(() => fullMap && fullMap.invalidateSize(), 50);
}
$("fullClose").onclick = () => { $("full").classList.add("hidden"); fromPick = null; tab("rate"); };

function strip(d, r, current) {
  // One bar for the whole day, a block per chunk (width by miles); tap one to go to it.
  return `<div class="strip" aria-label="Where this chunk is in the day">` + d.chunks.map((c, i) => {
    const s = r[c.id];
    const bg = i === current ? "#1c7ed6" : s && s.not_ridden ? "#ffc9c9" : s && s.cls_name ? RATED[s.cls_name] : s ? "#ffd8a8" : "#dee2e6";
    return `<button type="button" data-jump="${i}" style="flex:${Math.max(c.miles, 0.3)};background:${bg}" aria-label="Chunk ${i + 1}: ${esc(c.roads)}"></button>`;
  }).join("") + `</div>`;
}

function tilesFor(route, maxTiles = 400) {
  // Tile addresses covering the route's box, from the zoom that shows it all to three steps closer.
  const lats = route.map((p) => p[0]), lons = route.map((p) => p[1]);
  const box = [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)];
  const tx = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
  const ty = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };
  let z0 = 16;
  while (z0 > 5 && (tx(box[3], z0) - tx(box[1], z0) > 2 || ty(box[0], z0) - ty(box[2], z0) > 2)) z0--;
  const out = [];
  for (let z = Math.max(z0 - 1, 0); z <= Math.min(z0 + 3, 16); z++) {
    for (let x = tx(box[1], z); x <= tx(box[3], z); x++)
      for (let y = ty(box[2], z); y <= ty(box[0], z); y++) {
        if (out.length >= maxTiles) return out;
        out.push(TILES.replace("{z}", z).replace("{x}", x).replace("{y}", y));
      }
  }
  return out;
}

async function saveTiles(d, report) {
  if (!("caches" in window) || !navigator.onLine) return;
  const urls = tilesFor(routeOf(d));
  const cache = await caches.open(TILE_CACHE);
  let done = 0;
  for (let i = 0; i < urls.length; i += 6) {
    await Promise.all(urls.slice(i, i + 6).map(async (u) => {
      try { if (!(await cache.match(u))) await cache.put(u, await fetch(u, { mode: "no-cors" })); } catch (e) { /* skip */ }
      done++;
    }));
    report(done, urls.length);
  }
}

let fromPick = null;   // the map view to go back to when a chunk was opened with Pick on map
let undo = null, toastTimer = null;

function store(c, fields) {
  const r = dayRatings();
  undo = { trip: current, id: c.id, before: r[c.id] || null, at: idx };
  r[c.id] = Object.assign({ chunk_id: c.id, liked: draft.liked || 0, note: draft.note.trim(), rated_at: new Date().toISOString(),
                            coords: c.coords, guess: c.guess }, fields);
  save("ratings", ratings);
  if (!dirty.includes(current)) dirty.push(current);
  save("dirty", dirty);
  sync(false);
}

function changed() {
  save("ratings", ratings);
  if (!dirty.includes(current)) dirty.push(current);
  save("dirty", dirty);
  sync(false);
}

function toast(text) {
  $("toastText").textContent = text;
  $("toast").classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.add("hidden"), 6000);
}

$("toastUndo").onclick = () => {
  if (!undo || undo.trip !== current) return;
  const r = dayRatings();
  if (undo.before) r[undo.id] = undo.before; else delete r[undo.id];
  changed();
  idx = undo.at; draft = null; undo = null;
  $("toast").classList.add("hidden");
  $("full").classList.add("hidden");
  tab("rate");
};

function move() {
  draft = null;
  const d = day(), r = dayRatings();
  if (fromPick) { const view = fromPick; fromPick = null; openFull(d, r, idx, true, view); return; }
  const next = d.chunks.findIndex((c, i) => i > idx && !r[c.id]);
  idx = next >= 0 ? next : d.chunks.findIndex((c) => !r[c.id]);
  renderRate();
  window.scrollTo(0, 0);
}

// --- All tab ---------------------------------------------------------------------------------
function renderAll() {
  const el = $("all"), d = day();
  if (!d) { el.innerHTML = ""; return; }
  const r = dayRatings();
  el.innerHTML = `<p class="muted">${esc(d.name)} · ${d.miles} mi · tap one to change it</p><ul class="list">` +
    d.chunks.map((c, i) => {
      const s = r[c.id];
      const mark = !s ? `<span class="mark todo">○ To rate</span>` : s.not_ridden ? `<span class="mark skip">✕ Not ridden</span>`
        : s.skipped ? `<span class="mark skip">– Skipped</span>`
        : `<span class="mark done">✓ ${esc(s.cls_name)}${s.liked === 1 ? " 👍" : s.liked === -1 ? " 👎" : ""}</span>`;
      return `<li data-i="${i}">${mark}<span>${esc(c.roads)}<br><span class="muted">mile ${c.from_mi}–${c.to_mi} · ${c.miles} mi</span></span></li>`;
    }).join("") + "</ul>";
  el.querySelectorAll("li").forEach((li) => li.onclick = () => { idx = +li.dataset.i; draft = null; tab("rate"); });
}

// --- Setup tab -------------------------------------------------------------------------------
function renderSetup() {
  $("client").value = load("client", CLIENT_ID);
  $("version").textContent = `App version ${APP_VERSION}`;
  const ids = Object.keys(days);
  $("days").innerHTML = ids.length ? ids.map((id) => {
    const n = Object.values(ratings[id] || {}).filter((x) => !x.skipped).length;
    return `<li data-id="${esc(id)}"><span class="mark">${n}/${days[id].chunks.length}</span><span>${esc(days[id].name)}<br><span class="muted">${esc(days[id].ride_date || "")} · ${days[id].miles} mi</span></span></li>`;
  }).join("") : `<li class="muted">None yet.</li>`;
  $("days").querySelectorAll("li[data-id]").forEach((li) => li.onclick = () => choose(li.dataset.id));
}

$("file").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.kind !== "terratrack-trip-day" || !Array.isArray(data.chunks)) throw new Error("not a TerraTrack trip day");
    days[data.id] = data;
    save("days", days);
    $("loadMsg").textContent = `✓ Loaded ${data.name}: ${data.chunks.length} chunks, ${data.miles} mi.`;
    const loaded = $("loadMsg").textContent;
    choose(data.id);
    tab("setup");
    saveTiles(data, (n, of) => {
      $("loadMsg").textContent = `${loaded} ${n < of ? `Saving the map for no signal: ${n}/${of}…` : "✓ Map saved for no signal."}`;
    });
  } catch (err) {
    $("loadMsg").textContent = `✕ Couldn't load that file (${err.message}).`;
  }
  e.target.value = "";
};

function choose(id) {
  current = id; save("current", id); idx = null; draft = null;
  renderDays(); renderRate(); renderAll(); renderSetup();
}

function renderDays() {
  const ids = Object.keys(days);
  $("day").innerHTML = ids.length ? ids.map((id) => `<option value="${esc(id)}" ${id === current ? "selected" : ""}>${esc(days[id].name)}</option>`).join("")
    : `<option>No trip day loaded</option>`;
  $("day").disabled = !ids.length;
}
$("day").onchange = (e) => choose(e.target.value);

function tab(name) {
  for (const [t, panel] of [["tabRate", "rate"], ["tabList", "all"], ["tabSetup", "setup"]]) {
    $(t).setAttribute("aria-pressed", panel === name);
    $(panel).classList.toggle("hidden", panel !== name);
  }
  if (name === "rate") renderRate();
  if (name === "all") renderAll();
  if (name === "setup") renderSetup();
}
$("tabRate").onclick = () => tab("rate");
$("tabList").onclick = () => tab("all");
$("tabSetup").onclick = () => tab("setup");

// --- Google Drive sync -----------------------------------------------------------------------
function chip() {
  const b = $("sync");
  b.className = "chip";
  if (!load("client", CLIENT_ID)) { b.textContent = "⚙ Set up sync"; return; }
  if (!dirty.length) { b.textContent = lastSync ? `✓ Synced ${hhmm(lastSync)}` : "✓ Nothing to send"; b.classList.add("ok"); return; }
  b.classList.add("wait");
  b.textContent = !navigator.onLine ? `⏳ ${dirty.length} waiting for signal` : tokenOk() ? "↻ Syncing…" : "↻ Tap to sync";
}
function tokenOk() { return token && token.exp > Date.now() + 60000; }

function gis() {
  // Google's sign-in script; only loads with signal (the app works without it).
  return new Promise((resolve, reject) => {
    if (window.google && google.accounts && google.accounts.oauth2) return resolve();
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = resolve; s.onerror = () => reject(new Error("no signal"));
    document.head.appendChild(s);
  });
}

async function getToken(interactive) {
  if (tokenOk()) return token.access_token;
  if (!interactive || !navigator.onLine) return null;
  const client = load("client", CLIENT_ID);
  if (!client) return null;
  await gis();
  return new Promise((resolve) => {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: client, scope: SCOPE,
      callback: (resp) => {
        if (resp.error) { $("driveMsg").textContent = `✕ Sign-in failed: ${resp.error}`; return resolve(null); }
        token = { access_token: resp.access_token, exp: Date.now() + resp.expires_in * 1000 };
        save("token", token);
        $("driveMsg").textContent = "✓ Signed in. Ratings will be sent to Google Drive.";
        resolve(token.access_token);
      },
    });
    tokenClient.requestAccessToken({ prompt: load("consented", false) ? "" : "consent" });
    save("consented", true);
  });
}

async function api(method, url, at, body, type) {
  const res = await fetch(url, { method, headers: Object.assign({ Authorization: "Bearer " + at }, type ? { "Content-Type": type } : {}), body });
  if (res.status === 401) { token = null; save("token", null); throw new Error("signed out"); }
  if (!res.ok) throw Object.assign(new Error(`Drive ${res.status}`), { status: res.status });
  return res.json();
}

async function folderId(at) {
  if (drive.folderId) return drive.folderId;
  const q = encodeURIComponent(`name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const found = await api("GET", `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`, at);
  const id = found.files.length ? found.files[0].id : (await api("POST", "https://www.googleapis.com/drive/v3/files", at,
    JSON.stringify({ name: FOLDER, mimeType: "application/vnd.google-apps.folder" }), "application/json")).id;
  drive.folderId = id; save("drive", drive);
  return id;
}

function payload(tripId) {
  const d = days[tripId];
  const now = new Set(d ? d.chunks.map((c) => c.id) : []);
  const all = Object.values(ratings[tripId] || {}).filter((r) => now.has(r.chunk_id));
  const list = all.filter((r) => !r.skipped && !r.not_ridden && r.cls_name);
  return JSON.stringify({ kind: "terratrack-ratings", version: 1, trip_id: tripId, trip_name: d ? d.name : tripId,
                          updated: new Date().toISOString(), ratings: list,
                          not_ridden: all.filter((r) => r.not_ridden).map((r) => ({ chunk_id: r.chunk_id, coords: r.coords })) });
}

async function upload(tripId, at) {
  const body = payload(tripId), fileId = drive.files[tripId];
  if (fileId) {
    try {
      await api("PATCH", `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, at, body, "application/json");
      return;
    } catch (e) { if (e.status !== 404) throw e; }  // file deleted on Drive: make a new one
  }
  const meta = { name: `${tripId}.ratings.json`, parents: [await folderId(at)], mimeType: "application/json" };
  const boundary = "tt" + Date.now();
  const multipart = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  const made = await api("POST", "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", at, multipart, `multipart/related; boundary=${boundary}`);
  drive.files[tripId] = made.id; save("drive", drive);
}

let syncing = false;
async function sync(interactive) {
  chip();
  if (syncing || !dirty.length || !navigator.onLine) return;
  syncing = true;
  try {
    const at = await getToken(interactive);
    if (!at) return;
    for (const id of [...dirty]) {
      await upload(id, at);
      dirty = dirty.filter((x) => x !== id); save("dirty", dirty);
    }
    lastSync = new Date().toISOString(); save("lastSync", lastSync);
  } catch (e) {
    $("driveMsg").textContent = `Not sent yet (${e.message}); kept on the phone.`;
  } finally {
    syncing = false;
    chip();
  }
}

$("sync").onclick = () => { if (!load("client", CLIENT_ID)) tab("setup"); else sync(true); };
$("signin").onclick = async () => {
  const v = $("client").value.trim();
  if (!v.endsWith(".apps.googleusercontent.com")) { $("driveMsg").textContent = "✕ That doesn't look like a Google client ID."; return; }
  save("client", v); token = null; save("token", null);
  await getToken(true);
  sync(true);
};
window.addEventListener("online", () => sync(false));
window.addEventListener("offline", chip);
document.addEventListener("visibilitychange", () => { if (!document.hidden) sync(false); });

// --- Start -----------------------------------------------------------------------------------
if (!current || !days[current]) current = Object.keys(days)[0] || null;
renderDays();
tab(current ? "rate" : "setup");
sync(false);
