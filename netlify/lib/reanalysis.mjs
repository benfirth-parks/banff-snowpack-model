// Historical seasons ("reanalysis"): the same snowpack model re-run through
// past winters from archived HRDPS output (Open-Meteo Historical Forecast API),
// corrected with whatever station actuals the Rockies Weather Data Explorer
// archive holds for that period. For 2023-24 → 2025-26 that is air
// temperature and snow height (the imported FTS CSV). There is no forecast
// step. Each season is processed in chunks so no single run hits a time limit;
// progress is kept in `seasons/{id}/job` and in the `seasons` registry.
import { STATIONS, modelNodes } from "../../src/model/domain.js";
import { prepareForcing, snapshotWindows } from "../../src/model/forcing.js";
import { createSite } from "../../src/model/site.js";
import { localDate, snapHour, isSnapHour } from "../../src/model/time.js";
import {
  BATCH, HIST, PROPS, ok, ensureMeta, initExtras, packFull, unpackFull, advance, closeDay, snapshot, writeField,
} from "./pipeline.mjs";

export const SEASONS = [
  { id: "2025-26", start: "2025-09-01", end: "2026-06-30" },
  { id: "2024-25", start: "2024-09-01", end: "2025-06-30" },
  { id: "2023-24", start: "2023-09-01", end: "2024-06-30" },
];
const CHUNK_HOURS = 24 * 31;

const seasonT0 = (s) => Math.floor(snapHour(s.start) - 17);   // local midnight at season start
const seasonT1 = (s) => snapHour(s.end);                       // 17:00 local on the last day
const iso = (t) => new Date(t * 3600000).toISOString().slice(0, 10);

export async function getRegistry(store) {
  let reg = await store.get("seasons", { type: "json" });
  if (!reg) {
    reg = { list: SEASONS.map((s) => ({ ...s, status: "queued", progress: 0, dates: [], updatedAt: null })) };
    await store.setJSON("seasons", reg);
  }
  // Seasons added to SEASONS later are appended as queued.
  for (const s of SEASONS) if (!reg.list.find((x) => x.id === s.id)) reg.list.push({ ...s, status: "queued", progress: 0, dates: [], updatedAt: null });
  return reg;
}

export async function updateRegistry(store, id, patch) {
  const reg = await getRegistry(store);
  const e = reg.list.find((x) => x.id === id);
  Object.assign(e, patch, { updatedAt: new Date().toISOString() });
  await store.setJSON("seasons", reg);
  return reg;
}

// Pull a season's station actuals out of the explorer archive once and keep a
// compact hourly copy (the explorer only answers "last N hours").
async function stageObs(store, season, fetchStationObs, nowHour, log) {
  const T0 = seasonT0(season) - HIST, T1 = seasonT1(season);
  const n = T1 - T0 + 1;
  const hours = nowHour() - T0 + 24;
  const stations = {};
  const coverage = {};
  for (let i = 0; i < STATIONS.length; i += 4) {
    const group = STATIONS.slice(i, i + 4);
    const { obs, errors } = await fetchStationObs(group, hours);
    if (errors.length) log(`stage: ${errors.join("; ")}`);
    for (const s of group) {
      const a = { T: new Array(n).fill(null), RH: new Array(n).fill(null), U: new Array(n).fill(null), HS: new Array(n).fill(null), P: new Array(n).fill(null) };
      let cT = 0, cHS = 0, cRH = 0, cU = 0;
      for (const r of obs[s.id] || []) {
        const k = r.t - T0;
        if (k < 0 || k >= n) continue;
        a.T[k] = r.T; a.RH[k] = r.RH; a.U[k] = r.U; a.HS[k] = r.HS; a.P[k] = r.P;
        if (ok(r.T)) cT++; if (ok(r.HS)) cHS++; if (ok(r.RH)) cRH++; if (ok(r.U)) cU++;
      }
      stations[s.id] = a;
      coverage[s.id] = { T: Math.round(100 * cT / n), HS: Math.round(100 * cHS / n), RH: Math.round(100 * cRH / n), U: Math.round(100 * cU / n) };
    }
  }
  await store.setJSON(`seasons/${season.id}/obs`, { t0: T0, n, stations });
  return coverage;
}

