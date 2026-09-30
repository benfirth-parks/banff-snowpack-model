// BYK Snowpack Model — front end.
import { GROUPS, PROPS, PROP, colorExpression, legendTicks, fmt } from "./props.js";
import { ProfileChart } from "./profile.js";
import { tzOffset } from "../model/time.js";

const maplibregl = window.maplibregl;
const TZ = "America/Edmonton";
const $ = (id) => document.getElementById(id);
const BANDS = ["ALP", "TL", "BTL"];
const ASPECTS = ["Flat", "N", "E", "S", "W"];

const state = { meta: null, season: null, date: null, prop: "hs", point: null, band: "ALP", aspect: 0, fields: new Map(), points: new Map() };

// ---------- time helpers ----------
const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const todayLocal = () => ymd.format(new Date());
const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const labelFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" });
function snapLabel(t) {
  const p = Object.fromEntries(labelFmt.formatToParts(new Date(t * 3600000)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.month} ${p.day}, ${p.hour}:${p.minute} ${p.timeZoneName}`;
}
const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" });

// ---------- URL state ----------
function readUrl() {
  const q = new URLSearchParams(location.search);
  if (q.get("property") && PROP[q.get("property")]) state.prop = q.get("property");
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.get("date") || "")) state.date = q.get("date");
  if (/^\d{4}-\d{2}$/.test(q.get("season") || "")) state.season = q.get("season");
  if (q.get("point")) state.point = q.get("point");
  if (BANDS.includes(q.get("band"))) state.band = q.get("band");
  if (q.get("aspect") && ASPECTS.includes(q.get("aspect"))) state.aspect = ASPECTS.indexOf(q.get("aspect"));
}
function writeUrl() {
  const q = new URLSearchParams();
  if (state.season && !isLive()) q.set("season", state.season);
  q.set("date", state.date); q.set("property", state.prop);
  if (state.point) { q.set("point", state.point); q.set("band", state.band); q.set("aspect", ASPECTS[state.aspect]); }
  history.replaceState(null, "", `?${q}`);
}

// ---------- data ----------
async function getJSON(url) {
  const r = await fetch(url);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error || r.statusText), { status: r.status });
  return body;
}
const isLive = () => !state.meta || !state.season || state.season === state.meta.season;
const seasonEntry = (id = state.season) => (state.meta.seasons || []).find((s) => s.id === id);
async function field(date) {
  const key = `${state.season}/${date}`;
  const q = isLive() ? "" : `&season=${state.season}`;
  if (!state.fields.has(key)) state.fields.set(key, getJSON(`/api/field?date=${date}${q}`).catch((e) => { state.fields.delete(key); throw e; }));
  return state.fields.get(key);
}
function availableDates() {
  const m = state.meta;
  if (!isLive()) return (seasonEntry() || { dates: [] }).dates;
  return [...new Set([...(m.dates.analysis || []), ...(m.dates.forecast || [])])].sort();
}

// ---------- map ----------
let map;
function cellPolygon(c, g) {
  const lat0 = g.lat0 + c.r * g.dLat, lon0 = g.lon0 + c.c * g.dLon;
  return [[[lon0, lat0], [lon0 + g.dLon, lat0], [lon0 + g.dLon, lat0 + g.dLat], [lon0, lat0 + g.dLat], [lon0, lat0]]];
}
function gridGeoJSON(values) {
  const m = state.meta, p = PROP[state.prop];
  return {
    type: "FeatureCollection",
    features: m.cells.map((c, i) => {
      const v = values ? values[i] : null;
      return { type: "Feature", id: i, properties: { i, v: v ?? null, label: v === null || v === undefined ? "" : fmt(p, v) }, geometry: { type: "Polygon", coordinates: cellPolygon(c, m.grid) } };
    }),
  };
}
function gridCentersGeoJSON(values) {
  const m = state.meta, p = PROP[state.prop], g = m.grid;
  return {
    type: "FeatureCollection",
    features: m.cells.map((c, i) => {
      const v = values ? values[i] : null;
      return { type: "Feature", properties: { label: v === null || v === undefined ? "" : fmt(p, v) }, geometry: { type: "Point", coordinates: [g.lon0 + (c.c + 0.5) * g.dLon, g.lat0 + (c.r + 0.5) * g.dLat] } };
    }),
  };
}
function pointsGeoJSON() {
  const seen = new Set();
  const feats = [];
  for (const p of state.meta.points) {
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    feats.push({ type: "Feature", properties: { pid: p.pid, name: p.name, kind: p.kind }, geometry: { type: "Point", coordinates: [p.lon, p.lat] } });
  }
  return { type: "FeatureCollection", features: feats };
}

const DEM = { type: "raster-dem", encoding: "terrarium", tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 13, attribution: "Terrain: Mapzen / AWS Open Data" };
const FALLBACK_STYLE = {
  version: 8, glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  sources: { dem: DEM }, layers: [{ id: "bg", type: "background", paint: { "background-color": "#f1f0ec" } }],
};

function initMap() {
  map = new maplibregl.Map({
    container: "map", style: "https://tiles.openfreemap.org/styles/positron",
    center: [-116.2, 51.42], zoom: 7.7, minZoom: 6, maxZoom: 13, attributionControl: { compact: true },
  });
  window.snowpackMap = map;
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
  let styled = false;
  const fallback = setTimeout(() => { if (!styled) { map.setStyle(FALLBACK_STYLE); } }, 9000);
  map.on("style.load", () => { styled = true; clearTimeout(fallback); addLayers(); });
  map.on("error", (e) => { if (!styled && /style/i.test(String(e?.error?.message || ""))) { styled = true; clearTimeout(fallback); map.setStyle(FALLBACK_STYLE); } });
}

function firstSymbolId() {
  for (const l of map.getStyle().layers) if (l.type === "symbol") return l.id;
  return undefined;
}

function addLayers() {
  if (map.getSource("grid")) return;
  const before = firstSymbolId();
  if (!map.getSource("dem")) map.addSource("dem", DEM);
  map.addLayer({ id: "hillshade", type: "hillshade", source: "dem", paint: { "hillshade-exaggeration": 0.45, "hillshade-shadow-color": "#6b6b6b", "hillshade-highlight-color": "#ffffff", "hillshade-accent-color": "#8a8a8a" } }, before);
  map.addSource("grid", { type: "geojson", data: gridGeoJSON(null) });
  map.addLayer({ id: "grid-fill", type: "fill", source: "grid", paint: { "fill-color": colorExpression(PROP[state.prop]), "fill-opacity": 0.78 } }, before);
  map.addLayer({ id: "grid-line", type: "line", source: "grid", filter: ["!=", ["get", "v"], null], paint: { "line-color": "rgba(80,90,120,0.28)", "line-width": ["interpolate", ["linear"], ["zoom"], 7, 0.3, 10, 0.8] } }, before);
  map.addLayer({ id: "grid-sel", type: "line", source: "grid", filter: ["==", ["get", "i"], -1], paint: { "line-color": "#1f2328", "line-width": 2 } });
  map.addSource("grid-centers", { type: "geojson", data: gridCentersGeoJSON(null) });
  map.addLayer({
    id: "grid-label", type: "symbol", source: "grid-centers", minzoom: 7.4,
    layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Regular"], "text-size": ["interpolate", ["linear"], ["zoom"], 7.4, 9, 10, 13], "text-allow-overlap": false, "text-padding": 1, "text-ignore-placement": false },
    paint: { "text-color": "#1f2328", "text-halo-color": "rgba(255,255,255,0.7)", "text-halo-width": 1 },
  });
  map.addSource("points", { type: "geojson", data: pointsGeoJSON() });
  map.addLayer({ id: "pt-ring", type: "circle", source: "points", filter: ["==", ["get", "kind"], "named"], paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 7, 11, 12], "circle-color": "rgba(255,255,255,0.05)", "circle-stroke-color": "#555", "circle-stroke-width": 2.5 } });
  map.addLayer({ id: "st-dot", type: "circle", source: "points", filter: ["==", ["get", "kind"], "station"], paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 3.5, 11, 6], "circle-color": "#2f437a", "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } });
  map.addSource("point-labels", { type: "geojson", data: pointsGeoJSON() });
  map.addLayer({
    id: "pt-label", type: "symbol", source: "point-labels",
    layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": ["case", ["==", ["get", "kind"], "named"], 12, 10.5], "text-offset": [0, 1.25], "text-anchor": "top", "text-optional": true },
    paint: { "text-color": ["case", ["==", ["get", "kind"], "named"], "#333", "#2f437a"], "text-halo-color": "#fff", "text-halo-width": 1.6 },
  });
  applyLayerToggles();
  map.on("click", onMapClick);
  for (const id of ["pt-ring", "st-dot"]) {
    map.on("mouseenter", id, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", id, () => { map.getCanvas().style.cursor = ""; });
  }
  renderField();
}

function applyLayerToggles() {
  if (!map || !map.getLayer("grid-label")) return;
  map.setLayoutProperty("grid-label", "visibility", $("showValues").checked ? "visible" : "none");
  const pts = $("showPoints").checked, sts = $("showStations").checked;
  map.setLayoutProperty("pt-ring", "visibility", pts ? "visible" : "none");
  map.setLayoutProperty("st-dot", "visibility", sts ? "visible" : "none");
  map.setFilter("pt-label", ["any", ["all", ["==", ["get", "kind"], "named"], pts], ["all", ["==", ["get", "kind"], "station"], sts, [">=", ["zoom"], 8.6]]]);
}

// ---------- rendering ----------
async function renderField() {
  renderLegend();
  if (!map || !map.getSource("grid")) return;
  map.setPaintProperty("grid-fill", "fill-color", colorExpression(PROP[state.prop]));
  try {
    const f = await field(state.date);
    state.current = f;
    $("banner").hidden = true;
    map.getSource("grid").setData(gridGeoJSON(f.props[state.prop]));
    map.getSource("grid-centers").setData(gridCentersGeoJSON(f.props[state.prop]));
    renderLegend(f);
  } catch (e) {
    state.current = null;
    map.getSource("grid").setData(gridGeoJSON(null));
    map.getSource("grid-centers").setData(gridCentersGeoJSON(null));
    showBanner(e.status === 404 ? `No simulation for ${state.date}.` : `Couldn't load the simulation: ${e.message}`);
  }
}

