// Exports the station-corrected forcing that scripts/replay.mjs feeds our model
// as SMET files, one per point and season, so SLF's SNOWPACK can be run at the
// same points on identical weather (validation/snowpack/). The forcing is built
// exactly as in replay.mjs: same prepareForcing call, same station archive,
// snow-height baselines and node handling. No network.
//
//   node validation/snowpack/export-smet.mjs --forcing <dir> --stations <dir> --out <dir>
//        [--seasons 2023-24,2024-25] [--code <repo root>] [--nodes cell|dem]
//        [--points <comma list of point ids>]
//
// --code   repo whose model code builds the forcing (default: this one).
// --nodes  as in replay.mjs; the v5/v6 replays used "dem".
//
// Output: <out>/<season>/<id>.smet (SMET 1.1 ASCII, hourly, UTC, tz = 0) with
// fields timestamp TA RH VW DW ISWR ILWR PSUM PSUM_PH TSG HS. HS (m) is given
// only at station points with a snow-height sensor, for
// ENFORCE_MEASURED_SNOW_HEIGHTS, and is the sensor series as our model reads it:
// cleaned by cleanHS (plateaus, spikes and drop-outs removed), baseline-adjusted,
// and made gap-free (0 before the first accepted reading, linear across gaps,
// held after the last), because SNOWPACK stops at the first step without an HS
// value when heights are enforced. The unfiltered baseline-adjusted sensor
// series, which the replay scores against (obsHS), goes to <out>/<season>/<id>.hs.json
// as { t0: epoch hour of v[0], v: [cm or null per hour] } so pro2days.mjs can
// give SNOWPACK the same obsHS as our model. TSG is 273.15 K: no soil, 0 °C
// ground, like our model. <out>/<season>/meta.json lists the files
// ({ id, file, lat, lon, z, hasHS, start, end }); <out>/points.json is the
// replay's point list, which compare.mjs reads.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseStationRows } from "../../netlify/lib/fetchers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const CODE = resolve(args.code || join(HERE, "..", ".."));
const FORCING = args.forcing, STN = args.stations, OUT = args.out;
const NODES = args.nodes || "cell";
const ONLY = args.points ? new Set(args.points.split(",")) : null;
if (!FORCING || !STN || !OUT) { console.error("--forcing, --stations and --out are required"); process.exit(1); }

const imp = (p) => import(pathToFileURL(join(CODE, p)).href);
const { STATIONS, NAMED_POINTS, BANDS } = await imp("src/model/domain.js");
const { prepareForcing, snapshotWindows, cleanHS } = await imp("src/model/forcing.js");
const { snapHour, isSnapHour } = await imp("src/model/time.js");
const { HIST, hsBaselines, adjHS } = await imp("netlify/lib/pipeline.mjs");

const SEASONS = { "2023-24": ["2023-09-01", "2024-06-30"], "2024-25": ["2024-09-01", "2025-06-30"], "2025-26": ["2025-09-01", "2026-06-30"] };
const wanted = (args.seasons || Object.keys(SEASONS).join(",")).split(",");
const gz = (f) => JSON.parse(gunzipSync(readFileSync(f)));
const ok = (v) => v !== null && v !== undefined && Number.isFinite(v);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const NODATA = "-999";
const T0K = 273.15;
// SMET timestamps: ISO 8601 in the file's tz (UTC here), minutes are enough for hourly rows.
const iso = (t) => new Date(t * 3600000).toISOString().slice(0, 16);

// Station archive → parsed hourly records, as the live fetcher returns them.
const obsAll = {};
for (const f of readdirSync(STN)) {
  if (!f.endsWith(".json.gz")) continue;
  const d = gz(join(STN, f));
  const cols = d.columns, n = cols.measurementDateTime.length;
  const rows = [];
  for (let i = 0; i < n; i++) { const r = {}; for (const k of Object.keys(cols)) r[k] = cols[k][i]; rows.push(r); }
  obsAll[d.id] = parseStationRows(rows);
}

const points = [];
for (const p of NAMED_POINTS) for (const b of BANDS) points.push({ id: `${p.id}:${b.id}`, pid: p.id, name: p.name, band: b.id, lat: p.lat, lon: p.lon, z: b.z, park: p.park, kind: "named" });
for (const s of STATIONS) if (!s.noPoint) points.push({ id: s.id, pid: s.id, name: s.name, band: null, lat: s.lat, lon: s.lon, z: s.z, park: s.park, kind: "station" });
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "points.json"), JSON.stringify(points, null, 1));
const selected = ONLY ? points.filter((p) => ONLY.has(p.id)) : points;
if (ONLY) for (const id of ONLY) if (!points.some((p) => p.id === id)) console.error(`unknown point ${id}`);

// The HS column for SNOWPACK: cleanHS (as forcing.js applies it to the same
// series before snow-height-driven snowfall), minus the sensor's bare-ground
// baseline, then gap-free. Returns { v: cm per hour, filled: hours interpolated
// or extrapolated, first, last: indices of the first and last accepted reading },
// or null when the season has no accepted reading.
function hsSeries(raw, base, kA) {
  const c = cleanHS(raw, kA).map((v) => (ok(v) ? Math.max(0, v - base) : null));
  const first = c.findIndex(ok);
  if (first < 0) return null;
  const v = new Array(c.length).fill(null), fill = new Array(c.length).fill(true);
  let prev = first;
  for (let j = 0; j < first; j++) v[j] = 0;
  for (let k = first; k < c.length; k++) {
    if (!ok(c[k])) continue;
    for (let j = prev + 1; j < k; j++) v[j] = c[prev] + ((c[k] - c[prev]) * (j - prev)) / (k - prev);
    v[k] = c[k]; fill[k] = false; prev = k;
  }
  for (let j = prev + 1; j < c.length; j++) v[j] = c[prev];
  return { v, fill, first, last: prev };
}

