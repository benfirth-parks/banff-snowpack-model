// Replays past seasons locally for the model's named points and stations, from
// the cached forcing (`forcing-cache` branch) and the station archive
// (`validation-data` branch), and writes point profiles in the layout
// validation/compare.mjs reads. No network.
//
//   node scripts/replay.mjs --forcing <dir> --stations <dir> --out <dir>
//        [--seasons 2023-24,2024-25] [--code <repo root>] [--nodes cell|dem]
//
// --code   repo whose model code to run (default: this one), so an older version
//          can be replayed from a git worktree with the same inputs.
// --nodes  "cell" uses the raw HRDPS grid-cell temperature and height; "dem"
//          rebuilds Open-Meteo's default downscaling to the 90 m DEM
//          (0.65 °C/100 m), which is what model v2 was fed.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseStationRows } from "../netlify/lib/fetchers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const CODE = resolve(args.code || join(HERE, ".."));
const FORCING = args.forcing, STN = args.stations, OUT = args.out;
const NODES = args.nodes || "cell";
if (!FORCING || !STN || !OUT) { console.error("--forcing, --stations and --out are required"); process.exit(1); }

const imp = (p) => import(pathToFileURL(join(CODE, p)).href);
const { STATIONS, NAMED_POINTS, BANDS } = await imp("src/model/domain.js");
const { prepareForcing, snapshotWindows } = await imp("src/model/forcing.js");
const { createSite } = await imp("src/model/site.js");
const { localDate, snapHour, isSnapHour } = await imp("src/model/time.js");
const pl = await imp("netlify/lib/pipeline.mjs");
const { HIST, initExtras, advance, closeDay, snapshot, hsBaselines, adjHS, MODEL_VERSION } = pl;

const SEASONS = { "2023-24": ["2023-09-01", "2024-06-30"], "2024-25": ["2024-09-01", "2025-06-30"], "2025-26": ["2025-09-01", "2026-06-30"] };
const wanted = (args.seasons || Object.keys(SEASONS).join(",")).split(",");
const gz = (f) => JSON.parse(gunzipSync(readFileSync(f)));
const ok = (v) => v !== null && v !== undefined && Number.isFinite(v);

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

for (const season of wanted) {
  const [a, b] = SEASONS[season];
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
  const stations = STATIONS.map((s) => {
    const byT = new Map((obsAll[s.id] || []).map((r) => [r.t, r]));
    const o = { T: [], RH: [], U: [], HS: [], P: [] };
    for (const t of times) { const r = byT.get(t); for (const k of Object.keys(o)) o[k].push(r ? r[k] : null); }
    return { ...s, o };
  });
  const baselines = hsBaselines(Object.fromEntries(STATIONS.map((s) => [s.id, (obsAll[s.id] || []).filter((r) => r.t >= start && r.t <= end)])));
  const kA = times.length - 1;
  const F = prepareForcing({ times, nodes, stations, tA: end, windows: snapshotWindows(times, kA, isSnapHour) });
  mkdirSync(join(OUT, season), { recursive: true });
  const t0 = Date.now();
  for (const p of points) {
    const site = initExtras(createSite({ id: p.id, lat: p.lat, lon: p.lon, z: p.z }));
    const W = F.weightsFor(site);
    const hsObs = p.kind === "station" ? stations.find((s) => s.id === p.id)?.o.HS : null;
    const days = [];
    for (let t = Math.max(T0, start) + 1; t <= end; t++) {
      advance(site, F.at(W, kOf(t)));
      if (isSnapHour(t)) {
        closeDay(site, t);
        const s = snapshot(site, t, true);
        const k = kOf(t);
        days.push({ t, date: localDate(t), ...s.prof, v: s.v, text: s.text, obsHS: hsObs ? adjHS(hsObs[k] ?? hsObs[k - 1], baselines[p.id]) : undefined });
      }
    }
    writeFileSync(join(OUT, season, `${p.id.replace(":", "_")}.json.gz`), gzipSync(JSON.stringify({ id: p.id, season, point: p, days })));
  }
  console.log(`${season}: ${points.length} points, model v${MODEL_VERSION} (${NODES} nodes), ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