function showBanner(msg) { const b = $("banner"); b.textContent = msg; b.hidden = false; }

function renderLegend(f) {
  const p = PROP[state.prop];
  const ticks = legendTicks(p);
  const t = f ? f.t : null;
  const when = t ? snapLabel(t) : state.date;
  const grad = `linear-gradient(to right, ${p.ramp.join(",")})`;
  const badge = f && f.kind === "forecast" ? '<span class="fc">FORECAST</span>' : f && f.kind === "reanalysis" ? `<span class="fc re">${f.season} REANALYSIS</span>` : "";
  $("legend").innerHTML = `<div class="ttl">${p.label} | ${when}${badge}</div>` +
    `<div class="sub">${p.sub}</div><div class="bar" style="background:${grad}"></div>` +
    `<div class="ticks">${ticks.map((v, i) => `<span style="left:${(100 * i) / (ticks.length - 1)}%">${v}</span>`).join("")}</div>`;
}

function renderProps() {
  const list = $("propList");
  list.innerHTML = GROUPS.map((g) => `<div class="pgroup">${g.name}</div>` + g.props.map((p) =>
    `<label class="prop${p.key === state.prop ? " on" : ""}"><input type="radio" name="prop" value="${p.key}"${p.key === state.prop ? " checked" : ""}> ${p.label}</label>`).join("")).join("");
  list.querySelectorAll("input").forEach((el) => el.addEventListener("change", () => setProp(el.value)));
}

