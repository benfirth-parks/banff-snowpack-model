// A compact multilayer snow model in the spirit of SNOWPACK / Crocus.
//
// One "sim" is a 1-D snow column (flat field or a virtual 38° slope). Layers are
// stored bottom → top. Each layer carries ice mass m (kg/m²), liquid water mass w
// (kg/m²), thickness d (m), temperature T (°C), the Brun/Crocus microstructure
// state variables dendricity dd (0–1) and sphericity sp (0–1), grain size gs (mm),
// birth time bd (epoch hours, UTC) and a marker bit field mk.
//
// Processes, per hourly step (the energy balance is sub-stepped):
//   • snowfall (Crocus new-snow density/dendricity from air temperature + wind)
//   • wind redistribution by aspect (loading during snowfall + drift of loose snow)
//   • rain (liquid water + advected heat)
//   • surface energy balance: shortwave (age-dependent albedo), longwave,
//     stability-corrected sensible and latent heat, rain heat
//   • implicit heat conduction through the layers, 0 °C ground below
//   • melt, refreeze, bucket percolation with irreducible water content
//   • sublimation / deposition, including surface-hoar growth and destruction
//   • settlement (Crocus viscosity + Anderson destructive metamorphism)
//   • grain metamorphism: dendricity, sphericity and grain-size rates driven by
//     temperature, temperature gradient and liquid water
//   • layer merging to keep the column tractable
//
// It is a deliberately small model, not SLF's SNOWPACK. Every rate below is
// documented so the output can be checked against field observations.

export const WIND = 1;   // deposited or broken by wind (wind-affected)
export const SH = 2;     // surface hoar (at surface or buried)
export const WET = 4;    // has been wet → melt-freeze crust once refrozen
export const FACET = 8;  // has faceted at some point (for FCxr)
export const RAIN = 16;  // rain-affected (rain crust once refrozen)
export const DHM = 32;   // has grown depth hoar (faceted to ≥ 1.8 mm)

const LF = 3.34e5;      // latent heat of fusion, J/kg
const LS = 2.834e6;     // latent heat of sublimation, J/kg
const LV = 2.501e6;     // latent heat of vaporisation, J/kg
const CI = 2100;        // heat capacity of ice, J/kg/K
const CW = 4180;        // heat capacity of water, J/kg/K
const SIGMA = 5.670e-8;
const EPS_SNOW = 0.98;
const RHO_ICE = 917;
const G = 9.81;
const CP_AIR = 1005;
const CH_NEUTRAL = 0.0024;  // neutral bulk transfer coefficient, z0 = 1 mm, 10 m wind / 2 m temp
const GROUND_R = 0.25;      // thermal resistance (m²K/W) between snow base and the 0 °C ground
const MAX_LAYERS = 48;
const SUBSTEPS = 2;

// Scratch arrays for the tridiagonal solver (no per-step allocation).
const SZ = 160;
const tA = new Float64Array(SZ), tB = new Float64Array(SZ), tC = new Float64Array(SZ);
const tR = new Float64Array(SZ), tX = new Float64Array(SZ), tGi = new Float64Array(SZ);

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const density = (l) => (l.d > 0 ? l.m / l.d : 0);
export const theta = (l) => (l.d > 0 ? l.w / (1000 * l.d) : 0);

export function conductivity(rho) {
  // Calonne et al. (2011) effective thermal conductivity of snow.
  return Math.max(0.03, 2.5e-6 * rho * rho - 1.23e-4 * rho + 0.024);
}

function esatWater(T) { return 611.2 * Math.exp(17.67 * T / (T + 243.5)); }
function esatIce(T) { return 611.15 * Math.exp(22.452 * T / (272.55 + T)); }

export function createSim({ lat, lon, z, slope = 0, aspect = 0 }) {
  return { lat, lon, z, slope, aspect, L: [], Ts: 0, runoff: 0, t: null };
}

function heatCap(l) { return l.m * CI + l.w * CW; }

function mergeInto(a, b) {
  // Merge layer b into a (mass-weighted), conserving mass and energy.
  const ca = heatCap(a), cb = heatCap(b);
  const m = a.m + b.m;
  if (m <= 0) { a.d += b.d; return a; }
  const fa = a.m / m, fb = b.m / m;
  a.T = ca + cb > 0 ? (ca * a.T + cb * b.T) / (ca + cb) : a.T;
  a.dd = fa * a.dd + fb * b.dd;
  a.sp = fa * a.sp + fb * b.sp;
  a.gs = fa * a.gs + fb * b.gs;
  a.bd = fa * a.bd + fb * b.bd;
  a.m = m; a.w += b.w; a.d += b.d;
  a.mk = (a.mk | b.mk) & ~SH;
  return a;
}

