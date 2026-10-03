// The model run: read new station actuals and the latest forecast-model output,
// advance every simulated snowpack through the observed hours (the "analysis"),
// then run copies forward through the forecast, writing daily map fields and
// point profiles to Netlify Blobs.
import { STATIONS, NAMED_POINTS, BANDS, GRID, gridCells, modelNodes, ASPECTS, kmBetween } from "../../src/model/domain.js";
import { prepareForcing, snapshotWindows } from "../../src/model/forcing.js";
import { createSite, stepSite, packSite, unpackSite, cloneSite } from "../../src/model/site.js";
import { diagnose, summarize, layersTopDown } from "../../src/model/stability.js";
import { newSnowDensity } from "../../src/model/snowpack.js";
import { tzOffset, localDate, snapHour, isSnapHour, addDays } from "../../src/model/time.js";
import { SPREAD_MEMBERS, SPREAD_HOURS, memberForcing, precipScale } from "../../src/model/spread.js";

export const SEASON_START = "2026-09-01";
// Bump when model physics or forcing change: stored seasons are then re-run from
// their start by the next live run / season chunk.
export const MODEL_VERSION = 6;
export const LIVE_SEASON = "2026-27";
export const BATCH = 250;
export const HIST = 30; // hours of history before the analysis start (residual tails, 24 h precip windows)

export const PROPS = [
  "hazard", "pNew", "pWind", "pPwl", "pWet",
  "precip72", "snow72", "rain72", "precip24", "snow24", "rain24",
  "wind24", "skiPen", "critPwl", "critPwlDist", "critPwlDepth", "lwc", "lwm", "hs", "elev",
];

export const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
export const ok = (v) => v !== null && v !== undefined && Number.isFinite(v);
const r1 = (x) => (ok(x) ? Math.round(x * 10) / 10 : null);
const r0 = (x) => (ok(x) ? Math.round(x) : null);

// ---------------------------------------------------------------------------
// cellElevations(boxes) → [{ mean, max } | null] for lat/lon boxes (terrain tiles).
export async function ensureMeta(store, cellElevations, log) {
  const meta = await store.get("meta", { type: "json" });
  if (meta) return meta;
  log("setup: building grid and reading terrain tiles");
  const { nR, nC, cells } = gridCells();
  const boxes = cells.map((c) => ({ lat0: c.lat - GRID.dLat / 2, lat1: c.lat + GRID.dLat / 2, lon0: c.lon - GRID.dLon / 2, lon1: c.lon + GRID.dLon / 2 }));
  const elev = await cellElevations(boxes);
  cells.forEach((c, i) => { c.z = elev[i] ? elev[i].mean : null; c.zMax = elev[i] ? elev[i].max : null; });
  const points = [];
  for (const p of NAMED_POINTS) for (const b of BANDS) points.push({ id: `${p.id}:${b.id}`, pid: p.id, name: p.name, band: b.id, lat: p.lat, lon: p.lon, z: b.z, park: p.park, kind: "named" });
  for (const s of STATIONS) if (!s.noPoint) points.push({ id: s.id, pid: s.id, name: s.name, band: null, lat: s.lat, lon: s.lon, z: s.z, park: s.park, kind: "station" });
  const m = {
    version: 1, seasonStart: SEASON_START, createdAt: new Date().toISOString(),
    grid: { ...GRID, nR, nC }, cells: cells.filter((c) => ok(c.z)), points,
    aspects: ASPECTS.map((a) => a.id), analysisHour: null, forecastIssued: null,
    dates: { analysis: [], forecast: [] }, season: LIVE_SEASON,
  };
  await store.setJSON("meta", m);
  return m;
}