function setProp(key) {
  state.prop = key;
  renderProps(); writeUrl(); renderField();
}

function renderDateControls() {
  const dates = availableDates();
  const inp = $("dateInput");
  inp.min = dates[0] || ""; inp.max = dates[dates.length - 1] || "";
  inp.value = state.date;
  const today = todayLocal();
  renderSeasonSelect();
  document.querySelectorAll(".quick button").forEach((b) => {
    const d = addDays(today, Number(b.dataset.quick));
    b.disabled = !isLive() || !dates.includes(d);
    b.classList.toggle("on", d === state.date);
  });
}

function renderSeasonSelect() {
  const sel = $("seasonSelect");
  const m = state.meta;
  const opts = [{ id: m.season, label: `${m.season.replace("-", "–")} (current)`, ready: true }]
    .concat((m.seasons || []).map((s) => ({ id: s.id, label: `${s.id.replace("-", "–")}${s.status === "done" ? "" : s.status === "running" ? ` (building ${s.progress}%)` : s.status === "error" ? " (error)" : " (queued)"}`, ready: (s.dates || []).length > 0 })));
  sel.innerHTML = opts.map((o) => `<option value="${o.id}"${o.id === state.season ? " selected" : ""}${o.ready ? "" : " disabled"}>${o.label}</option>`).join("");
}