export function newSnowDensity(Ta, U) {
  // Crocus (Vionnet et al. 2012): 109 + 6 (Ta − Tfus) + 26 √U, kg/m³
  return clamp(109 + 6 * Math.min(Ta, 1) + 26 * Math.sqrt(Math.max(0, U)), 50, 250);
}

function addSnow(sim, mass, Ta, U, t, windDeposit = false) {
  if (!(mass > 0)) return;
  let rho, dd, sp, gs, mk;
  if (windDeposit) {
    rho = clamp(230 + 8 * (U - 7), 200, 330); dd = 0.1; sp = 0.65; gs = 0.25; mk = WIND;
  } else {
    rho = newSnowDensity(Ta, U);
    dd = clamp(1.29 - 0.17 * U, 0.2, 1);        // Crocus: wind fragments crystals
    sp = clamp(0.08 * U + 0.38, 0.5, 0.9);
    gs = 0.3; mk = U > 6 ? WIND : 0;
  }
  const T = Math.min(Ta, 0);
  const layer = { d: mass / rho, m: mass, w: 0, T, dd, sp, gs, bd: t, mk };
  const L = sim.L;
  let top = L[L.length - 1];
  // Tiny surface hoar (< ~2 mm) is not preserved as a distinct layer when buried.
  if (top && (top.mk & SH) && top.gs < 2) {
    top.mk &= ~SH; top.mk |= FACET; top.sp = 0.3; top.gs = Math.min(top.gs, 1.2);
    if (L.length > 1) { mergeInto(L[L.length - 2], L.pop()); L[L.length - 1].mk |= FACET; }
    top = L[L.length - 1];
  }
  if (top && !(top.mk & SH) && (top.mk & WIND) === (mk & WIND) && t - top.bd < 3 && top.d < 0.03 && top.dd >= 0.5 * dd && theta(top) < 0.003) {
    mergeInto(top, layer);
    top.bd = Math.max(top.bd, t - 1);
  } else {
    L.push(layer);
  }
}

function erode(sim, mass) {
  // Remove up to `mass` kg/m² of loose, dry surface snow. Returns mass removed.
  const L = sim.L;
  let left = mass;
  while (left > 0 && L.length) {
    const top = L[L.length - 1];
    const rho = density(top);
    const loose = theta(top) < 0.001 && !(top.mk & WET) && (top.dd > 0.2 || rho < 180 || (top.mk & SH));
    if (!loose) break;
    if (top.m <= left) { left -= top.m; L.pop(); }
    else { const f = (top.m - left) / top.m; top.m -= left; top.d *= f; top.w *= f; left = 0; }
  }
  return mass - left;
}

export function erodibleMass(sim) {
  let m = 0;
  for (let i = sim.L.length - 1; i >= 0; i--) {
    const l = sim.L[i];
    if (theta(l) < 0.001 && !(l.mk & WET) && (l.dd > 0.2 || density(l) < 180)) m += l.m; else break;
  }
  return m;
}

export function driftThreshold(sim) {
  const top = sim.L[sim.L.length - 1];
  if (!top || theta(top) > 0.001 || (top.mk & WET)) return Infinity;
  if (top.dd > 0.5 && density(top) < 150) return 5;
  if (top.dd > 0.2 || density(top) < 180) return 7;
  return Infinity;
}

