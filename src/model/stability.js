// Grain classification, hand hardness, weak-layer detection and avalanche-problem
// indices computed from a simulated profile.
import { SH, WET, FACET, WIND, density, theta } from "./snowpack.js";

export const CLASSES = ["PP", "DF", "RG", "FCxr", "FC", "DH", "SH", "MF", "MFcr"];
export const C = Object.fromEntries(CLASSES.map((c, i) => [c, i]));
// AVID-style five-colour legend groups.
export const GROUPS = ["PP/DF", "RG/FCxr", "SH/DH/FC", "MFcr", "MF"];
export const GROUP_OF = [0, 0, 1, 1, 2, 2, 2, 4, 3];
const PERSISTENT = new Set([C.FCxr, C.FC, C.DH, C.SH]);

export function classify(l) {
  if (l.mk & SH) return C.SH;
  if (theta(l) > 0.003) return C.MF;
  if (l.mk & WET) return C.MFcr;
  if (l.dd > 0.75) return C.PP;
  if (l.dd > 0.02) return C.DF;
  if (l.sp >= 0.5) return (l.mk & FACET) && l.sp < 0.75 ? C.FCxr : C.RG;
  return l.gs >= 1.8 ? C.DH : C.FC;
}

// Hand-hardness index (F=1, 4F=2, 1F=3, P=4, K=5, I=6) from density and grain form,
// after the linear density–hardness regressions of Geldsetzer & Jamieson (2000).
export function hardness(l, cls = classify(l)) {
  const r = density(l);
  let h;
  switch (cls) {
    case C.PP: h = (r - 45) / 36; break;
    case C.DF: h = (r - 65) / 36; break;
    case C.RG: h = (r - 91) / 84; break;
    case C.FCxr: h = (r - 100) / 60; break;
    case C.FC: h = Math.min(4, (r - 112) / 46); break;
    case C.DH: h = Math.min(3.5, (r - 185) / 25); break;
    case C.SH: h = 1; break;
    case C.MF: h = 1 + (r - 300) / 150; break;
    case C.MFcr: h = 4 + (r - 350) / 150; break;
    default: h = 2;
  }
  return Math.max(1, Math.min(6, h));
}

export const HARDNESS_LABELS = ["F", "4F", "1F", "P", "K", "I"];

const logistic = (x) => 1 / (1 + Math.exp(-x));

// Per-layer view of a sim, top-down, with depth of each layer's upper boundary.
export function layersTopDown(sim) {
  const out = [];
  let depth = 0;
  for (let i = sim.L.length - 1; i >= 0; i--) {
    const l = sim.L[i];
    const cls = classify(l);
    out.push({ i, l, cls, h: hardness(l, cls), top: depth, bottom: depth + l.d });
    depth += l.d;
  }
  return out;
}

// Structural instability of each persistent layer: threshold-sum ("lemons")
// approach of Schweizer & Jamieson (2007), turned into a probability-like
// index with a logistic curve centred between 4 and 5 lemons.
export function weakLayers(sim) {
  const td = layersTopDown(sim);
  const out = [];
  for (let k = 1; k < td.length; k++) {
    const w = td[k];
    if (!PERSISTENT.has(w.cls)) continue;
    const depthCm = w.top * 100;
    if (depthCm < 10) continue;
    const above = td[k - 1];
    const below = td[k + 1];
    let lem = 1; // persistent grain type
    if (w.l.gs >= 1.25) lem++;
    if (w.h <= 1.3) lem++;
    const dgs = Math.max(Math.abs(w.l.gs - above.l.gs), below ? Math.abs(w.l.gs - below.l.gs) : 0);
    if (dgs >= 0.75) lem++;
    const dh = Math.max(Math.abs(w.h - above.h), below ? Math.abs(w.h - below.h) : 0);
    if (dh >= 1.7) lem++;
    if (depthCm >= 18 && depthCm <= 94) lem++;
    // Slab: need a cohesive slab above; weaken the index for thin or very deep burial.
    let slabMass = 0;
    for (let j = 0; j < k; j++) slabMass += td[j].l.m;
    const slabRho = w.top > 0 ? slabMass / w.top : 0;
    const slabF = Math.min(1, Math.max(0, (depthCm - 12) / 18)) * Math.min(1, Math.max(0.2, (slabRho - 60) / 80)) *
      (depthCm > 150 ? Math.max(0.2, 1 - (depthCm - 150) / 100) : 1);
    const p = logistic(2.2 * (lem - 4.5)) * slabF;
    out.push({ depth: Math.round(depthCm), cls: w.cls, gs: w.l.gs, h: w.h, lemons: lem, p, burial: above.l.bd, formed: w.l.bd });
  }
  return out.sort((a, b) => b.p - a.p);
}

