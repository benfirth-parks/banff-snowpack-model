// Scores the model's avalanche problem indices against the problems in past
// public avalanche bulletins for Banff, Yoho and Kootenay.
//
//   node validation/bulletins.mjs --model <dir> --bulletins <csv> [--label v5]
//        [--out <dir>] [--lag 0] [--share 0.2]
//
// <dir> is a replay or export (points.json + {season}/{pointId}.json.gz).
// <csv> has one row per problem per bulletin, and a row with problem "none" for a
// bulletin that lists no problems, so every bulletin date is known:
//
//   date,problem,elevations,aspects
//   2025-01-15,wind,alp tl,n ne e
//   2025-01-15,persistent,alp tl btl,n ne e se s sw w nw
//   2025-01-16,none,,
//
// date: the day the bulletin is valid for. problem: storm, wind, persistent,
// deep (deep persistent), wet (wet slab or wet loose); anything else is ignored.
// elevations: alp, tl, btl. aspects: n ne e se s sw w nw.
//
// Model side: the named points (ALP / TL / BTL) on the date's 17:00 snapshot,
// `--lag` days before the valid date (0 = same day). A problem is on in a band
// when at least `--share` of the named points have its index at 50 % or more on
// any of the four slopes. Indices: storm → new snow, wind → wind slab,
// persistent and deep → persistent weak layer, wet → wet.
// The model's indices are not danger ratings and this compares presence only.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const MODEL = args.model, CSV = args.bulletins;
const OUT = args.out || join(HERE, "report");
const LABEL = args.label || "model";
const LAG = Number(args.lag ?? 0), SHARE = Number(args.share ?? 0.2);
if (!MODEL || !CSV) { console.error("--model <dir> and --bulletins <csv> are required"); process.exit(1); }

const PROBLEMS = ["storm", "wind", "persistent", "wet"];
const INDEX = { storm: 1, wind: 2, persistent: 3, wet: 4 }; // position in a day's p[aspect]
const ALIAS = { storm: "storm", wind: "wind", persistent: "persistent", deep: "persistent", deeppersistent: "persistent", wet: "wet", wetslab: "wet", wetloose: "wet" };
const BANDS = ["ALP", "TL", "BTL"];
const BAND_OF = { alp: "ALP", tl: "TL", tln: "TL", btl: "BTL" };
// Bulletin aspect → the model's four slopes it leans on (N, E, S, W = 1–4).
const ASPECT_SLOPES = { n: [1], ne: [1, 2], e: [2], se: [2, 3], s: [3], sw: [3, 4], w: [4], nw: [4, 1] };
const SLOPE = ["", "N", "E", "S", "W"];

// ---- bulletins ---------------------------------------------------------------
const bull = new Map(); // date → { problem → { bands:Set, slopes:Set } }
const lines = readFileSync(CSV, "utf8").split(/\r?\n/).filter((l) => l.trim() && !/^date\s*,/i.test(l));
let ignored = 0;
for (const l of lines) {
  const [date, prob = "", elev = "", asp = ""] = l.split(",").map((x) => x.trim());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
  const d = bull.get(date) || bull.set(date, {}).get(date);
  const p = ALIAS[prob.toLowerCase().replace(/[^a-z]/g, "")];
  if (!p) { if (prob.toLowerCase() !== "none") ignored++; continue; }
  const e = d[p] || (d[p] = { bands: new Set(), slopes: new Set() });
  for (const b of elev.toLowerCase().split(/\s+/)) if (BAND_OF[b]) e.bands.add(BAND_OF[b]);
  for (const a of asp.toLowerCase().split(/\s+/)) for (const s of ASPECT_SLOPES[a] || []) e.slopes.add(s);
}

// ---- model --------------------------------------------------------------------
const points = JSON.parse(readFileSync(join(MODEL, "points.json"), "utf8")).filter((p) => p.kind === "named");
const shift = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
const byDate = new Map(); // date → band → [{ p: [[...5] × 5 aspects] }]
for (const season of ["2023-24", "2024-25", "2025-26"]) {
  for (const pt of points) {
    const f = join(MODEL, season, `${pt.id.replace(":", "_")}.json.gz`);
    if (!existsSync(f)) continue;
    for (const day of JSON.parse(gunzipSync(readFileSync(f))).days) {
      const m = byDate.get(day.date) || byDate.set(day.date, {}).get(day.date);
      (m[pt.band] || (m[pt.band] = [])).push(day.p);
    }
  }
}
// Share of points with the problem on, per band; and the slopes it is on.
function modelBand(date, band, prob) {
  const ps = byDate.get(shift(date, -LAG))?.[band];
  if (!ps || !ps.length) return null;
  let on = 0;
  const slopes = new Set();
  for (const p of ps) {
    let any = false;
    for (let s = 1; s <= 4; s++) if (p[s] && p[s][INDEX[prob]] >= 50) { any = true; slopes.add(s); }
    if (any) on++;
  }
  return { share: on / ps.length, slopes };
}