function setSeason(id) {
  if (id === state.season) return;
  const prev = state.date;
  state.season = id;
  state.points.clear();
  const dates = availableDates();
  // Keep the same day of the season when moving between seasons, if it exists.
  let d = dates[dates.length - 1];
  if (prev && dates.length) {
    const md = prev.slice(5);
    const hit = dates.find((x) => x.slice(5) === md);
    if (hit) d = hit;
  }
  setDate(d);
}

function setDate(d) {
  const dates = availableDates();
  if (!dates.length) return;
  if (!dates.includes(d)) d = dates.reduce((best, x) => (Math.abs(Date.parse(x) - Date.parse(d)) < Math.abs(Date.parse(best) - Date.parse(d)) ? x : best), dates[0]);
  state.date = d;
  renderDateControls(); writeUrl(); renderField();
  if (state.point) renderPanel();
  if (popup) popup.remove();
}

function renderStatus() {
  const m = state.meta;
  const a = m.analysisHour ? hourFmt.format(new Date(m.analysisHour * 3600000)) : "—";
  const f = m.forecastIssued ? hourFmt.format(new Date(m.forecastIssued)) : "—";
  const building = (m.seasons || []).filter((s) => s.status !== "done");
  const past = building.length ? `<br>Past seasons: ${building.map((s) => `${s.id} ${s.status === "running" ? `${s.progress}%` : s.status}`).join(" · ")}` : "";
  $("runStatus").innerHTML = `Station data assimilated to <b>${a}</b><br>Forecast run issued ${f}${past}`;
}

// ---------- cell popup ----------
let popup;
function onMapClick(e) {
  const ptLayers = ["pt-ring", "st-dot"].filter((l) => map.getLayoutProperty(l, "visibility") !== "none");
  const feats = ptLayers.length ? map.queryRenderedFeatures([[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]], { layers: ptLayers }) : [];
  if (feats.length) {
    const pid = feats[0].properties.pid;
    openPoint(pid);
    return;
  }
  const cells = map.queryRenderedFeatures(e.point, { layers: ["grid-fill"] });
  if (!cells.length || !state.current) return;
  const i = cells[0].properties.i;
  const c = state.meta.cells[i];
  const f = state.current;
  const v = (k) => f.props[k][i];
  map.setFilter("grid-sel", ["==", ["get", "i"], i]);
  const row = (k) => `<tr><td>${PROP[k].label}</td><td>${fmt(PROP[k], v(k))}${PROP[k].unit ? " " + PROP[k].unit : ""}</td></tr>`;
  const html = `<div class="pop"><h4>${c.lat.toFixed(3)}°N ${Math.abs(c.lon).toFixed(3)}°W · ${c.z} m</h4>` +
    `<div>${f.text[i] || "No summary."}</div>${chipsHTML({ hazard: v("hazard"), pNew: v("pNew"), pWind: v("pWind"), pPwl: v("pPwl"), pWet: v("pWet") })}` +
    `<table>${["hs", "snow24", "snow72", "rain72", "wind24", "skiPen", "critPwlDepth", "lwc"].map(row).join("")}</table>` +
    `<div class="muted small">${snapLabel(f.t)} · ${f.kind}</div></div>`;
  if (popup) popup.remove();
  popup = new maplibregl.Popup({ maxWidth: "340px" }).setLngLat(e.lngLat).setHTML(html).addTo(map);
  popup.on("close", () => map.setFilter("grid-sel", ["==", ["get", "i"], -1]));
}

function chipsHTML(v) {
  const c = (cls, label, x) => `<span class="chip ${cls}">${label} ${x === null || x === undefined ? "–" : Math.round(x) + "%"}</span>`;
  return `<div class="chips">${c("haz", "Hazard", v.hazard)}${c("new", "New", v.pNew)}${c("wind", "Wind", v.pWind)}${c("pwl", "PWL", v.pPwl)}${c("wet", "Wet", v.pWet)}</div>`;
}

// ---------- point panel ----------
let chart;
function pointEntries(pid) { return state.meta.points.filter((p) => p.pid === pid); }

