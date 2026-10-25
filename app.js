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
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

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
  const left = d.chunks.filter((c) => !r[c.id]).length;
  if (idx < 0) {
    el.innerHTML = `<div class="card empty"><h2>✓ All ${d.chunks.length} rated</h2><p class="muted">${esc(d.name)} · ${d.miles} mi. Change any on the <b>All</b> tab.</p></div>`;
    return;
  }
  const c = d.chunks[idx];
  const saved = r[c.id];
  draft = draft && draft.id === c.id ? draft : { id: c.id, cls: saved?.cls_name || null, liked: saved?.liked || 0, note: saved?.note || "" };
  const asSaid = CLASSES.includes(c.guess);
  el.innerHTML = `
    <p class="muted">${left} of ${d.chunks.length} left · chunk ${idx + 1}</p>
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
      ${asSaid ? `<button type="button" class="big" id="asSaid" aria-pressed="${draft.cls === c.guess}">As TerraTrack said (${esc(c.guess)})</button>` : ""}
      <div class="thumbs">
        <button type="button" data-like="1" aria-pressed="${draft.liked === 1}">👍 Liked it</button>
        <button type="button" data-like="-1" aria-pressed="${draft.liked === -1}">👎 Didn't</button>
      </div>
      <textarea id="note" rows="2" placeholder="Note (tap the mic on the keyboard)">${esc(draft.note)}</textarea>
      <div class="nav">
        <button type="button" id="back" ${idx === 0 ? "disabled" : ""}>◀ Back</button>
        <button type="button" id="skip">Skip</button>
        <button type="button" id="next" class="next">${draft.cls ? "Save ▶" : "Next ▶"}</button>
      </div>
      ${saved ? `<p class="muted">${saved.skipped ? "Skipped" : "Saved"} ${hhmm(saved.rated_at)}</p>` : ""}
    </div>`;
  el.querySelectorAll("[data-cls]").forEach((b) => b.onclick = () => { draft.cls = draft.cls === b.dataset.cls ? null : b.dataset.cls; renderRate(); });
  if (asSaid) $("asSaid").onclick = () => { draft.cls = c.guess; renderRate(); };
  el.querySelectorAll("[data-like]").forEach((b) => b.onclick = () => { const v = +b.dataset.like; draft.liked = draft.liked === v ? 0 : v; renderRate(); });
  $("note").oninput = (e) => { draft.note = e.target.value; };
  $("back").onclick = () => { draft = null; idx = Math.max(0, idx - 1); renderRate(); };
  $("skip").onclick = () => { store(c, { skipped: true }); move(); };
  $("next").onclick = () => { if (draft.cls) store(c, { cls_name: draft.cls }); move(); };
  el.querySelectorAll("[data-jump]").forEach((b) => b.onclick = () => { draft = null; idx = +b.dataset.jump; renderRate(); });
  miniMap = drawDay(miniMap, "daymap", d, r, idx, false);
  $("daymap").onclick = () => openFull(d, r, idx);
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
  L.polyline(routeOf(d), { color: "#868e96", weight: full ? 4 : 3, opacity: 0.9 }).addTo(map);
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
  (d.towns || []).slice(0, full ? 40 : 6).forEach((t) => L.marker([t.lat, t.lon], { interactive: false, icon: L.divIcon({
    className: "", iconSize: [0, 0], html: `<div class="town ${t.kind === "city" || t.kind === "town" ? "big" : ""}">${esc(t.name)}</div>` }) }).addTo(map));
  if (full) map.fitBounds(L.latLngBounds(c.coords).pad(0.6));
  else map.fitBounds(L.latLngBounds(route), { padding: [8, 8] });
  return map;
}

function openFull(d, r, current) {
  $("full").classList.remove("hidden");
  fullMap = drawDay(fullMap, "fullmap", d, r, current, true);
  setTimeout(() => fullMap && fullMap.invalidateSize(), 50);
}
$("fullClose").onclick = () => { $("full").classList.add("hidden"); };

function strip(d, r, current) {
  // One bar for the whole day, a block per chunk (width by miles); tap one to go to it.
  return `<div class="strip" aria-label="Where this chunk is in the day">` + d.chunks.map((c, i) => {
    const s = r[c.id];
    const bg = i === current ? "#1c7ed6" : s && s.cls_name ? RATED[s.cls_name] : s ? "#ffd8a8" : "#dee2e6";
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

function store(c, fields) {
  const r = dayRatings();
  r[c.id] = Object.assign({ chunk_id: c.id, liked: draft.liked || 0, note: draft.note.trim(), rated_at: new Date().toISOString(),
                            coords: c.coords, guess: c.guess }, fields);
  save("ratings", ratings);
  if (!dirty.includes(current)) dirty.push(current);
  save("dirty", dirty);
  sync(false);
}

function move() {
  draft = null;
  const d = day(), r = dayRatings();
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
      const mark = !s ? `<span class="mark todo">○ To rate</span>` : s.skipped ? `<span class="mark skip">– Skipped</span>`
        : `<span class="mark done">✓ ${esc(s.cls_name)}${s.liked === 1 ? " 👍" : s.liked === -1 ? " 👎" : ""}</span>`;
      return `<li data-i="${i}">${mark}<span>${esc(c.roads)}<br><span class="muted">mile ${c.from_mi}–${c.to_mi} · ${c.miles} mi</span></span></li>`;
    }).join("") + "</ul>";
  el.querySelectorAll("li").forEach((li) => li.onclick = () => { idx = +li.dataset.i; draft = null; tab("rate"); });
}

// --- Setup tab -------------------------------------------------------------------------------
function renderSetup() {
  $("client").value = load("client", CLIENT_ID);
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
  const list = Object.values(ratings[tripId] || {}).filter((r) => !r.skipped && r.cls_name);
  return JSON.stringify({ kind: "terratrack-ratings", version: 1, trip_id: tripId, trip_name: d ? d.name : tripId,
                          updated: new Date().toISOString(), ratings: list });
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