// ---- scores -------------------------------------------------------------------
const r1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "–");
const pct = (a, b) => (b ? r1((100 * a) / b) : "–");
const heidke = (a, b, c, d) => { const n = a + b + c + d, e = ((a + b) * (a + c) + (c + d) * (b + d)) / n; return n && n !== e ? (a + d - e) / (n - e) : NaN; };
const rows = [], aspectRows = [];
const dates = [...bull.keys()].filter((d) => byDate.has(shift(d, -LAG))).sort();
for (const prob of PROBLEMS) {
  for (const band of BANDS) {
    let a = 0, b = 0, c = 0, d = 0; // hit, false alarm, miss, correct none
    let jac = 0, nj = 0;
    for (const date of dates) {
      const m = modelBand(date, band, prob);
      if (!m) continue;
      const o = bull.get(date)[prob]?.bands.has(band) || false;
      const f = m.share >= SHARE;
      if (f && o) a++; else if (f) b++; else if (o) c++; else d++;
      if (f && o && bull.get(date)[prob].slopes.size) {
        const os = bull.get(date)[prob].slopes, ms = m.slopes;
        const inter = [...ms].filter((s) => os.has(s)).length, uni = new Set([...ms, ...os]).size;
        jac += inter / uni; nj++;
      }
    }
    const n = a + b + c + d;
    rows.push(`| ${prob} | ${band} | ${n} | ${pct(a + c, n)} | ${pct(a + b, n)} | ${pct(a, a + c)} | ${pct(b, a + b)} | ${r1(heidke(a, b, c, d))} |`);
    if (prob === "wind" && nj) aspectRows.push(`| ${band} | ${nj} | ${r1(jac / nj)} |`);
  }
}
// Which slopes the bulletins load with wind slabs, against the model.
const windSlopes = (src) => {
  const cnt = [0, 0, 0, 0, 0];
  let n = 0;
  for (const date of dates) {
    if (src === "bulletin") { const e = bull.get(date).wind; if (e && e.bands.has("ALP")) { n++; for (const s of e.slopes) cnt[s]++; } }
    else { const m = modelBand(date, "ALP", "wind"); if (m && m.share >= SHARE) { n++; for (const s of m.slopes) cnt[s]++; } }
  }
  return SLOPE.slice(1).map((s, i) => `${s} ${pct(cnt[i + 1], n)}`).join(", ") + ` (n ${n})`;
};

const md = [
  `# Avalanche problems: ${LABEL} vs the BYK bulletins`,
  "",
  `${dates.length} bulletin dates (${dates[0] ?? "–"} to ${dates[dates.length - 1] ?? "–"}) with a model snapshot ${LAG ? `${LAG} day(s) before` : "on"} the valid date. A model problem is on in a band when at least ${Math.round(SHARE * 100)} % of the named points have its index at 50 % or more on any slope.${ignored ? ` ${ignored} bulletin rows with other problem types were ignored.` : ""}`,
  "",
  "| Problem | Band | Days | Bulletin has it % | Model has it % | Bulletin days the model caught % | Model days the bulletin didn't list % | Heidke skill |",
  "|---|---|---|---|---|---|---|---|",
  ...rows,
  "",
  "Heidke skill: 1 is perfect, 0 is no better than chance.",
  "",
  "## Wind slab aspects",
  `Share of ALP wind slab days that load each of the model's slopes. Bulletin: ${windSlopes("bulletin")}. Model: ${windSlopes("model")}.`,
  "",
  ...(aspectRows.length ? ["Overlap of the loaded slopes (intersection over union) on days both have a wind slab:", "", "| Band | Days | Mean overlap |", "|---|---|---|", ...aspectRows] : []),
  "",
].join("\n");
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, `${LABEL}-bulletins.md`), md);
console.log(md);