async function openPoint(pid) {
  state.point = pid;
  const entries = pointEntries(pid);
  if (!entries.length) { state.point = null; return; }
  if (entries[0].kind === "named" && !BANDS.includes(state.band)) state.band = "ALP";
  $("panel").hidden = false; $("hint").hidden = true;
  if (popup) popup.remove();
  writeUrl();
  renderPanel();
  setTimeout(() => map && map.resize(), 50);
}

function closePoint() {
  state.point = null;
  $("panel").hidden = true; $("hint").hidden = false;
  writeUrl();
  setTimeout(() => map && map.resize(), 50);
}

async function pointData(id) {
  const q = isLive() ? "" : `&season=${state.season}`;
  if (!state.points.has(id)) state.points.set(id, getJSON(`/api/point?id=${encodeURIComponent(id)}${q}`).catch((e) => { state.points.delete(id); throw e; }));
  return state.points.get(id);
}

async function renderPanel() {
  const entries = pointEntries(state.point);
  if (!entries.length) return;
  const named = entries[0].kind === "named";
  const entry = named ? entries.find((e) => e.band === state.band) || entries[0] : entries[0];
  $("panelTitle").textContent = entry.name;
  $("panelSub").textContent = named ? `${entry.park} · simulated at ${entry.z} m (${entry.band})` : `Weather station · ${entry.park} · ${entry.z} m`;
  $("bandTabs").innerHTML = named ? entries.map((e) => `<button role="tab" data-band="${e.band}" class="${e.band === state.band ? "on" : ""}">${e.band} ${e.z}m</button>`).join("") : "";
  $("bandTabs").hidden = !named;
  $("aspectTabs").innerHTML = ASPECTS.map((a, i) => `<button role="tab" data-aspect="${i}" class="${i === state.aspect ? "on" : ""}">${a}</button>`).join("");
  $("bandTabs").querySelectorAll("button").forEach((b) => b.onclick = () => { state.band = b.dataset.band; writeUrl(); renderPanel(); });
  $("aspectTabs").querySelectorAll("button").forEach((b) => b.onclick = () => { state.aspect = Number(b.dataset.aspect); writeUrl(); renderPanel(); });
  if (!chart) chart = new ProfileChart($("profileCanvas"), $("profileTip"), { onPickDate: (d) => setDate(d), tzOffset });
  chart.set(null);
  let data;
  try { data = await pointData(entry.id); } catch (e) {
    $("summaryText").textContent = `Couldn't load this point: ${e.message}`; $("chips").innerHTML = ""; return;
  }
  const anaDates = new Set(data.days.map((d) => d.date));
  const days = data.days.map((d) => ({ ...d, dateLabel: snapLabel(d.t) }))
    .concat(((data.forecast && data.forecast.days) || []).filter((d) => !anaDates.has(d.date)).map((d) => ({ ...d, fc: true, dateLabel: snapLabel(d.t) })));
  const sel = days.find((d) => d.date === state.date) || days[days.length - 1];
  const asp = ASPECTS[state.aspect];
  chart.set({
    days, aspect: state.aspect, selectedDate: sel ? sel.date : null, hasObs: !named,
    title: `${entry.name} (${named ? entry.band + " " : ""}${entry.z}m) · ${asp === "Flat" ? "flat" : asp + " 38°"}${isLive() ? "" : ` · ${state.season.replace("-", "–")}`}`,
    dateLabel: sel ? sel.dateLabel + (sel.fc ? " (fcst)" : "") : "",
  });
  if (!sel) { $("summaryText").textContent = "No simulated days yet."; $("chips").innerHTML = ""; return; }
  $("summaryText").textContent = sel.text || "";
  $("chips").innerHTML = chipsHTML(sel.v || {}).replace(/^<div class="chips">|<\/div>$/g, "");
  const p = sel.p && sel.p[state.aspect];
  let extra = p ? `This aspect: hazard ${p[0]}% · new ${p[1]}% · wind ${p[2]}% · PWL ${p[3]}% · wet ${p[4]}% · HS ${sel.hs[state.aspect]} cm` : "";
  if (!named) {
    const withObs = data.days.filter((d) => d.obsHS !== null && d.obsHS !== undefined);
    if (withObs.length) {
      const diffs = withObs.map((d) => d.hs[0] - d.obsHS);
      const bias = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      const mae = diffs.reduce((a, b) => a + Math.abs(b), 0) / diffs.length;
      extra += `<br>*Observed HS has the sensor's bare-ground baseline removed. Model vs observed HS (flat, ${withObs.length} days): bias ${bias >= 0 ? "+" : ""}${bias.toFixed(0)} cm, mean abs. error ${mae.toFixed(0)} cm${sel.obsHS != null ? ` · observed ${Math.round(sel.obsHS)} cm on this date` : ""}.`;
    } else extra += "<br>No snow-height sensor data from this station yet.";
  }
  $("pointExtra").innerHTML = extra;
}