// ---- snow-height sensor baselines -----------------------------------------
// Ultrasonic HS sensors read a few cm (vegetation, rocks, mounting) over bare
// ground. The baseline is the 20th percentile of HS during warm July–September hours (> 5 °C,
// from the station or the nearest station with a thermometer, lapse-adjusted),
// which are snow-free in practice; it is subtracted before comparing with the model.
export function hsBaselines(obsById) {
  const withT = STATIONS.filter((s) => (obsById[s.id] || []).some((r) => ok(r.T)));
  const tMaps = Object.fromEntries(withT.map((s) => [s.id, new Map(obsById[s.id].filter((r) => ok(r.T)).map((r) => [r.t, r.T]))]));
  const out = {};
  for (const s of STATIONS) {
    const recs = (obsById[s.id] || []).filter((r) => ok(r.HS));
    if (!recs.length) continue;
    const src = tMaps[s.id] ? s : withT.slice().sort((a, b) => (kmBetween(s, a) + Math.abs(s.z - a.z) / 50) - (kmBetween(s, b) + Math.abs(s.z - b.z) / 50))[0];
    if (!src) continue;
    const tm = tMaps[src.id], dz = s.z - src.z;
    // July–September only: warm spring hours often still have snow on the ground,
    // which put baselines of up to 30 cm on Bow Summit, Sunshine and others.
    const summer = (t) => { const m = new Date(t * 3600000).getUTCMonth(); return m >= 6 && m <= 8; };
    const vals = recs.filter((r) => { const T = tm.get(r.t); return summer(r.t) && ok(T) && T - 0.0065 * dz > 5; }).map((r) => r.HS).sort((a, b) => a - b);
    if (vals.length >= 24) out[s.id] = { base: Math.max(-5, Math.min(30, Math.round(vals[Math.floor(vals.length * 0.2)] * 10) / 10)), n: vals.length };
  }
  return out;
}
export const adjHS = (v, b) => (ok(v) ? Math.max(0, Math.round((v - (b ? b.base : 0)) * 10) / 10) : null);

// ---- per-site bookkeeping (rolling forcing history + daily totals) ---------
export function initExtras(site) { site.h = { P: [], S: [], R: [], U: [] }; site.dl = []; site.acc = { s: 0, r: 0 }; return site; }
export function packFull(site) { return { ...packSite(site), x: { h: site.h, dl: site.dl, acc: site.acc } }; }
export function unpackFull(p) { const s = unpackSite(p); if (p.x) { s.h = p.x.h; s.dl = p.x.dl; s.acc = p.x.acc; } else initExtras(s); return s; }
function cloneFull(site) { const c = cloneSite(site); c.h = { P: [...site.h.P], S: [...site.h.S], R: [...site.h.R], U: [...site.h.U] }; c.dl = site.dl.map((d) => ({ ...d })); c.acc = { ...site.acc }; return c; }

export function advance(site, f) {
  const snowMm = f.P * f.sf;
  const snowCm = snowMm > 0 ? (snowMm / newSnowDensity(f.Ta, f.U)) * 100 : 0;
  const rain = f.P * (1 - f.sf);
  const push = (a, v, n) => { a.push(Math.round(v * 100) / 100); if (a.length > n) a.shift(); };
  push(site.h.P, f.P, 72); push(site.h.S, snowCm, 72); push(site.h.R, rain, 72); push(site.h.U, f.U * 3.6, 24);
  site.acc.s += snowCm; site.acc.r += rain;
  stepSite(site, f);
}

export function closeDay(site, t) {
  site.dl.push({ t, s: Math.round(site.acc.s * 10) / 10, r: Math.round(site.acc.r * 10) / 10 });
  if (site.dl.length > 14) site.dl.shift();
  site.acc = { s: 0, r: 0 };
}

