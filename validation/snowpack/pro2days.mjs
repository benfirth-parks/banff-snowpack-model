// Turns a SNOWPACK reference run (validation/snowpack/run.sh output) into the
// validation day records that validation/compare.mjs and station-hs.mjs read, so
// SLF's model is scored exactly like ours at the same points.
//
//   node validation/snowpack/pro2days.mjs --runs <dir> --smet <dir> --out <dir>
//        [--seasons 2023-24,2024-25] [--points id,id]
//
// <runs>/<season>/ holds SNOWPACK's output per point: five PRO profile series,
// main station plus the four virtual slopes, which SNOWPACK names
// <id><sector>_<experiment>.pro (sector 1..4, nothing for the main station) and
// the matching SMET time series. Files are discovered by prefix and the sector
// is read from the PRO header (SlopeAngle, SlopeAzi: 0 N, 90 E, 180 S, 270 W),
// so the experiment name and the sector digit never matter. <smet>/<season>/
// meta.json lists the points (written by export-smet.mjs). Writes
// <out>/<season>/<id>.json.gz = { id, season, point, run, days } and copies
// <smet>/points.json to <out>/points.json.
//
// Day records, one per local date (America/Edmonton), from the 3-hourly profile
// nearest 17:00 local, in the layout of scripts/replay.mjs:
//   t     epoch hour of 17:00 local; tp: epoch hour of the profile used
//   hs    [flat, N, E, S, W] snow height, cm, as the PRO reports it: SNOWPACK gives
//         a virtual slope cos(slope) of the flat snowfall and writes heights
//         divided by cos(slope) again, so PRO heights are flat-equivalent, which
//         is the convention of our model's slope columns too (site.js adds no
//         cos factor; a pit's perpendicular depth would be these × cos 38°). All
//         depths in A, W and S below are in the same units. null for a sector
//         whose PRO file is missing.
//   A     per sector, top-down, 6 ints per element: [top depth cm x10, class,
//         hand hardness x10, T degC x10, grain size mm x10, density kg/m3].
//         Class from the Swiss code F1 in 0513 (1 PP, 2 DF, 3 RG, 4 FC, 5 DH,
//         6 SH, 7 MF, 8 IF, 9 FCxr); MF is a crust (our MFcr) when SNOWPACK marks
//         it refrozen, F3 = 2 or mk % 100 >= 20 (DataClasses.cc snowType); IF is
//         always MFcr. Hardness from 0534 in index steps, or back from Newton with
//         SNOWPACK's own 19.3 h^2.4 when the run wrote Newton.
//   W     per sector, up to 3 weak interfaces: [depth cm, class, burial, p,
//         lemons, Sk38 x100, SSI x100, RTA x100]. SNOWPACK's indices at an
//         interface use the lower shear strength of the two layers meeting there
//         (StabilityAlgorithms.cc, Sig_c2 = min(own, upper)), so class is that
//         weaker layer's (0601; the lower one when equal) and burial is the epoch
//         hour the layer above it was deposited (from its 0505 age; the replay's
//         convention). W[0] is SNOWPACK's own weak layer: the
//         interface its skier search picks (0530 z_Sk38; Stability::findWeakLayer
//         replicated when 0530 is missing) with p from its stability class,
//         Schweizer/Bellaire 2007 scheme as in StabilityAlgorithms.cc: poor 100,
//         fair 60, good 0. The next entries are the lowest-SSI interfaces in the
//         same search window (below the skier penetration depth, above the
//         bottom 20 cm, at least 10 cm from a listed one) that SNOWPACK's SSI
//         classes call poor (SSI < 1.25, p 100) or fair (< 1.55, p 60). Interfaces
//         at the stability cap (Sk38 = 6, "not evaluated") are never listed.
//         lemons = round(6 x RTA) from 0607 (Monti & Schweizer relative threshold
//         sum; the weakest layer is 6 by construction); without 0607 the count of
//         Schweizer & Jamieson (2007) criteria that the file allows: persistent
//         grain type, grain size >= 1.25 mm, hardness <= 1.3, grain size
//         difference >= 0.4 mm (0602), hardness difference >= 1.7 (0603), depth
//         18-94 cm.
//   S     per sector, SNOWPACK's 0530 line: [profile type, stability class,
//         z_Sdef, Sdef, z_Sn38, Sn38, z_Sk38, Sk38], z in cm above
//         the ground (so hs - S[6] is the depth of SNOWPACK's weak layer).
//   obsHS station points: the baseline-adjusted sensor snow height, cm, at 17:00
//         local (previous hour when missing), from <smet>/<season>/<id>.hs.json,
//         the same unfiltered series the replay records, so station-hs.mjs scores
//         both models against one observation. (The SMET HS column SNOWPACK was
//         fed is cleaned and gap-filled; it is used only when the .hs.json is absent.)
//   hsTs  HS_mod of the main sector from SNOWPACK's SMET time series at tp, cm.
// Days without snow have hs 0 and empty A and W, like the replay. A date whose
// nearest profile is more than 6 h from 17:00 (a gap in the run) is left out.
//
// PRO files run to tens of MB per season, so they are read line by line and only
// the profile nearest 17:00 of each date is decoded. Codes used: 0500 0501 0502
// 0503 0504 0505 0512 0513 0530 0533 0534 0601 0602 0603 0604 0607.
import { createReadStream, readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, copyFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { gzipSync } from "node:zlib";
import { join, basename } from "node:path";
import { localDate, snapHour, addDays } from "../../src/model/time.js";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const RUNS = args.runs, SMET = args.smet, OUT = args.out;
if (!RUNS || !SMET || !OUT) { console.error("--runs, --smet and --out are required"); process.exit(1); }
const ONLY = args.points ? new Set(args.points.split(",")) : null;
const ok = (v) => v !== null && v !== undefined && Number.isFinite(v);
const r0 = (x) => (ok(x) ? Math.round(x) : null);
const rN = (x, n) => (ok(x) ? Math.round(x * n) : null);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Swiss grain code F1 -> our class (0 PP, 1 DF, 2 RG, 3 FCxr, 4 FC, 5 DH, 6 SH, 7 MF, 8 MFcr).
// F1 0 is graupel, technical snow or a water layer: counted as PP.
const CLASS_OF_F1 = [0, 0, 1, 2, 4, 5, 6, 7, 8, 3];
function classOf(type) {
  const f1 = Math.floor(type / 100) % 10, f3 = type % 10;
  const c = CLASS_OF_F1[f1] ?? 2;
  // MF is a crust (MFcr) only when SNOWPACK writes it refrozen, F3 = 2; the marker's
  // crust flag (mk % 100 >= 20) also sits on frozen rain and wind crusts whose grain
  // type is not MF, and is not what the Swiss code calls refrozen. IF (F1 8) is MFcr.
  return c === 7 && f3 === 2 ? 8 : c;
}
// SNOWPACK's stability classes: 1 poor, 3 fair, 5 good, -1 undefined.
const P_OF_CLASS = { 1: 100, 3: 60, 5: 0 };
// StabilityAlgorithms::classifyStability_SchweizerBellaire2, SNOWPACK's default (prof_classi 2).
const class2 = (nlem, sk) => (nlem >= 2 ? 1 : nlem === 1 ? (sk < 0.48 ? 1 : sk < 0.71 ? 3 : 5) : 3);
// StabilityAlgorithms::classifyStability_Bellaire: SSI thresholds, meaningful per interface.
const class0 = (ssi) => (ssi < 1.25 ? 1 : ssi < 1.55 ? 3 : 5);
const MAX_STAB = 6;                       // Stability::max_stability
const NEEDED = new Set(["0501", "0502", "0503", "0504", "0505", "0512", "0513", "0530", "0533", "0534", "0601", "0602", "0603", "0604", "0607"]);
const MAX_GAP = 6;                        // hours between 17:00 local and the profile used

// ---- time ----------------------------------------------------------------------
const snapCache = new Map();
const snapOf = (d) => { let v = snapCache.get(d); if (v === undefined) { v = snapHour(d); snapCache.set(d, v); } return v; };
// The local date whose 17:00 snapshot is nearest to epoch hour tp.
function nearestSnap(tp) {
  const d0 = localDate(tp);
  let best = null;
  for (const d of [addDays(d0, -1), d0, addDays(d0, 1)]) {
    const dist = Math.abs(snapOf(d) - tp);
    if (!best || dist < best.dist) best = { date: d, dist };
  }
  return best;
}
// PRO dates are DIN "DD.MM.YYYY HH:MM:SS" (ISO tolerated) in the run's output time zone.
function parseDate(s, tz) {
  let m = /^(\d{2})\.(\d{2})\.(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)) / 36e5 - tz;
  m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 36e5 - tz;
  return null;
}

