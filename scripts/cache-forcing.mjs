// Caches the archived forecast-model forcing for past seasons so model changes
// can be replayed and scored locally without calling Open-Meteo again. Run by
// .github/workflows/cache-forcing.yml, which commits the output to the
// `forcing-cache` branch.
//
// HRDPS is requested with elevation=nan (raw grid-cell values and grid-cell
// heights, no Open-Meteo downscaling). Each node's 90 m DEM height is stored too,
// so the old downscaled temperature can be rebuilt with Open-Meteo's 0.65 °C/100 m
// for comparisons with earlier model versions. RDPS fills columns HRDPS lacks.
//
// Output: forcing/{season}.json.gz =
//   { season, t0 (epoch hour), n, nodes: [{ id, lat, lon, zCell, zDem }],
//     vars: { T: [[...node 0...], [...node 1...]], RH, P, U, dir, ghi, dirH, difH, cc, snowfall } }
import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { modelNodes } from "../src/model/domain.js";

const OUT = process.env.OUT || "out";
const HIST = "https://historical-forecast-api.open-meteo.com/v1/forecast";
const ELEV = "https://api.open-meteo.com/v1/elevation";
const SEASONS = {
  "2023-24": ["2023-08-30", "2024-06-30"],
  "2024-25": ["2024-08-30", "2025-06-30"],
  "2025-26": ["2025-08-30", "2026-06-30"],
};
const wanted = (process.env.SEASONS || Object.keys(SEASONS).join(",")).split(",").map((s) => s.trim()).filter((s) => SEASONS[s]);
const VARS = [
  ["T", "temperature_2m", 10], ["RH", "relative_humidity_2m", 1], ["P", "precipitation", 100],
  ["U", "wind_speed_10m", 10], ["dir", "wind_direction_10m", 1], ["ghi", "shortwave_radiation", 1],
  ["dirH", "direct_radiation", 1], ["difH", "diffuse_radiation", 1], ["cc", "cloud_cover", 1], ["snowfall", "snowfall", 100],
];
const HRDPS = "gem_hrdps_continental", RDPS = "gem_regional";
const CHUNK_NODES = 20, CHUNK_DAYS = 31;
const PACE_MS = Number(process.env.PACE_MS || 40000); // ~44 weighted calls per request → ~66/min (~4000/h), inside the free tier's 5000/h

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (v) => v !== null && v !== undefined && Number.isFinite(v);
const UA = { "user-agent": "banff-snowpack-model forcing cache (GitHub Actions)" };

async function getJSON(url) {
  for (let i = 0; ; i++) {
    const res = await fetch(url, { headers: UA });
    const text = await res.text();
    if (res.ok) return JSON.parse(text);
    if (res.status === 429 && i < 12) {
      const wait = /hour/i.test(text) ? 10 * 60000 : /day/i.test(text) ? 60 * 60000 : 70000;
      console.log(`429 (${text.slice(0, 80)}), waiting ${wait / 60000} min`);
      await sleep(wait);
      continue;
    }
    if (res.status >= 500 && i < 4) { await sleep(20000 * (i + 1)); continue; }
    throw new Error(`${res.status} ${text.slice(0, 200)}`);
  }
}

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

const nodes = modelNodes();
// DEM heights (the elevation Open-Meteo downscales to by default).
const zDem = [];
for (const c of chunks(nodes, 100)) {
  const q = new URLSearchParams({ latitude: c.map((n) => n.lat).join(","), longitude: c.map((n) => n.lon).join(",") });
  zDem.push(...(await getJSON(`${ELEV}?${q}`)).elevation);
}

function query(chunk, models, a, b) {
  const p = new URLSearchParams();
  p.set("latitude", chunk.map((n) => n.lat).join(","));
  p.set("longitude", chunk.map((n) => n.lon).join(","));
  p.set("hourly", VARS.map((v) => v[1]).join(","));
  p.set("models", models.join(","));
  p.set("start_date", a); p.set("end_date", b);
  p.set("elevation", "nan");
  p.set("timeformat", "unixtime"); p.set("timezone", "GMT");
  return `${HIST}?${p}`;
}