// ---------------------------------------------------------------------------
// Energy balance + conduction for one sub-step.
function energyStep(sim, f, dt) {
  const L = sim.L;
  const n = L.length;
  if (!n) return { melt: 0, dep: 0, absSW: 0 };
  const top = L[n - 1];
  const Ta = f.Ta, TaK = Ta + 273.15;
  const U = Math.max(1, f.U);
  const p = 101325 * Math.exp(-sim.z / 8434);
  const rhoA = p / (287.05 * TaK);
  const ea = (f.RH / 100) * esatWater(Ta);
  const qa = 0.622 * ea / p;

  // Albedo from the age / wetness of the surface layer.
  const ageD = Math.max(0, (f.t - top.bd) / 24);
  const wetTop = theta(top) > 0.001;
  let alb = (top.mk & SH) ? 0.9 : wetTop ? 0.5 + 0.4 * Math.exp(-ageD / 2) : 0.7 + 0.2 * Math.exp(-ageD / 6);
  const hs = sim.L.reduce((s, l) => s + l.d, 0);
  // Very thin snow lets the ground show through (fresh snow is optically thick at ~3 cm).
  if (hs < 0.03) alb = 0.2 + (alb - 0.2) * hs / 0.03;
  const absSW = (1 - alb) * Math.max(0, f.sw);

  const Ts0 = Math.min(0, sim.Ts);
  const Ts0K = Ts0 + 273.15;
  const Ri = G * 10 * (Ta - Ts0) / (TaK * U * U);
  const fs = Ri > 0 ? Math.max(0.08, 1 / (1 + 10 * Ri)) : Math.min(2, Math.sqrt(1 - 16 * Ri));
  const ch = CH_NEUTRAL * fs;
  const H0 = rhoA * CP_AIR * ch * U * (Ta - Ts0);
  const dH = -rhoA * CP_AIR * ch * U;
  const qs0 = 0.622 * esatIce(Ts0) / p;
  const dqs = qs0 * 22.452 * 272.55 / ((272.55 + Ts0) * (272.55 + Ts0));
  const LE0 = rhoA * LS * ch * U * (qa - qs0);
  const dLE = -rhoA * LS * ch * U * dqs;
  const LWo = EPS_SNOW * SIGMA * Ts0K ** 4;
  const dLW = -4 * EPS_SNOW * SIGMA * Ts0K ** 3;
  const rainHeat = (f.rain || 0) / 3600 * CW * (Math.max(Ta, 0) - Ts0);
  const F0 = absSW + EPS_SNOW * f.lw - LWo + H0 + LE0 + rainHeat;
  const F1 = dLW + dH + dLE;

  const kTop = conductivity(density(top));
  const Gs = 2 * kTop / Math.max(top.d, 0.002);

  // Tridiagonal system (backward Euler).
  for (let i = 0; i < n - 1; i++) {
    const a = L[i], b = L[i + 1];
    tGi[i] = 2 / (Math.max(a.d, 1e-3) / conductivity(density(a)) + Math.max(b.d, 1e-3) / conductivity(density(b)));
  }
  const bot = L[0];
  const Gb = 1 / (Math.max(bot.d, 1e-3) / (2 * conductivity(density(bot))) + GROUND_R);

  const solve = (aFlux, bFlux) => {
    for (let i = 0; i < n; i++) {
      const Ci = Math.max(heatCap(L[i]), 50) / dt;
      const gL = i === 0 ? Gb : tGi[i - 1];
      const gU = i === n - 1 ? 0 : tGi[i];
      tA[i] = i === 0 ? 0 : -gL;
      tC[i] = i === n - 1 ? 0 : -gU;
      tB[i] = Ci + gL + gU;
      tR[i] = Ci * L[i].T; // ground at 0 °C adds Gb·0
    }
    tB[n - 1] -= bFlux;
    tR[n - 1] += aFlux;
    // Thomas algorithm
    for (let i = 1; i < n; i++) {
      const mlt = tA[i] / tB[i - 1];
      tB[i] -= mlt * tC[i - 1];
      tR[i] -= mlt * tR[i - 1];
    }
    tX[n - 1] = tR[n - 1] / tB[n - 1];
    for (let i = n - 2; i >= 0; i--) tX[i] = (tR[i] - tC[i] * tX[i + 1]) / tB[i];
  };

  const denom = Gs - F1;
  solve(Gs * (F0 - F1 * Ts0) / denom, Gs * F1 / denom);
  let Ts = (F0 - F1 * Ts0 + Gs * tX[n - 1]) / denom;
  if (Ts > 0) {
    Ts = 0;
    solve(F0 + F1 * (0 - Ts0), 0);
  }
  for (let i = 0; i < n; i++) L[i].T = tX[i];
  sim.Ts = Math.min(Ts, 0);

  // Phase change: melt layers above 0 °C, refreeze water in layers below 0 °C.
  let melt = 0;
  for (let i = n - 1; i >= 0; i--) {
    const l = L[i];
    if (l.T > 0) {
      const E = heatCap(l) * l.T;
      const mm = Math.min(l.m, E / LF);
      const rest = E - mm * LF;
      const f0 = l.m > 0 ? (l.m - mm) / l.m : 0;
      l.m -= mm; l.w += mm; l.d *= f0; l.T = 0; melt += mm;
      if (l.m <= 1e-6 && i > 0) { L[i - 1].w += l.w; L[i - 1].T += rest / Math.max(heatCap(L[i - 1]), 50); l.w = 0; }
    } else if (l.T < 0 && l.w > 0) {
      const C = heatCap(l);
      const fr = Math.min(l.w, C * -l.T / LF);
      l.w -= fr; l.m += fr;
      l.T = l.w > 1e-9 ? 0 : Math.min(0, l.T + fr * LF / C);
    }
  }
  // Sublimation / deposition at the final surface temperature.
  const LE = LE0 + dLE * (sim.Ts - Ts0);
  const dep = LE / LS * dt; // kg/m², + deposition, − sublimation
  return { melt, dep, absSW, Ts: sim.Ts };
}

