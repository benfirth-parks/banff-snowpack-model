// Scores simulated profiles against the field profiles transcribed in
// validation/observed/{season}/*.json (see validation/TRANSCRIBE.md).
//
//   node validation/compare.mjs --model <dir> [--out <dir>] [--label v2]
//
// <dir> holds {season}/{pointId}.json.gz and points.json in the layout written by
// scripts/export-validation-data.mjs (the validation-data branch) or by a local
// replay. Writes <out>/{label}-profiles.json (per-profile scores) and
// <out>/{label}-summary.md.
//
// Matching
//   Study plots use fixed model points: Bow Summit → fts-bowsummit, Goat's Eye →
//   fts-sunshine, Simpson → fts-simplo, Takakkaw Falls → emerald-pk BTL (the
//   nearest point near its elevation). Test profiles use the point that
//   minimises horizontal km + |Δz|/100 m, and the virtual slope for their aspect
//   (N for N/NE/NW, S for S/SE/SW, E, W; flat below 10°).
// Scores (all on the observed range only, so partial pits are fair)
//   HS error; grain-group agreement and hand-hardness error on a relative-height
//   grid; detection of basal persistent grains, crusts and buried surface hoar;
//   whether the model flags a weak layer at each observed test failure;
//   snow temperature error below 20 cm depth.
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { kmBetween } from "../src/model/domain.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const MODEL = args.model;
const OUT = args.out || join(HERE, "report");
const LABEL = args.label || "model";
if (!MODEL) { console.error("--model <dir> required"); process.exit(1); }

const CLASSES = ["PP", "DF", "RG", "FCxr", "FC", "DH", "SH", "MF", "MFcr"];
const GROUPS = ["PP/DF", "RG/FCxr", "SH/DH/FC", "MFcr", "MF"];
const GROUP_OF = [0, 0, 1, 1, 2, 2, 2, 4, 3];
const ASPECT_INDEX = { flat: 0, N: 1, E: 2, S: 3, W: 4 };
const ok = (v) => v !== null && v !== undefined && Number.isFinite(v);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const r1 = (x) => (ok(x) ? Math.round(x * 10) / 10 : null);

const PLOTS = {
  "bow-summit-plot": { point: "fts-bowsummit", lat: 51.7094, lon: -116.479, z: 2035 },
  "goats-eye-plot": { point: "fts-sunshine", lat: 51.0895, lon: -115.7553, z: 2280 },
  "simpson-plot": { point: "fts-simplo", lat: 50.985, lon: -115.984, z: 2105 },
  "tak-falls-plot": { point: "emerald-pk:BTL", lat: 51.4985, lon: -116.4962, z: 1790 },
};
// Places whose profiles carry no usable coordinates (blank, or the Banff-townsite
// default some exports fall back to).
const GAZETTEER = [
  [/wawa/, { lat: 51.087, lon: -115.8 }], [/ssv|sunshine/, { lat: 51.078, lon: -115.782 }],
  [/wolverine/, { lat: 51.4356, lon: -116.0863 }], [/mt-field|mount-field/, { lat: 51.439, lon: -116.457 }],
  [/jj-bowl|jimmy-junior/, { lat: 51.694, lon: -116.49 }], [/west-nile/, { lat: 51.62, lon: -116.35 }],
];
const badCoords = (p) => !ok(p.lat) || !ok(p.lon) || (Math.abs(p.lat - 51.1908) < 0.002 && Math.abs(p.lon + 115.5602) < 0.002);

// ---- observed -------------------------------------------------------------------
function obsGroup(l) {
  const g = (l.grain || "").replace(/\s/g, "").toUpperCase();
  if (!g) return null;
  if (/^(PP|DF|GP|RIME)/.test(g)) return 0;
  if (g.startsWith("MFCR") || g.startsWith("IF")) return 3;
  if (g.startsWith("MF")) return ok(l.hardness_idx) && l.hardness_idx >= 4 ? 3 : 4;
  if (g.startsWith("FCXR") || g.startsWith("RG")) return 1;
  if (g.startsWith("FC") || g.startsWith("DH") || g.startsWith("SH")) return 2;
  return null;
}
const obsPersistent = (l) => /^(FC|DH)/i.test(l.grain || "");       // FC, FCxr, FCso, DH, DHxr
const obsSH = (l) => /^SH/i.test(l.grain || "");
const obsCrust = (l) => {
  const g = (l.grain || "").toUpperCase();
  if (g.startsWith("MFCR") || g.startsWith("IF")) return true;
  if (g.startsWith("MF") && ok(l.hardness_idx) && l.hardness_idx >= 4) return true;
  return !g && ok(l.hardness_idx) && l.hardness_idx >= 4.67 && ok(l.top_cm) && ok(l.bottom_cm) && l.top_cm - l.bottom_cm <= 5;
};