for (const season of wanted) {
  const [a0, b0] = SEASONS[season];
  const today = iso(Date.now() - 86400000);
  const b = b0 < today ? b0 : today;
  const t0 = Date.parse(a0 + "T00:00:00Z") / 3600000;
  const t1 = Date.parse(b + "T23:00:00Z") / 3600000;
  const n = t1 - t0 + 1;
  const vars = Object.fromEntries(VARS.map(([k]) => [k, nodes.map(() => new Array(n).fill(null))]));
  const zCell = nodes.map(() => null);
  const fill = (models, idxs) => async (chunk, ca, cb) => {
    const data = await getJSON(query(chunk.map((i) => nodes[i]), models, ca, cb));
    const list = Array.isArray(data) ? data : [data];
    chunk.forEach((ni, j) => {
      const d = list[j];
      if (!d?.hourly) return;
      if (zCell[ni] === null && ok(d.elevation)) zCell[ni] = d.elevation;
      const times = d.hourly.time.map((s) => Math.round(s / 3600));
      for (const [k, name, scale] of VARS) {
        const cols = models.map((m) => d.hourly[`${name}_${m}`] || []);
        const plain = d.hourly[name] || [];
        times.forEach((t, h) => {
          const kk = t - t0;
          if (kk < 0 || kk >= n || ok(vars[k][ni][kk])) return;
          let v = null;
          for (const c of cols) if (ok(c[h])) { v = c[h]; break; }
          if (v === null && ok(plain[h])) v = plain[h];
          if (v !== null) vars[k][ni][kk] = Math.round(v * scale) / scale;
        });
      }
    });
  };
  const months = [];
  for (let s = Date.parse(a0 + "T00:00:00Z"); iso(s) <= b; s += CHUNK_DAYS * 86400000) {
    const e = Math.min(s + (CHUNK_DAYS - 1) * 86400000, Date.parse(b + "T00:00:00Z"));
    months.push([iso(s), iso(e)]);
  }
  const all = nodes.map((_, i) => i);
  const hr = fill([HRDPS], all);
  for (const [ca, cb] of months) {
    for (const c of chunks(all, CHUNK_NODES)) {
      await hr(c, ca, cb);
      await sleep(PACE_MS);
    }
    console.log(`${season} HRDPS ${ca}..${cb} done`);
  }
  // RDPS fills nodes/hours that HRDPS lacks (e.g. outages).
  const gappy = all.filter((i) => vars.T[i].filter((x) => x === null).length > n * 0.01);
  if (gappy.length) {
    const rd = fill([HRDPS, RDPS], gappy);
    for (const [ca, cb] of months) for (const c of chunks(gappy, CHUNK_NODES)) { await rd(c, ca, cb); await sleep(PACE_MS); }
    console.log(`${season}: RDPS gap-fill for ${gappy.length} nodes`);
  }
  const missing = Math.round(1000 * vars.T.flat().filter((x) => x === null).length / (n * nodes.length)) / 10;
  const out = { season, t0, n, models: [HRDPS, RDPS], elevation: "grid cell (elevation=nan)", missingT_pct: missing,
    nodes: nodes.map((nd, i) => ({ id: nd.id, lat: nd.lat, lon: nd.lon, zCell: zCell[i], zDem: zDem[i] })), vars };
  mkdirSync(`${OUT}/forcing`, { recursive: true });
  const buf = gzipSync(Buffer.from(JSON.stringify(out)), { level: 9 });
  writeFileSync(`${OUT}/forcing/${season}.json.gz`, buf);
  console.log(`${season}: ${nodes.length} nodes × ${n} h, missing T ${missing} %, ${(buf.length / 1e6).toFixed(1)} MB`);
}
writeFileSync(`${OUT}/README.md`, `# Forcing cache\n\nArchived HRDPS (RDPS gap-fill) forcing at the model's ${nodes.length} nodes, written ${new Date().toISOString()} by \`scripts/cache-forcing.mjs\`. Raw grid-cell values (\`elevation=nan\`); \`zDem\` lets you rebuild Open-Meteo's default downscaled temperature (0.65 °C/100 m). Replaced on every run.\n`);