function percolate(sim) {
  const L = sim.L;
  let carry = 0;
  for (let i = L.length - 1; i >= 0; i--) {
    const l = L[i];
    l.w += carry; carry = 0;
    const pore = Math.max(0, 1 - density(l) / RHO_ICE);
    const cap = Math.min(0.03, 0.9 * pore) * 1000 * l.d;
    if (l.w > cap) { carry = l.w - cap; l.w = cap; }
    if (l.w > 1e-6) { l.mk |= WET; }
  }
  sim.runoff += carry;
}

function settle(sim, dt) {
  const L = sim.L;
  let load = 0;
  for (let i = L.length - 1; i >= 0; i--) {
    const l = L[i];
    const own = l.m + l.w;
    const sigma = G * (load + 0.5 * own);
    load += own;
    const rho = density(l);
    if (rho <= 0 || l.d <= 0) continue;
    const Tk = l.T + 273.15;
    const th = theta(l);
    // Crocus viscosity (Vionnet et al. 2012)
    const f1 = 1 / (1 + 60 * th);
    const f2 = Math.min(4, Math.exp(Math.min(0.4, l.gs - 0.2) / 0.1));
    const eta = f1 * f2 * 7.62237e6 * (rho / 250) * Math.exp(0.1 * (273.15 - Tk) + 0.023 * rho);
    let rate = sigma / eta;
    // Anderson (1976) destructive metamorphism of new snow
    if (l.dd > 0) {
      const c3 = rho <= 150 ? 1 : Math.exp(-0.046 * (rho - 150));
      const c4 = th > 0 ? 2 : 1;
      rate += 2.777e-6 * c3 * c4 * Math.exp(-0.04 * (273.15 - Tk));
    }
    const fac = Math.max(0.6, 1 - rate * dt);
    const nd = l.d * fac;
    if (l.m / nd < 0.95 * RHO_ICE) l.d = nd;
  }
}