function loadObserved() {
  const out = [];
  const root = join(HERE, "observed");
  for (const season of readdirSync(root).filter((s) => /^\d{4}-\d{2}$/.test(s)).sort()) {
    for (const f of readdirSync(join(root, season)).filter((x) => x.endsWith(".json")).sort()) {
      const d = JSON.parse(readFileSync(join(root, season, f), "utf8"));
      if (d.not_a_profile || !ok(d.hs_cm) || !(d.layers || []).length) continue;
      out.push({ ...d, file: `${season}/${f}` });
    }
  }
  return out;
}

// ---- model ----------------------------------------------------------------------
const cache = new Map();
function modelDays(season, id) {
  const key = `${season}/${id}`;
  if (!cache.has(key)) {
    const f = join(MODEL, season, `${id.replace(/[^a-z0-9_-]/gi, "_")}.json.gz`);
    cache.set(key, existsSync(f) ? new Map(JSON.parse(gunzipSync(readFileSync(f))).days.map((d) => [d.date, d])) : null);
  }
  return cache.get(key);
}
function decodeModel(day, asp) {
  const a = day?.A?.[asp];
  if (!a || !a.length) return null;
  const hs = day.hs[asp];
  const L = [];
  for (let j = 0; j < a.length; j += 6) {
    const dTop = a[j] / 10, dBot = j + 6 < a.length ? a[j + 6] / 10 : hs;
    L.push({ hTop: hs - dTop, hBot: hs - Math.max(dBot, dTop), cls: a[j + 1], h: a[j + 2] / 10, T: a[j + 3] / 10, gs: a[j + 4] / 10, rho: a[j + 5] });
  }
  return { hs, L, W: (day.W?.[asp] || []).map(([depth, cls, burial, p, lemons]) => ({ depth, cls, burial, p, lemons })) };
}
const points = JSON.parse(readFileSync(join(MODEL, "points.json"), "utf8"));
const pointById = new Map(points.map((p) => [p.id, p]));

function aspectSim(o) {
  const a = (o.aspect || "").toUpperCase();
  const slope = ok(o.slope_deg) ? o.slope_deg : null;
  if (o.kind === "study_plot" || a === "FLAT" || (slope !== null && slope < 10) || !a) return "flat";
  if (["N", "NE", "NW", "NNE", "NNW"].includes(a)) return "N";
  if (["S", "SE", "SW", "SSE", "SSW"].includes(a)) return "S";
  if (["E", "ENE", "ESE"].includes(a)) return "E";
  if (["W", "WNW", "WSW"].includes(a)) return "W";
  return "flat";
}

function matchPoint(o) {
  const plot = PLOTS[o.site_slug];
  if (plot) return { id: plot.point, loc: plot, how: "study plot" };
  let loc = { lat: o.lat, lon: o.lon };
  let how = "coordinates";
  if (badCoords(o)) {
    const g = GAZETTEER.find(([re]) => re.test(o.site_slug || ""));
    if (!g) return null;
    loc = g[1]; how = "gazetteer";
  }
  const z = ok(o.elevation_m) && !(o.elevation_m < 1450 && badCoords(o)) ? o.elevation_m : null;
  let best = null;
  for (const p of points) {
    const km = kmBetween(loc, p);
    const score = km + (z === null ? 0 : Math.abs(p.z - z) / 100);
    if (!best || score < best.score) best = { id: p.id, score, km, dz: z === null ? null : p.z - z };
  }
  return { id: best.id, loc: { ...loc, z }, how, km: r1(best.km), dz: best.dz };
}