// ---------- status dialog ----------
async function openStatus() {
  const dlg = $("statusDialog");
  dlg.showModal();
  $("statusBody").textContent = "Loading…";
  try {
    const { status: s, lastError, running, seasons, seasonRunning } = await getJSON("/api/status");
    const seasonTable = (seasons || []).length ? `<h3>Past seasons (reanalysis)</h3><p class="muted">Archived HRDPS runs corrected with the station actuals held in the explorer archive. Coverage is the share of hours with data.</p><table><thead><tr><th>Season</th><th>Status</th><th>Days built</th><th>Model</th><th>Station coverage (T / HS)</th></tr></thead><tbody>${seasons.map((x) => `<tr><td>${x.id}</td><td>${x.status}${x.status === "running" ? ` ${x.progress}%` : ""}${x.id === seasonRunning ? " ⟳" : ""}${x.error ? ` — ${x.error}` : ""}</td><td>${x.days}</td><td>${x.modelSource || "–"}</td><td>${x.coverage ? Object.entries(x.coverage).filter(([, c]) => c.T || c.HS).map(([id, c]) => `${id.replace("fts-", "")} ${c.T}/${c.HS}`).join(", ") : "–"}</td></tr>`).join("")}</tbody></table>` : "";
    if (!s) { $("statusBody").innerHTML = (running ? "The first model run is in progress." : "The model has not run yet.") + seasonTable; return; }
    const hf = (t) => (t ? hourFmt.format(new Date(t * 3600000)) : "—");
    const rows = (s.stations || []).map((x) => `<tr><td>${x.name}</td><td>${x.biasT === null ? "–" : (x.biasT > 0 ? "+" : "") + x.biasT}</td><td>${x.biasRH === null ? "–" : (x.biasRH > 0 ? "+" : "") + x.biasRH}</td><td>${x.windRatio ?? "–"}</td><td>${(x.precip || []).map((p) => `${p.obs}/${p.model}`).join(", ") || "–"}</td></tr>`).join("");
    const val = await getJSON(`/api/validation${isLive() ? "" : `?season=${state.season}`}`).catch(() => null);
    const valTable = val && val.rows.some((x) => x.n >= 5) ? `<h3>Snow height check, ${val.season}</h3><p class="muted">Model (flat) minus station sensor (bare-ground baseline removed), over days with a reading. r is the correlation of the two series.</p><table><thead><tr><th>Station</th><th>Days</th><th>Bias cm</th><th>Mean abs. error cm</th><th>r</th><th>Peak obs / model cm</th></tr></thead><tbody>${val.rows.filter((x) => x.n >= 5).map((x) => `<tr><td>${x.name} (${x.z} m)</td><td>${x.n}</td><td>${x.bias > 0 ? "+" : ""}${x.bias}</td><td>${x.mae}</td><td>${x.r ?? "–"}</td><td>${x.obsMax[1]} / ${x.modelMax[1]}</td></tr>`).join("")}</tbody></table>` : "";
    $("statusBody").innerHTML =
      `<p>Last run finished ${new Date(s.finishedAt).toLocaleString("en-CA", { timeZone: TZ })} in ${(s.durationMs / 1000).toFixed(1)} s. ` +
      `Analysis ${hf(s.analysisFrom)} → ${hf(s.analysisTo)}; ${s.doForecast ? `forecast to ${hf(s.forecastTo)}` : "forecast not re-run this hour"}. ` +
      `Model data: ${s.modelSource}. Stations reporting: ${s.stationsReporting}. Current model lapse rate ${s.lapse} °C/km.${running ? " <b>A run is in progress.</b>" : ""}</p>` +
      (s.stationErrors?.length || s.modelErrors?.length ? `<p class="muted">Fetch issues: ${[...(s.stationErrors || []), ...(s.modelErrors || [])].join("; ")}</p>` : "") +
      (lastError ? `<p class="muted">Last error (${lastError.at}): ${String(lastError.error).split("\n")[0]}</p>` : "") +
      `<p>Station corrections applied to the forecast-model first guess. Temperature and humidity: mean observed − model over the last 6 hours (persisted into the forecast with a 12 h / 6 h decay). Wind: observed ÷ model ratio. Precipitation: observed / model mm for each 24 h window ending 17:00 (gauge or snow-height gain).</p>` +
      ((s.hsCheck || []).length ? `<p>Snow height now: model (flat) vs station sensor. The sensor's bare-ground reading (its baseline, from warm snow-free hours) is subtracted first.</p><table><thead><tr><th>Station</th><th>Elev</th><th>Observed HS cm</th><th>Sensor raw / baseline</th><th>Model HS cm</th></tr></thead><tbody>${s.hsCheck.map((h) => `<tr><td>${h.name}</td><td>${h.z} m</td><td>${h.obsHS ?? "–"}</td><td>${h.rawHS ?? "–"} / ${h.baseline ?? "–"}</td><td>${h.modelHS ?? "–"}</td></tr>`).join("")}</tbody></table>` : "") +
      `<table><thead><tr><th>Station</th><th>T bias °C</th><th>RH bias %</th><th>Wind ratio</th><th>Precip obs/model mm (recent days)</th></tr></thead><tbody>${rows}</tbody></table>` + valTable + seasonTable;
  } catch (e) {
    $("statusBody").textContent = `Couldn't load status: ${e.message}`;
  }
}

