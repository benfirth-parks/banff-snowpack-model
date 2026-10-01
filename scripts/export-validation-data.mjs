// Exports the model's past-season point profiles and the station archive so that
// validation against field profiles can run offline. Run by
// .github/workflows/export-validation-data.yml, which commits the output to the
// `validation-data` branch (the Netlify sites aren't reachable from every
// environment, and their responses are too large to read piecemeal).
//
// Output (all JSON, gzip-compressed except README/summary):
//   model/points.json                       point list from /api/meta
//   model/{season}/{pointId}.json.gz        daily 17:00 profiles for that point
//   stations/{stationId}.json.gz            hourly station archive, column-oriented
//   summary.json                            what was exported, row counts, sizes
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { STATIONS } from "../src/model/domain.js";

const SITE = process.env.SITE || "https://banff-snowpack-model.netlify.app";
const EXPLORER = process.env.EXPLORER || "https://rockiesweatherdataexplorer.netlify.app";
const OUT = process.env.OUT || "out";
const SEASONS = (process.env.SEASONS || "2023-24,2024-25,2025-26").split(",").map((s) => s.trim()).filter(Boolean);
// The explorer keeps a rolling 3-year hourly archive; asking for more than that
// returns thinned (multi-hour) records, so stay at or under it.
const STATION_HOURS = Number(process.env.STATION_HOURS || 26298);

const UA = { "user-agent": "banff-snowpack-model validation export (GitHub Actions)" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, tries = 4) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: UA });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
      return await res.json();
    } catch (e) {
      err = e;
      await sleep(3000 * (i + 1));
    }
  }
  throw new Error(`${url}: ${err.message}`);
}

function write(path, obj, gz = true) {
  mkdirSync(dirname(path), { recursive: true });
  const raw = Buffer.from(gz ? JSON.stringify(obj) : JSON.stringify(obj, null, 1));
  const buf = gz ? gzipSync(raw, { level: 9 }) : raw;
  writeFileSync(path, buf);
  return buf.length;
}

const fileId = (id) => id.replace(/[^a-z0-9_-]/gi, "_");
const summary = { exportedAt: new Date().toISOString(), site: SITE, explorer: EXPLORER, seasons: SEASONS, stationHours: STATION_HOURS, model: {}, stations: {}, bytes: { model: 0, stations: 0 } };

// ---- Model point profiles -------------------------------------------------
const meta = await getJSON(`${SITE}/.netlify/functions/meta`);
if (!meta || !Array.isArray(meta.points)) throw new Error("model meta unavailable");
write(`${OUT}/model/points.json`, meta.points, false);
for (const season of SEASONS) {
  summary.model[season] = {};
  for (const p of meta.points) {
    const r = await getJSON(`${SITE}/.netlify/functions/point?id=${encodeURIComponent(p.id)}&season=${season}`);
    const days = (r?.days || []).map((d) => ({ date: d.date, t: d.t, hs: d.hs, A: d.A, W: d.W, p: d.p, obsHS: d.obsHS ?? null, text: d.text }));
    summary.bytes.model += write(`${OUT}/model/${season}/${fileId(p.id)}.json.gz`, { id: p.id, season, point: p, days });
    summary.model[season][p.id] = days.length;
    await sleep(150);
  }
  console.log(`model ${season}: ${meta.points.length} points, ${(summary.bytes.model / 1e6).toFixed(1)} MB so far`);
}

// ---- Station archive --------------------------------------------------------
for (const s of STATIONS) {
  const rows = (await getJSON(`${EXPLORER}/api/fts?station=${encodeURIComponent(s.id)}&hours=${STATION_HOURS}`)) || [];
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const columns = Object.fromEntries(keys.map((k) => [k, rows.map((r) => (r[k] === undefined ? null : r[k]))]));
  summary.bytes.stations += write(`${OUT}/stations/${s.id}.json.gz`, { id: s.id, name: s.name, lat: s.lat, lon: s.lon, z: s.z, hours: STATION_HOURS, n: rows.length, columns });
  summary.stations[s.id] = { n: rows.length, first: rows[0]?.measurementDateTime ?? null, last: rows[rows.length - 1]?.measurementDateTime ?? null, fields: keys };
  console.log(`station ${s.id}: ${rows.length} rows`);
  await sleep(500);
}

write(`${OUT}/summary.json`, summary, false);
writeFileSync(`${OUT}/README.md`, [
  "# Validation data export",
  "",
  `Exported ${summary.exportedAt} by \`scripts/export-validation-data.mjs\` (workflow \`export-validation-data\` on main).`,
  "This branch is replaced on every export.",
  "",
  "- `model/points.json`: the model's points (named points × ALP/TL/BTL, and stations).",
  "- `model/{season}/{pointId}.json.gz`: daily 17:00 profiles from the past-season reanalysis. `A[aspect]` is the profile for flat, N, E, S, W:",
  "  6 integers per layer, top-down: top depth (cm×10), grain class index (PP, DF, RG, FCxr, FC, DH, SH, MF, MFcr), hand hardness×10, T×10 (°C), grain size×10 (mm), density (kg/m³).",
  "- `stations/{stationId}.json.gz`: hourly station archive from the Rockies Weather Data Explorer, column-oriented.",
  "- `summary.json`: row counts and sizes.",
  "",
].join("\n"));
console.log(`done: model ${(summary.bytes.model / 1e6).toFixed(1)} MB, stations ${(summary.bytes.stations / 1e6).toFixed(1)} MB`);
