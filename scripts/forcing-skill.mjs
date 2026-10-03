// Scores the forcing chain's air temperature and humidity against the stations,
// from the cached forcing and station archive (see scripts/replay.mjs).
//
//   node scripts/forcing-skill.mjs --forcing <dir> --stations <dir>
//        [--seasons 2024-25] [--code <repo root>] [--nodes cell|dem]
//
// Analysis (leave one out): each station is withheld in turn and the analysed
// temperature at its location is compared with what it measured, December to
// March. This is how well the model knows the weather at places without a station.
// Forecast: every 3rd day at 12 UTC the analysis stops, and the next 48 h at each
// station are compared with what it then measured, by lead time.
import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseStationRows } from "../netlify/lib/fetchers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const CODE = resolve(args.code || join(HERE, ".."));
const NODES = args.nodes || "cell";
const imp = (p) => import(pathToFileURL(join(CODE, p)).href);
const { STATIONS } = await imp("src/model/domain.js");
const { prepareForcing } = await imp("src/model/forcing.js");
const gz = (f) => JSON.parse(gunzipSync(readFileSync(f)));
const ok = (v) => v !== null && v !== undefined && Number.isFinite(v);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "–");

const obsAll = {};
for (const f of readdirSync(args.stations)) {
  if (!f.endsWith(".json.gz")) continue;
  const d = gz(join(args.stations, f));
  const cols = d.columns;
  const rows = cols.measurementDateTime.map((_, i) => Object.fromEntries(Object.keys(cols).map((k) => [k, cols[k][i]])));
  obsAll[d.id] = parseStationRows(rows);
}

for (const season of (args.seasons || "2024-25").split(",")) {
  const fc = gz(join(args.forcing, "forcing", `${season}.json.gz`));
  const y0 = Number(season.slice(0, 4));
  const t0 = Date.parse(`${y0}-12-01T00:00:00Z`) / 3.6e6, t1 = Date.parse(`${y0 + 1}-04-01T00:00:00Z`) / 3.6e6;
  const nodesFor = (times) => fc.nodes.map((nd, i) => {
    const v = {};
    for (const key of ["T", "RH", "P", "U", "dir", "ghi", "dirH", "difH", "cc"]) v[key] = times.map((t) => fc.vars[key][i][t - fc.t0] ?? null);
    let z = nd.zCell;
    if (NODES === "dem" && ok(nd.zDem) && ok(nd.zCell)) { const dT = -0.0065 * (nd.zDem - nd.zCell); v.T = v.T.map((x) => (ok(x) ? x + dT : x)); z = nd.zDem; }
    return { id: nd.id, lat: nd.lat, lon: nd.lon, z, v };
  }).filter((n) => ok(n.z));
  const stationsFor = (times, tA) => STATIONS.map((s) => {
    const byT = new Map((obsAll[s.id] || []).map((r) => [r.t, r]));
    const o = { T: [], RH: [], U: [], HS: [], P: [] };
    for (const t of times) { const r = t <= tA ? byT.get(t) : null; for (const k of Object.keys(o)) o[k].push(r ? r[k] : null); }
    return { ...s, o };
  });
  const truth = Object.fromEntries(STATIONS.map((s) => [s.id, new Map((obsAll[s.id] || []).map((r) => [r.t, r]))]));

  // ---- analysis, leave one out ----
  const times = [];
  for (let t = t0 - 30; t <= t1; t++) times.push(t);
  const nodes = nodesFor(times);
  const all = stationsFor(times, t1);
  const rows = [];
  for (const s of STATIONS) {
    if (![...truth[s.id].values()].some((r) => ok(r.T) && r.t >= t0 && r.t <= t1)) continue;
    const F = prepareForcing({ times, nodes, stations: all.filter((x) => x.id !== s.id), tA: t1, windows: [] });
    const W = F.weightsFor(s);
    const e = [], eRH = [];
    for (let k = 30; k < times.length; k++) {
      const r = truth[s.id].get(times[k]);
      if (!r) continue;
      const f = F.at(W, k);
      if (ok(r.T)) e.push(f.Ta - r.T);
      if (ok(r.RH)) eRH.push(f.RH - r.RH);
    }
    rows.push({ s, n: e.length, bias: mean(e), mae: mean(e.map(Math.abs)), biasRH: mean(eRH), maeRH: mean(eRH.map(Math.abs)) });
  }
  console.log(`\n## ${season}, analysis with each station withheld (Dec–Mar), ${NODES} nodes, code ${CODE}`);
  console.log("| Station | z | T bias | T MAE | RH bias | RH MAE |\n|---|---|---|---|---|---|");
  for (const r of rows.sort((a, b) => a.s.z - b.s.z)) console.log(`| ${r.s.name} | ${r.s.z} | ${f1(r.bias)} | ${f1(r.mae)} | ${f1(r.biasRH)} | ${f1(r.maeRH)} |`);
  console.log(`| **All** | | ${f1(mean(rows.map((r) => r.bias)))} | ${f1(mean(rows.map((r) => r.mae)))} | ${f1(mean(rows.filter((r) => Number.isFinite(r.biasRH)).map((r) => r.biasRH)))} | ${f1(mean(rows.filter((r) => Number.isFinite(r.maeRH)).map((r) => r.maeRH)))} |`);

  // ---- forecast ----
  const leads = [[1, 6], [7, 12], [13, 24], [25, 48]];
  const errs = leads.map(() => ({ T: [], RH: [] }));
  let bias = null, prev = null;
  for (let tI = t0 + 12; tI + 48 <= t1; tI += 72) {
    const from = prev === null ? tI - 30 * 24 : prev - 30;
    const tm = [];
    for (let t = from; t <= tI + 48; t++) tm.push(t);
    const F = prepareForcing({ times: tm, nodes: nodesFor(tm), stations: stationsFor(tm, tI), tA: tI, windows: [], bias, biasFrom: prev === null ? 0 : prev - from + 1 });
    bias = F.bias || null; prev = tI;
    for (const s of STATIONS) {
      const W = F.weightsFor(s);
      for (let h = 1; h <= 48; h++) {
        const r = truth[s.id].get(tI + h);
        if (!r) continue;
        const f = F.at(W, tI + h - from);
        const li = leads.findIndex(([a, b]) => h >= a && h <= b);
        if (ok(r.T)) errs[li].T.push(f.Ta - r.T);
        if (ok(r.RH)) errs[li].RH.push(f.RH - r.RH);
      }
    }
  }
  console.log(`\n## ${season}, forecast at the stations (Dec–Mar, every 3rd day from 12 UTC)`);
  console.log("| Lead h | T bias | T MAE | RH bias | RH MAE |\n|---|---|---|---|---|");
  leads.forEach(([a, b], i) => console.log(`| ${a}–${b} | ${f1(mean(errs[i].T))} | ${f1(mean(errs[i].T.map(Math.abs)))} | ${f1(mean(errs[i].RH))} | ${f1(mean(errs[i].RH.map(Math.abs)))} |`));
}