// Run one chunk (≤ CHUNK_HOURS) of a season. Returns { done, t }.
export async function runSeasonChunk(deps, seasonId, opts = {}) {
  const { store, fetchStationObs, fetchModelHistory, fetchElevations, nowHour } = deps;
  const log = opts.log || console.log;
  const season = SEASONS.find((s) => s.id === seasonId);
  if (!season) throw new Error(`unknown season ${seasonId}`);
  const P = `seasons/${season.id}/`;
  const meta = await ensureMeta(store, fetchElevations, log);
  let job = (await store.get(`${P}job`, { type: "json" })) || { t: seasonT0(season), dates: [], started: new Date().toISOString() };
  const T1 = seasonT1(season);
  if (job.t >= T1) return { done: true, t: job.t };
  await updateRegistry(store, season.id, { status: "running" });

  if (!job.coverage) {
    log(`${season.id}: staging station actuals`);
    job.coverage = await stageObs(store, season, fetchStationObs, nowHour, log);
    await store.setJSON(`${P}job`, job);
  }
  const staged = await store.get(`${P}obs`, { type: "json" });

  const t0 = job.t;
  const tA = Math.min(T1, t0 + (opts.chunkHours || CHUNK_HOURS));
  const start = t0 - HIST;
  const model = await fetchModelHistory(modelNodes(), iso(start), iso(tA));
  if (!model.nodes.length) throw new Error("no archived model data");
  const times = [];
  for (let t = start; t <= tA; t++) times.push(t);
  const kIndex = (t) => t - start;
  const nodes = model.nodes.map((n) => {
    const v = {};
    for (const key of Object.keys(n.v)) v[key] = times.map((t) => { const j = t - n.t0; return j >= 0 && j < n.v[key].length ? n.v[key][j] : null; });
    return { ...n, v };
  });
  const stations = STATIONS.map((s) => {
    const a = staged.stations[s.id];
    const o = { T: [], RH: [], U: [], HS: [], P: [] };
    for (const t of times) {
      const k = t - staged.t0;
      for (const key of Object.keys(o)) o[key].push(a && k >= 0 && k < staged.n ? a[key][k] : null);
    }
    return { ...s, o };
  });
  const kA = kIndex(tA);
  const F = prepareForcing({ times, nodes, stations, tA, windows: snapshotWindows(times, kA, isSnapHour) });
  const snaps = times.filter((t) => t > t0 && t <= tA && isSnapHour(t));
  const fields = new Map(snaps.map((t) => [t, {
    date: localDate(t), t, kind: "reanalysis", season: season.id, issued: new Date().toISOString(),
    props: Object.fromEntries(PROPS.map((p) => [p, new Array(meta.cells.length).fill(null)])), text: new Array(meta.cells.length).fill(""),
  }]));
  log(`${season.id}: ${iso(t0)} → ${iso(tA)} (${tA - t0} h), ${snaps.length} days, model ${model.source}`);

  const fresh = t0 === seasonT0(season);
  const nB = Math.ceil(meta.cells.length / BATCH);
  for (let b = 0; b < nB; b++) {
    const cells = meta.cells.slice(b * BATCH, (b + 1) * BATCH);
    const saved = fresh ? null : await store.get(`${P}state/c${b}`, { type: "json" });
    const sites = cells.map((c, i) => (saved && saved.sites[i] && saved.sites[i].id === c.id ? unpackFull(saved.sites[i]) : initExtras(createSite({ id: c.id, lat: c.lat, lon: c.lon, z: c.z }))));
    for (let i = 0; i < sites.length; i++) {
      const site = sites[i], ci = b * BATCH + i;
      const W = F.weightsFor(site);
      for (let t = t0 + 1; t <= tA; t++) {
        advance(site, F.at(W, kIndex(t)));
        if (fields.has(t)) { closeDay(site, t); writeField(fields.get(t), ci, snapshot(site, t, false)); }
      }
    }
    await store.setJSON(`${P}state/c${b}`, { t: tA, sites: sites.map(packFull) });
  }

  const savedP = fresh ? null : await store.get(`${P}state/points`, { type: "json" });
  const pmap = new Map((savedP?.sites || []).map((p) => [p.id, p]));
  const psites = meta.points.map((p) => (pmap.has(p.id) ? unpackFull(pmap.get(p.id)) : initExtras(createSite({ id: p.id, lat: p.lat, lon: p.lon, z: p.z }))));
  for (let i = 0; i < psites.length; i++) {
    const site = psites[i], p = meta.points[i];
    const W = F.weightsFor(site);
    const hsObs = p.kind === "station" ? staged.stations[p.id]?.HS : null;
    const days = [];
    for (let t = t0 + 1; t <= tA; t++) {
      advance(site, F.at(W, kIndex(t)));
      if (fields.has(t)) {
        closeDay(site, t);
        const s = snapshot(site, t, true);
        const k = t - staged.t0;
        days.push({ t, date: localDate(t), ...s.prof, v: s.v, text: s.text, obsHS: hsObs ? (hsObs[k] ?? hsObs[k - 1] ?? null) : undefined });
      }
    }
    if (days.length) {
      const cur = (fresh ? null : await store.get(`${P}pts/${p.id}`, { type: "json" })) || { id: p.id, season: season.id, days: [] };
      const have = new Set(days.map((d) => d.t));
      cur.days = cur.days.filter((d) => !have.has(d.t)).concat(days).sort((a, b) => a.t - b.t);
      await store.setJSON(`${P}pts/${p.id}`, cur);
    }
  }
  await store.setJSON(`${P}state/points`, { t: tA, sites: psites.map(packFull) });
  for (const f of fields.values()) await store.setJSON(`${P}field/${f.date}`, f);

  job.t = tA;
  job.dates = [...new Set([...job.dates, ...[...fields.values()].map((f) => f.date)])].sort();
  job.updatedAt = new Date().toISOString();
  job.modelSource = model.source;
  if (model.errors.length) job.modelErrors = model.errors.slice(-5);
  const done = tA >= T1;
  if (done) job.finished = job.updatedAt;
  await store.setJSON(`${P}job`, job);
  const progress = Math.round(100 * (tA - seasonT0(season)) / (T1 - seasonT0(season)));
  await updateRegistry(store, season.id, { status: done ? "done" : "running", progress, dates: job.dates, coverage: job.coverage, modelSource: model.source });
  return { done, t: tA };
}

// Restart a season from scratch (e.g. after a model change).
export async function resetSeason(store, seasonId) {
  await store.delete(`seasons/${seasonId}/job`);
  await updateRegistry(store, seasonId, { status: "queued", progress: 0, dates: [] });
}

export function nextSeasonToRun(reg, staleMinutes = 20) {
  const now = Date.now();
  const running = reg.list.find((s) => s.status === "running");
  if (running) {
    const age = running.updatedAt ? (now - Date.parse(running.updatedAt)) / 60000 : Infinity;
    return age > staleMinutes ? running.id : null; // stalled → resume
  }
  const q = reg.list.find((s) => s.status === "queued" || (s.status === "error" && (s.errors || 0) < 3));
  return q ? q.id : null;
}