// ---- scoring --------------------------------------------------------------------
function score(o) {
  const m = matchPoint(o);
  if (!m) return { file: o.file, skipped: "no usable location" };
  const days = modelDays(o.season, m.id);
  const day = days?.get(o.date);
  const aspName = aspectSim(o);
  const M = day && decodeModel(day, ASPECT_INDEX[aspName]);
  if (!M) return { file: o.file, skipped: `no model day ${o.date} at ${m.id}` };
  const HS = o.hs_cm;
  const L = o.layers.filter((l) => ok(l.bottom_cm) && ok(l.top_cm) && l.top_cm > l.bottom_cm);
  const pitBottom = Math.min(...L.map((l) => l.bottom_cm));
  const relLo = pitBottom / HS;                          // observed range, as a fraction of HS
  const atObs = (hr) => L.find((l) => hr * HS >= l.bottom_cm && hr * HS <= l.top_cm);
  const atMod = (hr) => M.L.find((l) => hr * M.hs >= l.hBot && hr * M.hs <= l.hTop);

  // Relative-height grid
  const grid = [];
  for (let i = 0; i < 40; i++) { const hr = (i + 0.5) / 40; if (hr >= relLo) grid.push(hr); }
  let gN = 0, gHit = 0; const hd = [];
  const conf = GROUPS.map(() => GROUPS.map(() => 0));
  for (const hr of grid) {
    const ol = atObs(hr), ml = atMod(hr);
    if (!ol || !ml) continue;
    const og = obsGroup(ol), mg = GROUP_OF[ml.cls];
    if (og !== null) { gN++; if (og === mg) gHit++; conf[og][mg]++; }
    if (ok(ol.hardness_idx)) hd.push(ml.h - ol.hardness_idx);
  }

  // Features
  const tolMatch = (hO, hM) => Math.abs(hO / HS - hM / M.hs) <= 0.12 || Math.abs((HS - hO) - (M.hs - hM)) <= 10;
  const inRange = (l) => l.hTop / M.hs >= relLo - 0.02;
  // basal persistent: bottom 30 % of the pack (only if the pit reached the ground)
  let basal = null;
  if (pitBottom <= 2) {
    const obsB = L.some((l) => l.bottom_cm < 0.3 * HS && obsPersistent(l));
    const modB = M.L.some((l) => l.hBot < 0.3 * M.hs && [3, 4, 5].includes(l.cls));
    const modBigRG = M.L.some((l) => l.hBot < 0.3 * M.hs && l.cls === 2 && l.gs >= 2);
    basal = { obs: obsB, model: modB, modelLargeRG: modBigRG };
  }
  const oCr = L.filter(obsCrust).map((l) => (l.bottom_cm + l.top_cm) / 2);
  const mCr = M.L.filter((l) => l.cls === 8 && inRange(l)).map((l) => (l.hBot + l.hTop) / 2);
  const oSH = L.filter((l) => obsSH(l) && HS - l.top_cm > 2).map((l) => (l.bottom_cm + l.top_cm) / 2);
  const mSH = M.L.filter((l) => l.cls === 6 && M.hs - l.hTop > 2 && inRange(l)).map((l) => (l.hBot + l.hTop) / 2);
  const matchSets = (A, B) => ({ obs: A.length, model: B.length, hit: A.filter((a) => B.some((b) => tolMatch(a, b))).length, falseAlarm: B.filter((b) => !A.some((a) => tolMatch(a, b))).length });

  // Test failures
  const fails = (o.tests || []).filter((t) => ok(t.height_cm) && !/(CTN|ECTX|ECTN\b|CTV)/i.test(t.score || "") && (t.taps === null || t.taps === undefined || t.taps <= 30) && !/BRK/i.test(t.fracture || ""));
  const failRes = fails.map((t) => {
    const hrO = t.height_cm / HS;
    const flagged = M.W.filter((w) => w.p >= 50 && tolMatch(t.height_cm, M.hs - w.depth));
    const ml = atMod(Math.min(0.999, Math.max(0.001, hrO)));
    return { score: t.score, h: t.height_cm, grain: t.layer_grain || null, flagged: flagged.length > 0, modelLayer: ml ? CLASSES[ml.cls] : null };
  });

  // Temperatures below 20 cm depth
  const tErr = [];
  for (const tp of o.temps || []) {
    if (!ok(tp.h_cm) || !ok(tp.t_c) || HS - tp.h_cm < 20) continue;
    const ml = atMod(Math.min(0.999, tp.h_cm / HS));
    if (ml) tErr.push(ml.T - tp.t_c);
  }

  return {
    file: o.file, season: o.season, date: o.date, kind: o.kind, site: o.site_slug, aspect: o.aspect, sim: aspName,
    point: m.id, match: m.how, km: m.km ?? null, dz: m.dz ?? null,
    hsObs: HS, hsModel: M.hs, hsErr: r1(M.hs - HS), partial: pitBottom > 2,
    groupAgree: gN ? Math.round((100 * gHit) / gN) : null, groupN: gN, conf,
    hardBias: r1(mean(hd)), hardMAE: r1(mean(hd.map(Math.abs))),
    basal, crusts: matchSets(oCr, mCr), sh: matchSets(oSH, mSH), tests: failRes,
    tempBias: r1(mean(tErr)), tempRMSE: tErr.length ? r1(Math.sqrt(mean(tErr.map((x) => x * x)))) : null,
    modelSurface: CLASSES[M.L[0]?.cls] ?? null,
  };
}