// ---------- boot ----------
function wire() {
  $("datePrev").onclick = () => { const d = availableDates(); const i = d.indexOf(state.date); if (i > 0) setDate(d[i - 1]); };
  $("dateNext").onclick = () => { const d = availableDates(); const i = d.indexOf(state.date); if (i >= 0 && i < d.length - 1) setDate(d[i + 1]); };
  $("dateInput").onchange = (e) => e.target.value && setDate(e.target.value);
  $("seasonSelect").onchange = (e) => setSeason(e.target.value);
  document.querySelectorAll(".quick button").forEach((b) => b.onclick = () => setDate(addDays(todayLocal(), Number(b.dataset.quick))));
  const step = (dir) => { const i = PROPS.findIndex((p) => p.key === state.prop); setProp(PROPS[(i + dir + PROPS.length) % PROPS.length].key); };
  $("propPrev").onclick = () => step(-1);
  $("propNext").onclick = () => step(1);
  ["showValues", "showPoints", "showStations"].forEach((id) => $(id).onchange = applyLayerToggles);
  $("panelClose").onclick = closePoint;
  $("copySummary").onclick = () => navigator.clipboard && navigator.clipboard.writeText($("summaryText").textContent);
  $("openStatus").onclick = openStatus;
  $("statusClose").onclick = () => $("statusDialog").close();
  $("sidebarToggle").onclick = () => { const b = $("sidebarBody"); b.classList.toggle("collapsed"); $("sidebarToggle").setAttribute("aria-expanded", String(!b.classList.contains("collapsed"))); };
  if (window.matchMedia("(max-width: 900px)").matches) $("sidebarBody").classList.add("collapsed");
}

async function boot() {
  readUrl();
  renderProps();
  wire();
  try {
    state.meta = await getJSON("/api/meta");
  } catch (e) {
    renderLegend();
    initMap();
    showBanner(e.status === 503 ? "The model is spinning up its first season run. Check back in a few minutes." : `Couldn't reach the model: ${e.message}`);
    $("runStatus").textContent = "No model run yet.";
    return;
  }
  if (!state.season || !(state.season === state.meta.season || seasonEntry())) state.season = state.meta.season;
  if (!isLive() && !(seasonEntry().dates || []).length) state.season = state.meta.season;
  const dates = availableDates();
  const today = todayLocal();
  if (!state.date || !dates.includes(state.date)) state.date = isLive() && dates.includes(today) ? today : dates[dates.length - 1];
  renderDateControls();
  renderStatus();
  writeUrl();
  initMap();
  if (state.point) openPoint(state.point);
}

boot();