// ---- SNOWPACK's config and time series --------------------------------------------
// The TIME_ZONE and HARDNESS_IN_NEWTON of the ini SNOWPACK copies next to its
// output. PRO dates are written in the [Input] TIME_ZONE (AsciiIO reads only that
// one, and the Date objects carry it to toString); [Output] TIME_ZONE is the
// fallback when [Input] has none. run.sh writes both as 0.
function readOutputIni(dir, base) {
  const re = new RegExp(`^${esc(base)}(?:[_-][^.]*)?\\.ini$`);
  const f = readdirSync(dir).find((x) => re.test(x));
  const cfg = { tz: 0, newton: null };
  if (!f) return cfg;
  let sec = "", tzIn = null, tzOut = null;
  for (const raw of readFileSync(join(dir, f), "utf8").split("\n")) {
    const line = raw.replace(/[;#].*$/, "").trim();
    if (!line) continue;
    const s = /^\[(\w+)\]/.exec(line);
    if (s) { sec = s[1].toLowerCase(); continue; }
    const kv = /^(\w+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    if (sec === "input" && kv[1] === "TIME_ZONE") tzIn = +kv[2];
    if (sec === "output" && kv[1] === "TIME_ZONE") tzOut = +kv[2];
    if (sec === "output" && kv[1] === "HARDNESS_IN_NEWTON") cfg.newton = /^true$/i.test(kv[2]);
  }
  cfg.tz = tzIn ?? tzOut ?? 0;
  return cfg;
}
// A SMET file as { tz, header, rows: Map(epoch hour -> value of `field`) }. Small enough to read whole.
function readSmetColumn(file, field) {
  const text = readFileSync(file, "utf8");
  const h = {};
  const dataAt = text.indexOf("[DATA]");
  for (const line of text.slice(0, dataAt).split("\n")) { const m = /^(\w+)\s*=\s*(.*)$/.exec(line.trim()); if (m) h[m[1]] = m[2].trim(); }
  const fields = (h.fields || "").split(/\s+/);
  const col = fields.indexOf(field);
  const rows = new Map();
  if (col < 0) return { header: h, col, rows };
  const tz = +(h.tz || 0), nodata = h.nodata ?? "-999";
  for (const line of text.slice(dataAt + 6).split("\n")) {
    if (!line || line[0] === "#") continue;
    const parts = line.trim().split(/\s+/);
    const v = parts[col];
    if (v === undefined || v === nodata) continue;
    const t = parseDate(parts[0], tz);
    const x = +v;
    if (t !== null && Number.isFinite(x) && x !== +nodata) rows.set(Math.round(t * 1000) / 1000, x);
  }
  return { header: h, col, rows };
}

// ---- PRO ------------------------------------------------------------------------
function sectorOf(angle, azi) {
  if (!ok(angle) || angle < 1) return 0;
  return 1 + (Math.round((((azi % 360) + 360) % 360) / 90) % 4);
}
const nums = (line) => (line ? line.split(",").slice(2).map(Number) : null);

// Skier penetration depth, m vertical, as StabilityAlgorithms::compPenetrationDepth:
// 0.8 x 43.3 / mean density of the elements whose bottom lies within 30 cm of the
// surface, cut at the first strong crust (mk >= 20, rho > 500, > 3 cm perp).
function penetration(topS, botS, rhoS, mkS, HSv, cos) {
  let m = 0, dz = 0, topCrust = 0, thick = 0, eCrust = -1, crust = false;
  for (let e = topS.length - 1; e >= 0 && (HSv - botS[e]) / 100 < 0.3; e--) {
    const L = ((topS[e] - botS[e]) * cos) / 100;
    m += rhoS[e] * L; dz += L;
    if (crust) continue;
    if (ok(mkS?.[e]) && mkS[e] % 100 >= 20 && rhoS[e] > 500) {
      if (eCrust < 0) { eCrust = e; topCrust = topS[e] / 100; thick = L; } else if (eCrust - e < 2) { thick += L; eCrust = e; }
    } else if (thick > 0.03) crust = true;
    else { eCrust = -1; topCrust = 0; thick = 0; }
  }
  return dz > 0 ? Math.min((0.8 * 43.3) / (m / dz), HSv / 100 - topCrust) : null;
}
// Stability::findWeakLayer, skier part: the interfaces searched (element indices,
// the interface being the top of element e) and the one SNOWPACK picks: minimum
// SSI, near-ties (< 0.09) going to the interface with more lemons.
function skierSearch(topS, HSv, Pk, ssi, nlem) {
  const nS = topS.length, hsM = HSv / 100;
  if (!(hsM > 0.2) || Pk === null || !(hsM - Pk > 0.1)) return { pick: null, win: [] };   // S_s = 6 at the surface
  let E1 = -1;
  for (let e = nS - 1; e >= 0; e--) if ((HSv - topS[e]) / 100 >= Pk) { E1 = e; break; }
  if (E1 <= 0) return { pick: 0, win: [] };                                           // "bottom values"
  const win = [];
  let best = null;
  for (let e = E1 - 1; e >= 0; e--) {
    if (!((HSv - topS[e]) / 100 < Pk + 1.0 && topS[e] / 100 > 0.2)) break;
    win.push(e);
    if (best === null || ssi[e] < ssi[best] || (Math.abs(ssi[best] - ssi[e]) < 0.09 && nlem[e] > nlem[best])) best = e;
  }
  return { pick: best, win };
}

// One profile block -> { hs, A, W, S }. `cos` is cos(slope), `cfg` the file's units.
function decodeBlock(L, cos, cfg, tp) {
  const s530 = nums(L["0530"]);
  const S = s530 && s530.length >= 8 ? [s530[0], s530[1], rN(s530[2], 10) / 10, s530[3], rN(s530[4], 10) / 10, s530[5], rN(s530[6], 10) / 10, s530[7]] : null;
  const tops = nums(L["0501"]);
  const rho = nums(L["0502"]);
  if (!tops || !rho || tops.length < 1 || (tops.length === 1 && tops[0] === 0)) return { hs: 0, A: [], W: [], S };
  // Snow-only codes (0512, 0513, 0533, 0534, 06xx) skip soil elements; with soil the
  // all-element codes (0501-0505) carry them first. No soil in our runs: off = 0.
  const gs = nums(L["0512"]), type = nums(L["0513"]);
  const nE = rho.length, nS = gs ? gs.length : nE, off = nE - nS;
  const top = tops.length > nE ? tops.slice(tops.length - nE) : tops;       // 0501 lists the bottom node too with soil
  const T = nums(L["0503"]), mk = cfg.mk ? nums(L["0504"]) : null;
  const ageRaw = L["0505"] ? L["0505"].split(",").slice(2) : null;
  const age = ageRaw ? ageRaw.map((v) => (/[T-]/.test(v) ? tp / 24 - parseDate(v, cfg.tz) / 24 : +v)) : null;
  const hardRaw = nums(L["0534"]);
  const hard = hardRaw ? hardRaw.map((v) => Math.min(6, Math.max(1, cfg.newton ? Math.pow(Math.abs(v) / 19.3, 1 / 2.4) : Math.abs(v)))) : null;
  const sk = nums(L["0533"]), ssi = nums(L["0604"]), rta = nums(L["0607"]), dgs = nums(L["0602"]), dh = nums(L["0603"]), str = nums(L["0601"]);
  const topS = top.slice(off), botS = topS.map((_, e) => (e > 0 ? topS[e - 1] : 0));
  const HSv = topS[nS - 1];
  const hs = r0(HSv);
  const cls = new Array(nS);
  const A = [];
  for (let e = nS - 1; e >= 0; e--) {
    cls[e] = classOf(type?.[e] ?? 0);
    A.push(rN(HSv - topS[e], 10), cls[e], hard ? rN(hard[e], 10) : null, T ? rN(T[off + e], 10) : null, gs ? rN(gs[e], 10) : null, r0(rho[off + e]));
  }
  const depthOf = (e) => HSv - topS[e];             // cm below the surface, in the PRO's (vertical) heights
  // SNOWPACK's two lemons (Stability::initStructuralStabilityIndex: dhard > 1.5, dgsz > 0.5), or back from SSI = 2 - n + Sk38.
  const nlem = new Array(nS).fill(0).map((_, e) => (dh && dgs ? (dh[e] > 1.5 ? 1 : 0) + (dgs[e] > 0.5 ? 1 : 0) : ssi && sk && ssi[e] < MAX_STAB ? Math.min(2, Math.max(0, Math.round(2 + sk[e] - ssi[e]))) : 0));
  // The layer that fails at the interface on top of element e: the weaker of e and e+1
  // (without 0601, the one above a crust, whose strength SNOWPACK fixes at 4 kPa).
  const weakOf = (e) => (e + 1 < nS && (str ? str[e + 1] < str[e] : ok(mk?.[off + e]) && mk[off + e] % 100 >= 20) ? e + 1 : e);
  const lemons = (e, w) => {
    if (rta) return Math.round(6 * rta[w]); // RTA is a property of the (weak) layer, like class and grain size
    const f1 = Math.floor((type?.[w] ?? 0) / 100) % 10, d = depthOf(e);
    return (f1 === 4 || f1 === 5 || f1 === 6 || f1 === 9 ? 1 : 0) + (gs && gs[w] >= 1.25 ? 1 : 0) + (hard && hard[w] <= 1.3 ? 1 : 0) +
      (dgs && dgs[e] >= 0.4 ? 1 : 0) + (dh && dh[e] >= 1.7 ? 1 : 0) + (d >= 18 && d <= 94 ? 1 : 0);
  };
  // W depth is the top of the weak layer, as the replay's weakLayers() writes it (the
  // failure interface is the top of element e; when the weaker side is the layer
  // above, e + 1, its top is one element higher).
  const depthW = (e) => depthOf(weakOf(e));
  const entry = (e, p) => {
    const w = weakOf(e);
    // burial as the replay writes it: the epoch hour the layer above the weak one was deposited (0505 is its age in days at tp)
    return [r0(depthW(e)), cls[w], age ? r0(tp - 24 * age[off + Math.min(w + 1, nS - 1)]) : null, p, lemons(e, w), rN(sk?.[e], 100), rN(ssi?.[e], 100), rN(rta?.[w], 100)];
  };
  const W = [];
  if (sk && ssi) {
    const Pk = penetration(topS, botS, rho.slice(off), mk ? mk.slice(off) : null, HSv, cos);
    const { pick, win } = skierSearch(topS, HSv, Pk, ssi, nlem);
    // SNOWPACK's own pick when 0530 has it (z_Sk38 is the interface height, vertical cm), else the replicated search.
    let e0 = null, p0 = null;
    // Sk38 = -999 (nodata) with z at the surface and class -1 means the skier search found
    // no interface (thin packs: the first interface below the penetration is already in
    // the bottom 20 cm); it must not read as a weak layer at depth 0.
    if (s530 && ok(s530[6]) && s530[7] > 0 && s530[7] < MAX_STAB) {
      e0 = topS.findIndex((z) => Math.abs(z - s530[6]) <= 0.06);
      if (e0 >= 0) p0 = P_OF_CLASS[s530[1]] ?? 0; else e0 = null;
      if (pick !== null && e0 !== null && pick !== e0) decodeBlock.mismatch++;
    } else if (pick !== null && sk[pick] < MAX_STAB) { e0 = pick; p0 = P_OF_CLASS[class2(nlem[pick], sk[pick])]; }
    if (e0 !== null) W.push(entry(e0, p0));
    for (const e of [...win].sort((a, b) => ssi[a] - ssi[b])) {
      if (W.length >= 3) break;
      if (e === e0 || sk[e] >= MAX_STAB || class0(ssi[e]) > 3) continue;
      if (W.some((w) => Math.abs(w[0] - depthW(e)) < 10)) continue;
      W.push(entry(e, P_OF_CLASS[class0(ssi[e])]));
    }
  }
  return { hs, A, W, S };
}
decodeBlock.mismatch = 0;

// Streams one PRO file; keeps, per local date, the decoded profile nearest 17:00.
async function parsePro(file, ini) {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  const cfg = { tz: ini.tz, newton: ini.newton ?? false, mk: true, version: null, angle: 0, azi: 0 };
  const days = new Map();
  let inData = false, block = null, pending = null, skip = false;
  const cos = () => Math.cos((cfg.angle * Math.PI) / 180);
  const settle = (b) => days.set(b.date, { tp: b.tp, ...decodeBlock(b.L, cos(), cfg, b.tp) });
  const close = () => {
    if (!block || skip) return;
    if (!pending || block.date !== pending.date) { if (pending) settle(pending); pending = block; }
    else if (block.dist <= pending.dist) pending = block;                   // ties go to the later profile
  };
  for await (const line of rl) {
    if (!inData) {
      if (line.startsWith("SlopeAngle=")) cfg.angle = +line.slice(11);
      else if (line.startsWith("SlopeAzi=")) cfg.azi = +line.slice(9);
      else if (line.startsWith("0534,")) cfg.newton = /newton/i.test(line);
      else if (line.startsWith("0504,")) cfg.mk = !/element ID/i.test(line);
      else if (line.startsWith("#")) cfg.version = (/Snowpack[- ]([\w.]+)/i.exec(line) || [])[1] || null;
      else if (line.startsWith("[DATA]")) inData = true;
      continue;
    }
    if (line.startsWith("0500,")) {
      close();
      const tp = parseDate(line.slice(5), cfg.tz);
      if (tp === null) { skip = true; block = null; continue; }
      const { date, dist } = nearestSnap(tp);
      if (dist > MAX_GAP || (pending && date === pending.date && dist > pending.dist)) { skip = true; block = null; continue; } // too far or moving away from 17:00
      skip = false; block = { tp, date, dist, L: {} };
      continue;
    }
    if (skip || !block) continue;
    const code = line.slice(0, 4);
    if (NEEDED.has(code)) block.L[code] = line;
  }
  close();
  if (pending) settle(pending);
  return { file: basename(file), sector: sectorOf(cfg.angle, cfg.azi), angle: cfg.angle, azi: cfg.azi, version: cfg.version, newton: cfg.newton, days };
}

// ---- main -----------------------------------------------------------------------
const seasons = (args.seasons ? args.seasons.split(",") : readdirSync(SMET).filter((s) => /^\d{4}-\d{2}$/.test(s)).sort()).filter((s) => existsSync(join(SMET, s, "meta.json")));
mkdirSync(OUT, { recursive: true });
const pointsFile = join(SMET, "points.json");
const points = existsSync(pointsFile) ? JSON.parse(readFileSync(pointsFile, "utf8")) : null;
if (points) copyFileSync(pointsFile, join(OUT, "points.json"));
else {
  // No point list next to the SMETs (hand-made input): synthesise one from the metas.
  const seen = new Map();
  for (const s of seasons) for (const m of JSON.parse(readFileSync(join(SMET, s, "meta.json"), "utf8"))) if (!seen.has(m.id)) seen.set(m.id, { id: m.id, pid: m.id, name: m.id, band: null, lat: m.lat, lon: m.lon, z: m.z, kind: m.hasHS ? "station" : "named" });
  writeFileSync(join(OUT, "points.json"), JSON.stringify([...seen.values()], null, 1));
  console.error(`no ${pointsFile}: points.json synthesised from meta.json`);
}
const pointById = new Map((points || []).map((p) => [p.id, p]));

for (const season of seasons) {
  const t0 = Date.now();
  const runDir = join(RUNS, season);
  if (!existsSync(runDir)) { console.error(`${season}: no ${runDir}`); continue; }
  const meta = JSON.parse(readFileSync(join(SMET, season, "meta.json"), "utf8")).filter((m) => !ONLY || ONLY.has(m.id));
  mkdirSync(join(OUT, season), { recursive: true });
  let nDays = 0, nPts = 0, missing = 0;
  const files = readdirSync(runDir);
  for (const m of meta) {
    const base = m.file.replace(/\.smet$/, "");
    const proRe = new RegExp(`^${esc(base)}\\d{0,2}(?:_[^.]*)?\\.pro$`);
    const pros = files.filter((f) => proRe.test(f));
    if (!pros.length) { console.error(`${season}/${m.id}: no PRO files`); missing++; continue; }
    const ini = readOutputIni(runDir, base);
    const sectors = new Array(5).fill(null);
    for (const f of pros) {
      const r = await parsePro(join(runDir, f), ini);
      if (sectors[r.sector]) { console.error(`${season}/${m.id}: ${f} and ${sectors[r.sector].file} both read as sector ${r.sector}; keeping the first`); continue; }
      sectors[r.sector] = r;
    }
    const main = sectors[0];
    if (!main) { console.error(`${season}/${m.id}: no flat (main station) PRO among ${pros.join(", ")}`); missing++; continue; }
    for (let i = 1; i < 5; i++) if (!sectors[i]) console.error(`${season}/${m.id}: sector ${i} (${["flat", "N", "E", "S", "W"][i]}) PRO missing`);
    // Main-sector SMET time series (HS_mod, vertical cm; the main station is flat) and the sensor HS fed in.
    const smetRe = new RegExp(`^${esc(base)}(?:_[^.]*)?\\.smet$`);
    let ts = null;
    for (const f of files.filter((x) => smetRe.test(x))) { const s = readSmetColumn(join(runDir, f), "HS_mod"); if (s.col >= 0) { ts = s.rows; break; } }
    // obsHS: the unfiltered baseline-adjusted sensor series the replay scores against
    // (<stem>.hs.json from export-smet.mjs); the SMET's HS column, which is cleaned and
    // gap-filled for SNOWPACK, only when there is no such file (hand-made input).
    const hsFile = join(SMET, season, `${base}.hs.json`), inFile = join(SMET, season, m.file);
    let obs = null;
    if (existsSync(hsFile)) { const h = JSON.parse(readFileSync(hsFile, "utf8")); obs = new Map(h.v.map((v, i) => [h.t0 + i, ok(v) ? v / 100 : null]).filter(([, v]) => ok(v))); }
    else if (m.hasHS !== false && existsSync(inFile)) obs = readSmetColumn(inFile, "HS").rows;
    const days = [];
    for (const date of [...main.days.keys()].sort()) {
      const t = snapOf(date);
      const recs = sectors.map((s) => s?.days.get(date) || null);
      const d = {
        t, date, tp: Math.round(recs[0].tp * 1000) / 1000,
        hs: recs.map((r) => (r ? r.hs : null)), A: recs.map((r) => (r ? r.A : [])), W: recs.map((r) => (r ? r.W : [])), S: recs.map((r) => (r ? r.S : null)),
      };
      if (obs && obs.size) { const v = obs.get(t) ?? obs.get(t - 1); if (ok(v)) d.obsHS = Math.round(v * 1000) / 10; }
      if (ts) { const v = ts.get(Math.round(recs[0].tp * 1000) / 1000); if (ok(v)) d.hsTs = Math.round(v * 10) / 10; }
      days.push(d);
    }
    const point = pointById.get(m.id) || { id: m.id, pid: m.id, name: m.id, band: null, lat: m.lat, lon: m.lon, z: m.z, kind: m.hasHS ? "station" : "named" };
    const run = { model: "SNOWPACK", version: main.version, files: sectors.map((s) => s?.file || null), slopes: sectors.map((s) => (s ? [s.angle, s.azi] : null)), hardness: main.newton ? "newton" : "index", tz: ini.tz };
    writeFileSync(join(OUT, season, `${m.id.replace(":", "_")}.json.gz`), gzipSync(JSON.stringify({ id: m.id, season, point, run, days })));
    nDays += days.length; nPts++;
  }
  console.log(`${season}: ${nPts} points, ${nDays} days${missing ? `, ${missing} points without output` : ""}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
if (decodeBlock.mismatch) console.error(`${decodeBlock.mismatch} profiles where the replicated skier search differs from 0530 (0530 used)`);