// ---- report ---------------------------------------------------------------------
const obs = loadObserved();
const rows = obs.map(score);
const used = rows.filter((r) => !r.skipped);
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, `${LABEL}-profiles.json`), JSON.stringify(rows, null, 1));

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)} %` : "–");
function block(name, R) {
  const hs = R.filter((r) => ok(r.hsErr) && !r.partial);
  const ga = R.filter((r) => ok(r.groupAgree));
  const bas = R.filter((r) => r.basal);
  const sum = (k, f) => R.reduce((s, r) => s + r[k][f], 0);
  const tests = R.flatMap((r) => r.tests);
  const tb = R.filter((r) => ok(r.tempBias));
  const hb = R.filter((r) => ok(r.hardBias));
  return [
    `### ${name} (${R.length} profiles)`,
    `| Measure | Value |`, `|---|---|`,
    `| HS error, model − observed (full-depth pits) | mean ${r1(mean(hs.map((r) => r.hsErr)))} cm, mean abs ${r1(mean(hs.map((r) => Math.abs(r.hsErr))))} cm (n ${hs.length}) |`,
    `| Grain-group agreement (relative height) | ${r1(mean(ga.map((r) => r.groupAgree)))} % (n ${ga.length}) |`,
    `| Hand hardness, model − observed | bias ${r1(mean(hb.map((r) => r.hardBias)))} steps, mean abs ${r1(mean(hb.map((r) => r.hardMAE)))} (n ${hb.length}) |`,
    `| Basal persistent grains (bottom 30 %) | observed in ${bas.filter((r) => r.basal.obs).length}/${bas.length}; model has them in ${bas.filter((r) => r.basal.obs && r.basal.model).length} of those; model shows ≥2 mm "RG" at the base in ${bas.filter((r) => r.basal.modelLargeRG).length} |`,
    `| Crusts | observed ${sum("crusts", "obs")}, matched ${sum("crusts", "hit")} (${pct(sum("crusts", "hit"), sum("crusts", "obs"))}); model crusts with no observed match ${sum("crusts", "falseAlarm")} |`,
    `| Buried surface hoar | observed ${sum("sh", "obs")}, matched ${sum("sh", "hit")} (${pct(sum("sh", "hit"), sum("sh", "obs"))}); model SH with no observed match ${sum("sh", "falseAlarm")} |`,
    `| Test failures with a model weak layer (p ≥ 50 %) within tolerance | ${tests.filter((t) => t.flagged).length}/${tests.length} (${pct(tests.filter((t) => t.flagged).length, tests.length)}) |`,
    `| Snow temperature, model − observed (below 20 cm) | bias ${r1(mean(tb.map((r) => r.tempBias)))} °C, RMSE ${r1(mean(tb.map((r) => r.tempRMSE)))} °C (n ${tb.length}) |`,
    "",
  ].join("\n");
}
const conf = GROUPS.map(() => GROUPS.map(() => 0));
for (const r of used) r.conf.forEach((row, i) => row.forEach((v, j) => (conf[i][j] += v)));
const md = [
  `# Model vs field profiles: ${LABEL}`,
  "",
  `${obs.length} field profiles; ${used.length} scored, ${rows.length - used.length} skipped (${[...new Set(rows.filter((r) => r.skipped).map((r) => r.skipped.replace(/ \d{4}-.*/, "")))].join("; ")}).`,
  `Matching tolerance for layers: 12 % of HS in relative height, or 10 cm in depth from the surface.`,
  "",
  block("All", used),
  block("Study plots", used.filter((r) => r.kind === "study_plot")),
  block("Test profiles", used.filter((r) => r.kind !== "study_plot")),
  ...["2023-24", "2024-25", "2025-26"].map((s) => block(`Season ${s}`, used.filter((r) => r.season === s))),
  ...Object.keys(PLOTS).map((s) => block(`Study plot: ${s}`, used.filter((r) => r.site === s))),
  "### Grain groups: observed (rows) vs model (columns), grid cells",
  `| obs \\ model | ${GROUPS.join(" | ")} |`, `|---|${GROUPS.map(() => "---").join("|")}|`,
  ...GROUPS.map((g, i) => `| ${g} | ${conf[i].join(" | ")} |`),
  "",
].join("\n");
writeFileSync(join(OUT, `${LABEL}-summary.md`), md);
console.log(md);