// Ski penetration depth (SNOWPACK's empirical 0.8 · 43.3 / ρ̄ with ρ̄ the mean
// density of the uppermost 30 cm), in cm.
export function skiPenetration(sim) {
  let m = 0, d = 0;
  for (let i = sim.L.length - 1; i >= 0 && d < 0.3; i--) {
    const l = sim.L[i];
    const take = Math.min(l.d, 0.3 - d);
    m += density(l) * take; d += take;
  }
  if (d <= 0) return 0;
  const rho = m / d;
  const hs = sim.L.reduce((s, l) => s + l.d, 0);
  return Math.round(Math.min(hs, 0.8 * 43.3 / Math.max(rho, 30)) * 100);
}

// Diagnostics for one sim at time t (epoch hours). `wx` carries forcing
// statistics for the preceding hours (rain24, rain72).
export function diagnose(sim, t, wx = {}) {
  const td = layersTopDown(sim);
  const hs = td.length ? td[td.length - 1].bottom : 0;
  let hn24 = 0, hn72 = 0, windSlab = 0, lwm = 0, lwcMax = 0, wetTopW = 0, wetTopD = 0;
  for (const x of td) {
    const age = t - x.l.bd;
    if (age <= 24 && !(x.l.mk & SH)) hn24 += x.l.d;
    if (age <= 72 && !(x.l.mk & SH)) hn72 += x.l.d;
    if ((x.l.mk & WIND) && age <= 96 && theta(x.l) < 0.001 && x.top < 1 && x.cls <= C.RG) windSlab += x.l.d;
    lwm += x.l.w;
    lwcMax = Math.max(lwcMax, theta(x.l) * 100);
    if (x.top < 0.5) { const dd = Math.min(x.l.d, 0.5 - x.top); wetTopW += theta(x.l) * 100 * dd; wetTopD += dd; }
  }
  const wl = weakLayers(sim);
  const crit = wl.filter((w) => w.p >= 0.7 && w.depth >= 18 && w.depth <= 150);
  const lwcIndex = wetTopD > 0 ? wetTopW / wetTopD / 3 : 0;
  const pNew = hs < 0.05 ? 0 : Math.max(logistic((hn24 * 100 - 20) / 4), logistic((hn72 * 100 - 30) / 6));
  const pWind = hs < 0.1 ? 0 : logistic((windSlab * 100 - 15) / 4);
  const pPwl = wl.length ? wl[0].p : 0;
  let pWet = hs < 0.05 ? 0 : logistic((lwcIndex - 0.8) / 0.15);
  if ((wx.rain24 || 0) > 5 && hs > 0.1) pWet = Math.max(pWet, logistic(((wx.rain24 || 0) - 8) / 3));
  const hazard = 1 - (1 - pNew) * (1 - pWind) * (1 - 0.6 * pPwl) * (1 - pWet);
  return {
    hs: hs * 100, hn24: hn24 * 100, hn72: hn72 * 100, windSlab: windSlab * 100,
    lwm, lwcMax, lwcIndex, skiPen: skiPenetration(sim),
    pNew, pWind, pPwl, pWet, hazard,
    weak: wl.slice(0, 4), crit,
    surface: td.length ? CLASSES[td[0].cls] : null,
  };
}