// Values + text for one site at a snapshot hour.
export function snapshot(site, t, withProfile) {
  const sum = (a, n) => a.slice(-n).reduce((s, x) => s + x, 0);
  const wx = {
    precip24: sum(site.h.P, 24), snow24: sum(site.h.S, 24), rain24: sum(site.h.R, 24),
    precip72: sum(site.h.P, 72), snow72: sum(site.h.S, 72), rain72: sum(site.h.R, 72),
    wind24: site.h.U.length ? mean(site.h.U) : null,
  };
  const diags = site.sims.map((sim) => diagnose(sim, t, wx));
  const crit = diags.filter((d) => d.crit.length);
  const v = {
    hazard: r0(100 * mean(diags.map((d) => d.hazard))),
    pNew: r0(100 * mean(diags.map((d) => d.pNew))),
    pWind: r0(100 * mean(diags.map((d) => d.pWind))),
    pPwl: r0(100 * mean(diags.map((d) => d.pPwl))),
    pWet: r0(100 * mean(diags.map((d) => d.pWet))),
    precip72: r0(wx.precip72), snow72: r0(wx.snow72), rain72: r0(wx.rain72),
    precip24: r0(wx.precip24), snow24: r0(wx.snow24), rain24: r0(wx.rain24),
    wind24: r0(wx.wind24), skiPen: r0(mean(diags.map((d) => d.skiPen))),
    critPwl: r1(mean(diags.map((d) => d.crit.length))),
    critPwlDist: r0(100 * crit.length / diags.length),
    critPwlDepth: crit.length ? r0(mean(crit.map((d) => d.crit[0].depth))) : null,
    lwc: r1(mean(diags.map((d) => d.lwcMax))), lwm: r1(mean(diags.map((d) => d.lwm))),
    hs: r0(mean(diags.map((d) => d.hs))), elev: site.z,
  };
  const daily = site.dl.map((d) => ({ t: d.t, snowCm: d.s, rainMm: d.r }));
  const text = summarize(diags, daily, tzOffset(t));
  let prof = null;
  if (withProfile) {
    prof = {
      A: site.sims.map((sim) => encodeProfile(sim)),
      W: diags.map((d) => d.weak.slice(0, 3).map((w) => [w.depth, w.cls, Math.round(w.burial), Math.round(w.p * 100), w.lemons])),
      hs: diags.map((d) => r0(d.hs)),
      p: diags.map((d) => [r0(100 * d.hazard), r0(100 * d.pNew), r0(100 * d.pWind), r0(100 * d.pPwl), r0(100 * d.pWet)]),
    };
  }
  return { v, text, prof };
}

// Snow height and problem indices per aspect, and the last 24 h of weather, for
// one forecast spread member at a snapshot hour.
function spreadSnap(site, t) {
  const sum = (a, n) => a.slice(-n).reduce((s, x) => s + x, 0);
  const wx = { precip24: sum(site.h.P, 24), snow24: sum(site.h.S, 24), rain24: sum(site.h.R, 24), precip72: sum(site.h.P, 72), snow72: sum(site.h.S, 72), rain72: sum(site.h.R, 72), wind24: site.h.U.length ? mean(site.h.U) : null };
  const diags = site.sims.map((sim) => diagnose(sim, t, wx));
  return {
    t, date: localDate(t), snow24: r0(wx.snow24), precip24: r0(wx.precip24), rain24: r0(wx.rain24),
    hs: diags.map((d) => r0(d.hs)),
    p: diags.map((d) => [r0(100 * d.hazard), r0(100 * d.pNew), r0(100 * d.pWind), r0(100 * d.pPwl), r0(100 * d.pWet)]),
  };
}

// Per layer (top-down): top depth (cm×10), class, hardness×10, T×10, grain size×10, density
function encodeProfile(sim) {
  const out = [];
  for (const x of layersTopDown(sim)) {
    out.push(Math.round(x.top * 1000), x.cls, Math.round(x.h * 10), Math.round(x.l.T * 10), Math.round(x.l.gs * 10), Math.round(x.l.m / x.l.d));
  }
  return out;
}

