// Scores the model's snow height at the snow-height stations against the
// sensors, by part of the season, and the spring melt-out date.
//
//   node validation/station-hs.mjs --model <dir> [--label v5] [--out <dir>]
//
// <dir> is a replay or export (points.json + {season}/{stationId}.json.gz with
// daily obsHS). Uses the flat column at the station's own point at 17:00 local.
// At the snow-height stations the model's snowfall follows the sensor, so the
// early-season and spring errors mostly test the energy balance: ground heat,
// albedo, rain and melt.
//   Early: 1 Oct – 30 Nov. Winter: Dec – Mar. Spring: 1 Apr – 30 Jun.
//   Melt-out: the first day after 1 March from which snow height stays under
//   5 cm to 15 July, for the sensor (its valid readings) and the model alike.
//   The sensors often have gaps after melt-out, so needing readings in the
//   following days would date melt-out to when data resume.
// Sensor readings more than 25 cm off the median of the 7 days around them are
// skipped as faults.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const MODEL = args.model, OUT = args.out || join(HERE, "report"), LABEL = args.label || "model";
if (!MODEL) { console.error("--model <dir> required"); process.exit(1); }
const ok = (v) => v !== null && v !== undefined && Number.isFinite(v);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const r0 = (x) => (Number.isFinite(x) ? Math.round(x).toString() : "–");
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

const points = JSON.parse(readFileSync(join(MODEL, "points.json"), "utf8")).filter((p) => p.kind === "station");
const PERIODS = [["Early (Oct–Nov)", (m) => m === 10 || m === 11], ["Winter (Dec–Mar)", (m) => m === 12 || m <= 3], ["Spring (Apr–Jun)", (m) => m >= 4 && m <= 6]];
const dayNum = (date) => Date.parse(`${date}T00:00:00Z`) / 864e5;

const rows = [], all = PERIODS.map(() => ({ e: [], n: 0 })), melt = [];
for (const season of ["2023-24", "2024-25", "2025-26"]) {
  for (const p of points) {
    const f = join(MODEL, season, `${p.id.replace(":", "_")}.json.gz`);
    if (!existsSync(f)) continue;
    const days = JSON.parse(gunzipSync(readFileSync(f))).days;
    const obs = days.map((d) => (ok(d.obsHS) ? d.obsHS : null));
    if (obs.filter(ok).length < 60) continue; // not a snow-height station
    const clean = obs.map((v, i) => {
      if (!ok(v)) return null;
      const w = obs.slice(Math.max(0, i - 3), i + 4).filter(ok);
      return Math.abs(v - median(w)) > 25 ? null : v;
    });
    const per = PERIODS.map(() => []);
    days.forEach((d, i) => {
      if (!ok(clean[i]) || !d.hs) return;
      const m = +d.date.slice(5, 7);
      PERIODS.forEach(([, sel], j) => { if (sel(m)) per[j].push(d.hs[0] - clean[i]); });
    });
    per.forEach((e, j) => all[j].e.push(...e));
    // Melt-out after 1 March.
    const y1 = String(+season.slice(0, 4) + 1);
    const idx = days.map((d, i) => [d, i]).filter(([d]) => d.date >= `${y1}-03-01` && d.date <= `${y1}-07-15`);
    let mo = null, mm = null;
    for (const [d, i] of idx) {
      if (mo === null && ok(clean[i]) && clean[i] < 5 && idx.filter(([e]) => e.date >= d.date).every(([, j]) => !ok(clean[j]) || clean[j] < 5)) mo = d.date;
      if (mm === null && d.hs[0] < 5 && idx.filter(([e]) => e.date >= d.date).every(([e]) => e.hs[0] < 5)) mm = d.date;
    }
    if (mo && mm) melt.push(dayNum(mm) - dayNum(mo));
    rows.push(`| ${p.name} | ${season} | ${per.map((e) => (e.length >= 5 ? `${r0(mean(e))} / ${r0(mean(e.map(Math.abs)))}` : "–")).join(" | ")} | ${mo ?? "–"} | ${mm ?? "–"} |`);
  }
}
const md = [
  `# Station snow height: ${LABEL}`,
  "",
  "Model (flat column at the station's point) minus the sensor, cm, as bias / mean abs. Melt-out dates are the sensor's and the model's.",
  "",
  "| Station | Season | Early (Oct–Nov) | Winter (Dec–Mar) | Spring (Apr–Jun) | Melt-out, sensor | Melt-out, model |",
  "|---|---|---|---|---|---|---|",
  ...rows,
  `| **All** | | ${all.map(({ e }) => `${r0(mean(e))} / ${r0(mean(e.map(Math.abs)))}`).join(" | ")} | model − sensor: mean ${r0(mean(melt))} d, mean abs ${r0(mean(melt.map(Math.abs)))} d (n ${melt.length}) | |`,
  "",
].join("\n");
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, `${LABEL}-station-hs.md`), md);
console.log(md);