function metamorphism(sim, dtDays) {
  const L = sim.L, n = L.length;
  for (let i = 0; i < n; i++) {
    const l = L[i];
    const th = theta(l);
    if (l.mk & SH) {
      if (th > 0.001) { l.mk &= ~SH; l.mk |= WET; l.dd = 0; l.sp = 0.6; }
      continue; // buried surface hoar is persistent
    }
    const k = conductivity(density(l));
    const Tup = i === n - 1 ? sim.Ts : L[i + 1].T;
    const zUp = i === n - 1 ? l.d / 2 : (l.d + L[i + 1].d) / 2;
    const gUp = (Tup - l.T) / Math.max(zUp, 0.002);
    let gDn;
    if (i === 0) {
      // Gradient in the lower half of the bottom layer, from the heat flux to the 0 °C ground.
      const Gb = 1 / (Math.max(l.d, 1e-3) / (2 * k) + GROUND_R);
      gDn = Gb * l.T / k;
    } else {
      gDn = (l.T - L[i - 1].T) / Math.max((l.d + L[i - 1].d) / 2, 0.002);
    }
    const TG = Math.abs((gUp + gDn) / 2);
    const Tk = Math.min(273.15, l.T + 273.15);
    const fT = Math.exp(-6000 / Tk) / Math.exp(-6000 / 268.15);
    if (th > 0.001) {
      // Wet metamorphism: fast rounding and grain growth (Crocus: θ³/16 per day)
      const tp = th * 100;
      const r = Math.min(5, tp * tp * tp / 16 + 0.3);
      l.dd = Math.max(0, l.dd - r * dtDays);
      l.sp = Math.min(1, l.sp + r * dtDays);
      l.gs = Math.min(3, l.gs + 0.04 * (1 + tp) * dtDays);
      l.mk |= WET;
      continue;
    }
    // Temperature-gradient metamorphism. Below ~5 K/m grains round; between
    // 5 and 10 K/m they are transitional; above ~7 K/m they facet, faster in
    // light snow and at warmer temperatures. Very steep gradients in thin
    // near-surface layers are capped so grain growth stays physical.
    const fRho = clamp(1.4 - density(l) / 400, 0.4, 1.4);
    const tg = Math.min(TG, 60);
    const rRound = (1 / 15) * fT * clamp((10 - tg) / 5, 0, 1);
    const xs = clamp((tg - 7) / 8, 0, 3) ** 0.7;
    const rFacet = 0.1 * fT * fRho * xs;
    if (l.dd > 0) {
      l.dd -= (1 / 7) * fT * (tg > 5 ? (tg / 5) ** 0.4 : 1) * dtDays;
      l.sp += (rRound * 1.25 - rFacet) * dtDays;
      if (l.dd <= 0) { l.dd = 0; l.gs = Math.max(l.gs, 0.35 + 0.15 * (1 - l.sp)); }
    } else {
      // Large faceted grains round far more slowly than small ones (they need to
      // lose much more mass to bond), so buried facets and depth hoar stay
      // persistent for months, as observed in the Rockies' basal layers.
      const slow = (l.mk & FACET) ? clamp(0.5 / l.gs, 0.12, 1) : 1;
      l.sp += (rRound * slow - rFacet) * dtDays;
      l.gs += (0.004 * fT + 0.05 * xs * fT * fRho) * dtDays;
    }
    l.dd = clamp(l.dd, 0, 1);
    l.sp = clamp(l.sp, 0, 1);
    l.gs = clamp(l.gs, 0.1, 6);
    if (l.dd === 0 && l.sp < 0.45) { l.mk |= FACET; if (l.gs >= 1.8) l.mk |= DHM; }
    // Strong faceting eventually erases a thin crust's identity.
    if ((l.mk & WET) && l.sp < 0.2 && l.gs > 1) l.mk &= ~WET;
  }
}

function surfaceHoar(sim, f, dep, absSW) {
  const L = sim.L;
  const top = L[L.length - 1];
  if (!top) return;
  const calm = f.U < 3.5 && (f.P || 0) < 0.05 && f.Ta < 0;
  if (top.mk & SH) {
    // Destroy by wind, sun or melt.
    if (f.U > 6 || theta(top) > 0.001 || (sim.Ts > -0.5 && absSW > 80) || absSW > 180) {
      top.mk &= ~SH; top.dd = 0; top.sp = 0.5; top.gs = Math.min(top.gs, 1);
      if (L.length > 1) mergeInto(L[L.length - 2], L.pop());
      return;
    }
    if (dep > 0 && calm) {
      top.m += dep; top.d = top.m / 100; top.gs = Math.min(8, 1 + 15 * top.m);
    }
    return;
  }
  if (dep > 0.004 && calm) {
    L.push({ d: dep / 100, m: dep, w: 0, T: sim.Ts, dd: 0, sp: 0, gs: 1 + 15 * dep, bd: f.t, mk: SH });
  } else if (dep > 0) {
    top.m += dep;
  }
}

function sublimate(sim, mass) {
  // Remove `mass` (kg/m²) from the surface (water first, then ice).
  const L = sim.L;
  let left = mass;
  while (left > 0 && L.length) {
    const top = L[L.length - 1];
    if (top.w > 0) { const x = Math.min(top.w, left); top.w -= x; left -= x; continue; }
    if (top.m <= left + 1e-6) { left -= top.m; L.pop(); }
    else { const f = (top.m - left) / top.m; top.m -= left; top.d *= f; left = 0; }
  }
}