// ---------------------------------------------------------------------------
export async function runPipeline(deps, opts = {}) {
  const { store, fetchStationObs, fetchModel, cellElevations, nowHour } = deps;
  const log = opts.log || console.log;
  const maxAnalysisHours = opts.maxAnalysisHours ?? 24 * 45;
  const started = Date.now();
  const meta = await ensureMeta(store, cellElevations, log);
  const tNow = nowHour();
  let idx = (await store.get("state/index", { type: "json" })) || null;
  if (idx && (opts.reset || idx.modelVersion !== MODEL_VERSION)) {
    log(`re-running the season from ${meta.seasonStart} (model v${idx.modelVersion || 1} → v${MODEL_VERSION}${opts.reset ? ", reset" : ""})`);
    idx = null;
  }
  const seasonT0 = snapHour(meta.seasonStart) - 17; // local midnight-ish start
  const t0 = idx ? idx.t : Math.floor(seasonT0); // last completed hour
  const tFrom = t0 - HIST;

  // Station actuals
  const { obs, errors: obsErr } = await fetchStationObs(STATIONS, tNow - tFrom + 3);
  // Sensor baselines: refresh from this fetch when it holds enough warm hours.
  const baselines = (await store.get("baselines", { type: "json" })) || {};
  for (const [id, b] of Object.entries(hsBaselines(obs))) if (!baselines[id] || b.n >= baselines[id].n || b.n >= 72) baselines[id] = { ...b, at: new Date().toISOString() };
  await store.setJSON("baselines", baselines);
  const lastObs = STATIONS.map((s) => { const r = obs[s.id] || []; for (let i = r.length - 1; i >= 0; i--) if (ok(r[i].T)) return r[i].t; return null; }).filter(ok).sort((a, b) => a - b);
  const tObs = lastObs.length ? lastObs[Math.floor(lastObs.length / 2)] : tNow - 2;
  let tA = Math.min(tNow, tObs, t0 + maxAnalysisHours);
  if (tA < t0) tA = t0;

  // Forecast-model columns
  const today = localDate(tNow);
  const tEnd = snapHour(addDays(today, 2));
  const needDays = Math.ceil((tNow - tFrom) / 24) + 1;
  const pastDays = [2, 3, 7, 14, 21, 35, 62, 92].find((d) => d >= needDays) ?? 92;
  const nodesDef = modelNodes();
  const model = await fetchModel(nodesDef, pastDays, 4);
  if (!model.nodes.length) throw new Error("no forecast-model data");
  const modelStart = Math.min(...model.nodes.map((n) => n.t0));
  const modelEnd = Math.max(...model.nodes.map((n) => n.t0 + n.v.T.length - 1));

  // Time axis. The maps and point profiles are forecast to tEnd; the named
  // points' forecast spread runs on to SPREAD_HOURS after now.
  const start = Math.max(tFrom, modelStart);
  const end = Math.min(Math.max(tEnd, tNow + SPREAD_HOURS), modelEnd);
  const times = [];
  for (let t = start; t <= end; t++) times.push(t);
  const kIndex = (t) => t - start;
  if (tA > end) tA = end;
  const nodes = model.nodes.map((n) => {
    const v = {};
    for (const key of Object.keys(n.v)) v[key] = times.map((t) => { const j = t - n.t0; return j >= 0 && j < n.v[key].length ? n.v[key][j] : null; });
    return { ...n, v };
  });
  const stations = STATIONS.map((s) => {
    const o = { T: [], RH: [], U: [], HS: [], P: [] };
    const byT = new Map((obs[s.id] || []).map((r) => [r.t, r]));
    for (const t of times) {
      const r = t <= tA ? byT.get(t) : null;
      o.T.push(r ? r.T : null); o.RH.push(r ? r.RH : null); o.U.push(r ? r.U : null); o.HS.push(r ? r.HS : null); o.P.push(r ? r.P : null);
    }
    return { ...s, o, hsBase: baselines[s.id]?.base ?? 0 };
  });
  const kA = kIndex(tA);
  // If the model archive doesn't reach back to the last analysis hour, resume at its first hour.
  const a0 = Math.max(t0, start - 1);
  if (a0 > t0) log(`gap: model data starts ${a0 - t0} h after the last analysis hour`);
  const windows = snapshotWindows(times, kA, isSnapHour);
  // Per-station forecast bias learned from past analyses (reset with the season).
  const biasIn = idx ? await store.get("bias", { type: "json" }) : null;
  const F = prepareForcing({ times, nodes, stations, tA, windows, bias: biasIn, biasFrom: kIndex(a0) + 1 });
  await store.setJSON("bias", F.bias);
  const catchingUp = tNow - tA > 6;
  const doForecast = !catchingUp && (opts.forceForecast || !meta.forecastIssued || tNow - (meta.forecastHour || 0) >= 3 || tA - (meta.analysisHour || 0) >= 3 || !idx);
  log(`analysis ${new Date(t0 * 3.6e6).toISOString()} → ${new Date(tA * 3.6e6).toISOString()} (${tA - t0} h); forecast ${doForecast ? "to " + new Date(Math.min(tEnd, end) * 3.6e6).toISOString() : "skipped"}; model ${model.source}, past_days ${pastDays}`);

  // Snapshot hours
  const anaSnaps = times.filter((t) => t > a0 && t <= tA && isSnapHour(t));
  const fcSnaps = doForecast ? times.filter((t) => t > tA && t <= tEnd && isSnapHour(t)) : [];
  const fields = new Map();
  const newField = (t, kind) => ({ date: localDate(t), t, kind, issued: new Date().toISOString(), analysisHour: tA, props: Object.fromEntries(PROPS.map((p) => [p, new Array(meta.cells.length).fill(null)])), text: new Array(meta.cells.length).fill("") });
  for (const t of anaSnaps) fields.set(t, newField(t, "analysis"));
  for (const t of fcSnaps) fields.set(t, newField(t, "forecast"));

  // ---- Cells, in batches -------------------------------------------------
  const nB = Math.ceil(meta.cells.length / BATCH);
  const tStart = Date.now();
  for (let b = 0; b < nB; b++) {
    const cells = meta.cells.slice(b * BATCH, (b + 1) * BATCH);
    const saved = idx ? await store.get(`state/c${b}`, { type: "json" }) : null;
    const sites = cells.map((c, i) => (saved && saved.sites[i] && saved.sites[i].id === c.id ? unpackFull(saved.sites[i]) : initExtras(createSite({ id: c.id, lat: c.lat, lon: c.lon, z: c.z }))));
    for (let i = 0; i < sites.length; i++) {
      const site = sites[i], ci = b * BATCH + i;
      const W = F.weightsFor(site);
      for (let t = a0 + 1; t <= tA; t++) {
        advance(site, F.at(W, kIndex(t)));
        if (fields.has(t)) { closeDay(site, t); writeField(fields.get(t), ci, snapshot(site, t, false)); }
      }
      if (fcSnaps.length) {
        const fc = cloneFull(site);
        for (let t = tA + 1; t <= fcSnaps[fcSnaps.length - 1]; t++) {
          advance(fc, F.at(W, kIndex(t)));
          if (fields.has(t)) { closeDay(fc, t); writeField(fields.get(t), ci, snapshot(fc, t, false)); }
        }
      }
    }
    await store.setJSON(`state/c${b}`, { t: tA, sites: sites.map(packFull) });
  }
  const cellMs = Date.now() - tStart;

  // ---- Forecast spread at the named points ------------------------------
  // Each Wx Fx spread member's departure from the Canadian models at the point,
  // added to the station-corrected forcing (src/model/spread.js).
  let spread = null;
  if (doForecast && deps.fetchSpread) {
    const locs = [], locOf = new Map();
    for (const p of meta.points) if (p.kind === "named" && !locOf.has(`${p.lat},${p.lon}`)) { locOf.set(`${p.lat},${p.lon}`, locs.length); locs.push({ lat: p.lat, lon: p.lon }); }
    try { spread = { ...(await deps.fetchSpread(locs, SPREAD_MEMBERS.map((m) => m.id))), locOf }; }
    catch (e) { spread = { members: {}, source: "", errors: [e.message], locOf }; }
    for (const e of spread.errors) log(`spread: ${e}`);
  }
  const tH = Math.min(tA + SPREAD_HOURS, end);
  const val = (e, key, t) => { const j = t - e.t0, a = e.v[key]; return j >= 0 && j < a.length && ok(a[j]) ? a[j] : null; };
  // Raw member values at hour t, temperature moved to elevation z at the
  // standard 6.5 °C/km (the NAM feed is at its 12 km cell's height).
  const rawAt = (e, t, z) => {
    if (!e || !ok(val(e, "T", t))) return null;
    return { T: val(e, "T", t) + (ok(z) && ok(e.z) ? 0.0065 * (e.z - z) : 0), RH: val(e, "RH", t), U: val(e, "U", t), dir: val(e, "dir", t), P: val(e, "P", t), ghi: val(e, "ghi", t), cc: val(e, "cc", t) };
  };
  function runSpread(site, W, li) {
    const hrdps = spread.members[SPREAD_MEMBERS[0].id]?.[li], rdps = spread.members[SPREAD_MEMBERS[1].id]?.[li];
    const z = (hrdps || rdps)?.z;
    const T = [];
    for (let t = tA + 1; t <= tH; t++) T.push(t);
    const Fc = T.map((t) => F.at(W, kIndex(t)));
    const R = T.map((t) => rawAt(hrdps, t, z) || rawAt(rdps, t, z));
    const pScale = precipScale(Fc.map((f) => f.Pwx), R.map((r) => (r ? r.P : null)));
    // Daily 17:00 snapshots, and the end of the run when it is 6 h or more past the last one.
    const snaps = new Set(T.filter((t) => isSnapHour(t)));
    if (T.length && tH - Math.max(tA, ...snaps) >= 6) snaps.add(tH);
    const runs = [{ id: "control", short: "Corrected", e: null }];
    for (const M of SPREAD_MEMBERS) { const e = spread.members[M.id]?.[li]; if (e) runs.push({ id: M.id, short: M.short, e }); }
    return runs.map((run) => {
      let last = tH;
      if (run.e) { last = run.e.t0 - 1; run.e.v.T.forEach((x, j) => { if (ok(x)) last = run.e.t0 + j; }); }
      const fc = cloneFull(site), days = [];
      for (let i = 0; i < T.length && T[i] <= last; i++) {
        advance(fc, run.e ? memberForcing(Fc[i], R[i], rawAt(run.e, T[i], z), pScale) : Fc[i]);
        if (snaps.has(T[i])) { closeDay(fc, T[i]); days.push(spreadSnap(fc, T[i])); }
      }
      return { id: run.id, short: run.short, days };
    });
  }

  // ---- Named points and stations ----------------------------------------
  const savedP = idx ? await store.get("state/points", { type: "json" }) : null;
  const pmap = new Map((savedP?.sites || []).map((p) => [p.id, p]));
  const psites = meta.points.map((p) => (pmap.has(p.id) ? unpackFull(pmap.get(p.id)) : initExtras(createSite({ id: p.id, lat: p.lat, lon: p.lon, z: p.z }))));
  const pAna = new Map(), pFc = new Map();
  const hsCheck = [];
  for (let i = 0; i < psites.length; i++) {
    const site = psites[i], p = meta.points[i];
    const W = F.weightsFor(site);
    const stObs = p.kind === "station" ? new Map((obs[p.id] || []).map((r) => [r.t, r.HS])) : null;
    const days = [];
    for (let t = a0 + 1; t <= tA; t++) {
      advance(site, F.at(W, kIndex(t)));
      if (fields.has(t)) {
        closeDay(site, t);
        const s = snapshot(site, t, true);
        days.push({ t, date: localDate(t), ...s.prof, v: s.v, text: s.text, obsHS: stObs ? adjHS(stObs.get(t) ?? stObs.get(t - 1), baselines[p.id]) : undefined });
      }
    }
    pAna.set(p.id, days);
    const now = snapshot(site, tA, true);
    if (stObs) {
      let o = null;
      for (let dt = 0; dt <= 3 && o === null; dt++) o = stObs.get(tA - dt) ?? null;
      const b = baselines[p.id];
      hsCheck.push({ id: p.id, name: p.name, z: p.z, obsHS: ok(o) ? Math.round(adjHS(o, b)) : null, rawHS: ok(o) ? Math.round(o) : null, baseline: b ? b.base : null, modelHS: now.v ? Math.round(now.prof.hs[0] ?? 0) : null });
    }
    const fdays = [];
    if (fcSnaps.length) {
      const fc = cloneFull(site);
      for (let t = tA + 1; t <= fcSnaps[fcSnaps.length - 1]; t++) {
        advance(fc, F.at(W, kIndex(t)));
        if (fields.has(t)) { closeDay(fc, t); const s = snapshot(fc, t, true); fdays.push({ t, date: localDate(t), ...s.prof, v: s.v, text: s.text }); }
      }
    }
    const sp = spread && p.kind === "named" && spread.locOf.has(`${p.lat},${p.lon}`) ? runSpread(site, W, spread.locOf.get(`${p.lat},${p.lon}`)) : null;
    pFc.set(p.id, { now: { t: tA, ...now.prof, v: now.v, text: now.text }, days: fdays, ...(sp ? { spread: { analysisHour: tA, horizon: tH, source: spread.source, members: sp } } : {}) });
  }
  await store.setJSON("state/points", { t: tA, sites: psites.map(packFull) });

  // ---- Write outputs -----------------------------------------------------
  const issued = new Date().toISOString();
  for (const [t, fld] of fields) await store.setJSON(`field/${fld.date}`, fld);
  for (const p of meta.points) {
    const add = pAna.get(p.id);
    if (add && add.length) {
      const cur = (await store.get(`pts/${p.id}`, { type: "json" })) || { id: p.id, days: [] };
      const have = new Set(add.map((d) => d.t));
      cur.days = cur.days.filter((d) => !have.has(d.t)).concat(add).sort((a, b) => a.t - b.t);
      await store.setJSON(`pts/${p.id}`, cur);
    }
    const f = pFc.get(p.id);
    if (doForecast || !idx) await store.setJSON(`ptf/${p.id}`, { id: p.id, issued, analysisHour: tA, ...f });
    else {
      // Between forecast runs only the current state is refreshed; days and the spread stay.
      const prev = (await store.get(`ptf/${p.id}`, { type: "json" })) || { days: [] };
      await store.setJSON(`ptf/${p.id}`, { ...prev, id: p.id, analysisHour: tA, now: f.now });
    }
  }
  const anaDates = new Set(meta.dates.analysis);
  for (const t of anaSnaps) anaDates.add(localDate(t));
  meta.dates.analysis = [...anaDates].sort();
  if (doForecast) {
    meta.dates.forecast = fcSnaps.map((t) => localDate(t)).filter((d) => !anaDates.has(d));
    meta.forecastIssued = issued; meta.forecastHour = tNow;
  } else {
    meta.dates.forecast = meta.dates.forecast.filter((d) => !anaDates.has(d));
  }
  meta.analysisHour = tA;
  meta.updatedAt = issued;
  meta.modelVersion = MODEL_VERSION;
  await store.setJSON("meta", meta);
  await store.setJSON("state/index", { t: tA, updatedAt: issued, modelVersion: MODEL_VERSION });

  const status = {
    finishedAt: new Date().toISOString(), durationMs: Date.now() - started, cellMs,
    analysisFrom: t0, analysisTo: tA, forecastTo: fcSnaps.length ? fcSnaps[fcSnaps.length - 1] : null,
    catchingUp, doForecast, modelSource: model.source, pastDays,
    spread: spread ? { source: spread.source, members: Object.values(spread.members).filter((a) => a.some(Boolean)).length, horizon: tH, errors: spread.errors } : null,
    stationsReporting: lastObs.length, stationErrors: obsErr, modelErrors: model.errors,
    stations: F.stationDiagnostics(),
    lapse: Math.round(F.gamma[kA] * 10000) / 10,
    trend: F.trend,
    hsCheck,
  };
  const hist = (await store.get("status", { type: "json" }))?.history || [];
  hist.push({ at: status.finishedAt, ms: status.durationMs, a: [t0, tA], fc: doForecast });
  await store.setJSON("status", { ...status, history: hist.slice(-48) });
  log(`done in ${status.durationMs} ms (cells ${cellMs} ms)`);
  return status;
}