function header(p) {
  return [
    "SMET 1.1 ASCII", "[HEADER]",
    `station_id       = ${p.id.replace(":", "_")}`,
    `station_name     = ${p.name}${p.band ? " " + p.band : ""}`,
    `latitude         = ${p.lat}`, `longitude        = ${p.lon}`, `altitude         = ${p.z}`,
    `nodata           = ${NODATA}`, "tz               = 0",
    "fields           = timestamp TA RH VW DW ISWR ILWR PSUM PSUM_PH TSG HS",
    "[DATA]",
  ];
}

for (const season of wanted) {
  const [a, b] = SEASONS[season];
  const tStart = Date.now();
  const fc = gz(join(FORCING, "forcing", `${season}.json.gz`));
  const T0 = Math.floor(snapHour(a) - 17), T1 = snapHour(b);
  const start = Math.max(T0 - HIST, fc.t0);
  const end = Math.min(T1, fc.t0 + fc.n - 1);
  const times = [];
  for (let t = start; t <= end; t++) times.push(t);
  const kOf = (t) => t - start;
  const nodes = fc.nodes.map((nd, i) => {
    const v = {};
    for (const key of ["T", "RH", "P", "U", "dir", "ghi", "dirH", "difH", "cc"]) v[key] = times.map((t) => fc.vars[key][i][t - fc.t0] ?? null);
    let z = nd.zCell;
    if (NODES === "dem" && ok(nd.zDem) && ok(nd.zCell)) {
      const dT = -0.0065 * (nd.zDem - nd.zCell);
      v.T = v.T.map((x) => (ok(x) ? x + dT : x));
      z = nd.zDem;
    }
    return { id: nd.id, lat: nd.lat, lon: nd.lon, z, t0: start, v };
  }).filter((n) => ok(n.z));
  const baselines = hsBaselines(Object.fromEntries(STATIONS.map((s) => [s.id, (obsAll[s.id] || []).filter((r) => r.t >= start && r.t <= end)])));
  const stations = STATIONS.map((s) => {
    const byT = new Map((obsAll[s.id] || []).map((r) => [r.t, r]));
    const o = { T: [], RH: [], U: [], HS: [], P: [] };
    for (const t of times) { const r = byT.get(t); for (const k of Object.keys(o)) o[k].push(r ? r[k] : null); }
    return { ...s, o, hsBase: baselines[s.id]?.base ?? 0 };
  });
  const kA = times.length - 1;
  const F = prepareForcing({ times, nodes, stations, tA: end, windows: snapshotWindows(times, kA, isSnapHour) });
  mkdirSync(join(OUT, season), { recursive: true });
  const meta = [];
  const from = Math.max(T0, start) + 1; // first hour the replay advances through
  const hsNotes = [];
  for (const p of selected) {
    const W = F.weightsFor({ id: p.id, lat: p.lat, lon: p.lon, z: p.z });
    const stn = p.kind === "station" ? stations.find((s) => s.id === p.id) : null;
    const base = baselines[p.id]?.base ?? 0; // the station's hsBase in the model, and adjHS's offset in the replay
    const hs = stn && stn.o.HS.some(ok) ? hsSeries(stn.o.HS, base, kA) : null;
    const lines = header(p);
    let filled = 0;
    for (let t = from; t <= end; t++) {
      const k = kOf(t), f = F.at(W, k);
      const P = +Math.max(0, f.P).toFixed(4); // rounded first, so a dry row also has phase 0
      let HS = NODATA;
      if (hs) { HS = (hs.v[k] / 100).toFixed(3); if (hs.fill[k]) filled++; }
      lines.push([
        iso(t), (f.Ta + T0K).toFixed(2), clamp(f.RH / 100, 0.01, 1).toFixed(3), Math.max(0, f.U).toFixed(2),
        ok(f.dir) ? String(((Math.round(f.dir) % 360) + 360) % 360) : NODATA, Math.max(0, f.ghi).toFixed(1), f.lw.toFixed(1),
        P.toFixed(4), (P > 0 ? clamp(1 - f.sf, 0, 1) : 0).toFixed(3), T0K.toFixed(2), HS,
      ].join(" "));
    }
    const stem = p.id.replace(":", "_");
    writeFileSync(join(OUT, season, `${stem}.smet`), lines.join("\n") + "\n");
    if (hs) {
      // What the replay scores against: adjHS of the unfiltered sensor reading each hour (replay.mjs obsHS).
      writeFileSync(join(OUT, season, `${stem}.hs.json`), JSON.stringify({ t0: from, v: stn.o.HS.slice(kOf(from), kA + 1).map((x) => adjHS(x, baselines[p.id])) }));
      hsNotes.push(`${p.id} accepted ${iso(start + hs.first).slice(0, 10)}..${iso(start + hs.last).slice(0, 10)}, ${filled} h filled`);
    }
    meta.push({ id: p.id, file: `${stem}.smet`, lat: p.lat, lon: p.lon, z: p.z, hasHS: !!hs, start: iso(from), end: iso(end) });
  }
  writeFileSync(join(OUT, season, "meta.json"), JSON.stringify(meta, null, 1));
  console.log(`${season}: ${selected.length} points, ${end - from + 1} hours, ${((Date.now() - tStart) / 1000).toFixed(0)} s`);
  for (const n of hsNotes) console.log(`  HS ${n}`);
}