// ---- Text summary (AVID style) ----------------------------------------------
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function layerName(epochHour, cls, tzOffsetH = -7) {
  const d = new Date((epochHour + tzOffsetH) * 3600000);
  const day = d.getUTCDate();
  const part = day <= 10 ? "early" : day <= 20 ? "mid" : "late";
  return `${part}-${MON[d.getUTCMonth()]} ${CLASSES[cls]}`;
}
export function shortLayerLabel(epochHour, cls, depth, tzOffsetH = -7) {
  const d = new Date((epochHour + tzOffsetH) * 3600000);
  return `${MON[d.getUTCMonth()][0]}${d.getUTCDate()}-${CLASSES[cls]}-${Math.round(depth)}`;
}
export function dayName(epochHour, tzOffsetH = -7) {
  return DOW[new Date((epochHour + tzOffsetH) * 3600000).getUTCDay()];
}

// Summarise a set of sims (the aspects of one cell or point) plus the daily
// snowfall history at the location. `daily` is [{t, snowCm, rainMm}] newest last.
export function summarize(diags, daily, tzOffsetH = -7) {
  const parts = [];
  const hsList = diags.map((d) => d.hs);
  const hsMin = Math.min(...hsList), hsMax = Math.max(...hsList);
  if (daily && daily.length) {
    const last = [...daily].reverse().find((d) => d.snowCm >= 1);
    if (last) {
      parts.push(`${Math.round(last.snowCm)}cm snow on ${dayName(last.t, tzOffsetH)}.`);
      // Storm total: consecutive-ish days with snow ending at the last snow day.
      let tot = 0, start = null;
      for (let i = daily.indexOf(last); i >= 0; i--) {
        if (daily[i].snowCm >= 1) { tot += daily[i].snowCm; start = daily[i]; }
        else if (i > 0 && daily[i - 1].snowCm >= 1) continue; else break;
      }
      if (start && start !== last && tot > last.snowCm + 1) parts.push(`${Math.round(tot)}cm snow since ${dayName(start.t, tzOffsetH)}.`);
    }
    const rain = daily.slice(-3).reduce((s, d) => s + d.rainMm, 0);
    if (rain >= 2) parts.push(`${Math.round(rain)}mm rain in 72h.`);
  }
  const withCrit = diags.filter((d) => d.crit.length);
  if (withCrit.length) {
    const pct = Math.round(100 * withCrit.length / diags.length);
    const depths = withCrit.map((d) => d.crit[0].depth);
    const avg = Math.round(depths.reduce((s, x) => s + x, 0) / depths.length);
    // Group critical layers across aspects by burial day.
    const groups = new Map();
    for (const d of withCrit) for (const c of d.crit) {
      const key = Math.round(c.burial / 24);
      const g = groups.get(key) || { burial: c.burial, cls: c.cls, depths: [] };
      g.depths.push(c.depth); groups.set(key, g);
    }
    const names = [...groups.values()].sort((a, b) => a.burial - b.burial).slice(0, 3).map((g) => {
      const lo = Math.min(...g.depths), hi = Math.max(...g.depths);
      const r = (x) => Math.round(x / 10) * 10;
      return `${layerName(g.burial, g.cls, tzOffsetH)} ${r(lo) === r(hi) ? r(lo) : `${r(lo)}-${r(hi)}`}cm`;
    });
    parts.push(`Unstable pwl in ${pct}% of profiles at avg ${avg}cm (${names.join(", ")}).`);
  } else {
    const anyPwl = diags.some((d) => d.weak.length && d.weak[0].p >= 0.3);
    if (anyPwl) parts.push("Buried persistent grains present, structure not critical.");
  }
  const wet = diags.filter((d) => d.pWet >= 0.5).length;
  if (wet) parts.push(`Wet snow in ${Math.round(100 * wet / diags.length)}% of profiles.`);
  const sh = diags.filter((d) => d.surface === "SH").length;
  if (sh) parts.push("Surface hoar on the surface.");
  if (hsMax < 1) parts.push("No snow.");
  else parts.push(`HS ${Math.round(hsMin / 10) * 10 === Math.round(hsMax / 10) * 10 ? Math.round(hsMin) : `${Math.round(hsMin)}-${Math.round(hsMax)}`}cm.`);
  return parts.join(" ");
}