export function writeField(fld, ci, snap) {
  for (const p of PROPS) fld.props[p][ci] = snap.v[p];
  fld.text[ci] = snap.text;
}

// ---------------------------------------------------------------------------
// Diagnostic replay of one location from the season start to now, returning
// daily forcing and snow-depth rows (model flat vs station sensor). Used by
// /api/trace to check the forcing chain against a station.
export async function traceSite(deps, { id }, opts = {}) {
  const { store, fetchStationObs, fetchModel, cellElevations, nowHour } = deps;
  const meta = await ensureMeta(store, cellElevations, () => {});
  const p = meta.points.find((x) => x.id === id);
  if (!p) throw new Error(`unknown point ${id}`);
  const tNow = nowHour();
  const t0 = Math.floor(snapHour(meta.seasonStart) - 17);
  const tFrom = t0 - HIST;
  const { obs } = await fetchStationObs(STATIONS, tNow - tFrom + 3);
  const needDays = Math.ceil((tNow - tFrom) / 24) + 1;
  const pastDays = [2, 3, 7, 14, 21, 35, 62, 92].find((d) => d >= needDays) ?? 92;
  const model = await fetchModel(modelNodes(), pastDays, 4);
  const start = Math.max(tFrom, Math.min(...model.nodes.map((n) => n.t0)));
  const lastObs = STATIONS.map((s) => { const r = obs[s.id] || []; for (let i = r.length - 1; i >= 0; i--) if (ok(r[i].T)) return r[i].t; return null; }).filter(ok).sort((a, b) => a - b);
  const tA = Math.min(tNow, lastObs.length ? lastObs[Math.floor(lastObs.length / 2)] : tNow - 2);
  const times = [];
  for (let t = start; t <= tA; t++) times.push(t);
  const nodes = model.nodes.map((n) => {
    const v = {};
    for (const key of Object.keys(n.v)) v[key] = times.map((t) => { const j = t - n.t0; return j >= 0 && j < n.v[key].length ? n.v[key][j] : null; });
    return { ...n, v };
  });
  const tb = hsBaselines(obs);
  const stations = STATIONS.map((s) => {
    const o = { T: [], RH: [], U: [], HS: [], P: [] };
    const byT = new Map((obs[s.id] || []).map((r) => [r.t, r]));
    for (const t of times) { const r = byT.get(t); for (const k of Object.keys(o)) o[k].push(r ? r[k] : null); }
    return { ...s, o, hsBase: tb[s.id]?.base ?? 0 };
  });
  const kA = times.length - 1;
  const F = prepareForcing({ times, nodes, stations, tA, windows: snapshotWindows(times, kA, isSnapHour) });
  const Fraw = prepareForcing({ times, nodes, stations: [], tA, windows: [] }); // model first guess only
  const site = initExtras(createSite({ id: p.id, lat: p.lat, lon: p.lon, z: p.z }));
  const W = F.weightsFor(site), W0 = Fraw.weightsFor(site);
  const own = new Map((obs[p.id] || []).map((r) => [r.t, r]));
  const rows = [];
  let d = null;
  for (let t = Math.max(t0, start) + 1; t <= tA; t++) {
    const k = t - start;
    const f = F.at(W, k), f0 = Fraw.at(W0, k);
    advance(site, f);
    if (!d) d = { Tsum: 0, Tobs: 0, nTo: 0, n: 0, Traw: 0, P: 0, Praw: 0, snow: 0, rain: 0, sw: 0 };
    d.n++; d.Tsum += f.Ta; d.Traw += f0.Ta; d.P += f.P; d.Praw += f0.P; d.snow += f.P * f.sf; d.rain += f.P * (1 - f.sf); d.sw += f.ghi;
    const o = own.get(t);
    if (o && ok(o.T)) { d.Tobs += o.T; d.nTo++; }
    if (isSnapHour(t)) {
      const hs = site.sims.map((s) => Math.round(s.L.reduce((a, l) => a + l.d, 0) * 1000) / 10);
      rows.push({
        date: localDate(t), T: +(d.Tsum / d.n).toFixed(1), Traw: +(d.Traw / d.n).toFixed(1), Tobs: d.nTo ? +(d.Tobs / d.nTo).toFixed(1) : null,
        P: +d.P.toFixed(1), Praw: +d.Praw.toFixed(1), snowMm: +d.snow.toFixed(1), rainMm: +d.rain.toFixed(1), ghi: Math.round(d.sw / d.n),
        hsFlat: hs[0], hsNESW: hs.slice(1), obsHS: o && ok(o.HS) ? o.HS : null,
      });
      d = null;
    }
  }
  return { id: p.id, name: p.name, z: p.z, modelSource: model.source, rows };
}