function manageLayers(sim) {
  const L = sim.L;
  // Drop vanishing layers.
  for (let i = L.length - 1; i >= 0; i--) {
    const l = L[i];
    if (l.m < 0.02 && !(l.mk & SH && l.m > 0.001)) {
      if (i > 0) { L[i - 1].w += l.w; } else sim.runoff += l.w;
      L.splice(i, 1);
    }
  }
  // Very thin non-hoar layers merge with the neighbour below.
  for (let i = L.length - 2; i >= 1; i--) {
    const l = L[i];
    if (l.d < 0.004 && !(l.mk & SH) && !(L[i - 1].mk & SH)) { mergeInto(L[i - 1], l); L.splice(i, 1); }
  }
  if (L.length <= MAX_LAYERS) return;
  // Merge the most similar adjacent pair below the top 30 cm until under the cap.
  while (L.length > MAX_LAYERS - 6) {
    let depth = 0, best = -1, bestScore = Infinity;
    const topDepth = [];
    for (let i = L.length - 1; i >= 0; i--) { topDepth[i] = depth; depth += L[i].d; }
    for (let i = 0; i < L.length - 1; i++) {
      const a = L[i], b = L[i + 1];
      if (topDepth[i + 1] < 0.3) continue;
      if ((a.mk | b.mk) & SH) continue;
      if (((a.mk & WET) !== (b.mk & WET))) continue;
      const s = Math.abs(density(a) - density(b)) / 50 + Math.abs(a.gs - b.gs) / 0.5 +
        Math.abs(a.sp - b.sp) / 0.3 + Math.abs(a.dd - b.dd) / 0.3 + Math.abs(a.bd - b.bd) / 240 +
        (a.d + b.d > 0.3 ? 5 : 0);
      if (s < bestScore) { bestScore = s; best = i; }
    }
    if (best < 0) break;
    mergeInto(L[best], L[best + 1]);
    L.splice(best + 1, 1);
  }
}

// Advance a sim by one hour. `f` is the hourly forcing seen by this sim:
//   t (epoch hour at the END of the step), Ta (°C), RH (%), U (m/s, 10 m),
//   snow (kg/m² of snowfall reaching this slope), rain (kg/m²),
//   sw (incoming shortwave on the slope, W/m²), lw (incoming longwave, W/m²),
//   drift (kg/m², + deposition / − erosion of loose snow on this slope)
export function stepHour(sim, f) {
  if (f.drift > 0) addSnow(sim, f.drift, f.Ta, f.U, f.t, true);
  else if (f.drift < 0) erode(sim, -f.drift);
  if (f.snow > 0) addSnow(sim, f.snow, f.Ta, f.U, f.t, false);
  const L = sim.L;
  if (!L.length) { sim.Ts = Math.min(0, f.Ta); sim.t = f.t; return; }
  if (f.rain > 0) { L[L.length - 1].w += f.rain; L[L.length - 1].mk |= RAIN; }
  const dt = 3600 / SUBSTEPS;
  let dep = 0, absSW = 0;
  for (let s = 0; s < SUBSTEPS; s++) {
    if (!L.length) break;
    const r = energyStep(sim, f, dt);
    dep += r.dep; absSW += r.absSW / SUBSTEPS;
    percolate(sim);
  }
  if (dep < 0) sublimate(sim, -dep);
  else surfaceHoar(sim, f, dep, absSW);
  if (L.length) {
    settle(sim, 3600);
    metamorphism(sim, 1 / 24);
    manageLayers(sim);
  }
  if (!L.length) sim.Ts = Math.min(0, f.Ta);
  sim.t = f.t;
}

export function snowDepth(sim) { let h = 0; for (const l of sim.L) h += l.d; return h; }
export function swe(sim) { let s = 0; for (const l of sim.L) s += l.m + l.w; return s; }

// Compact serialisation: one array per layer.
export function packSim(sim) {
  const r = (x, k) => Math.round(x * k) / k;
  return {
    Ts: r(sim.Ts, 100), ro: r(sim.runoff, 10), t: sim.t,
    L: sim.L.map((l) => [r(l.d, 1e5), r(l.m, 1e3), r(l.w, 1e3), r(l.T, 1e3), r(l.dd, 1e4), r(l.sp, 1e4), r(l.gs, 1e3), r(l.bd, 100), l.mk]),
  };
}
export function unpackSim(base, p) {
  const sim = createSim(base);
  if (!p) return sim;
  sim.Ts = p.Ts; sim.runoff = p.ro || 0; sim.t = p.t;
  sim.L = p.L.map((a) => ({ d: a[0], m: a[1], w: a[2], T: a[3], dd: a[4], sp: a[5], gs: a[6], bd: a[7], mk: a[8] }));
  return sim;
}
export function cloneSim(sim) {
  return { ...sim, L: sim.L.map((l) => ({ ...l })) };
}
