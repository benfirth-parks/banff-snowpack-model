// A "site" is one location (grid cell or named point band) simulated as a flat
// field plus four virtual 38° slopes (N, E, S, W). This module turns the
// location's free-air hourly forcing into the forcing each slope sees:
// slope shortwave, sky-view longwave, wind loading of snowfall and drifting.
import { ASPECTS } from "./domain.js";
import { createSim, stepHour, driftThreshold, erodibleMass, packSim, unpackSim } from "./snowpack.js";
import { sunPosition, slopeShortwave, DEG } from "./solar.js";

const SIGMA = 5.670e-8;

export function createSite({ id, lat, lon, z }) {
  return {
    id, lat, lon, z,
    sims: ASPECTS.map((a) => createSim({ lat, lon, z, slope: a.slope * DEG, aspect: a.aspect * DEG })),
  };
}

export function packSite(site) {
  return { id: site.id, lat: site.lat, lon: site.lon, z: site.z, s: site.sims.map(packSim) };
}
export function unpackSite(p) {
  return {
    id: p.id, lat: p.lat, lon: p.lon, z: p.z,
    sims: ASPECTS.map((a, i) => unpackSim({ lat: p.lat, lon: p.lon, z: p.z, slope: a.slope * DEG, aspect: a.aspect * DEG }, p.s && p.s[i])),
  };
}
export function cloneSite(site) {
  return { ...site, sims: site.sims.map((s) => ({ ...s, L: s.L.map((l) => ({ ...l })) })) };
}

// How exposed the slopes at an elevation are to the ridge-top wind: none at
// 1800 m (sheltered below treeline), fully from 2400 m (alpine).
export function exposure(z) { return Math.min(1, Math.max(0, (z - 1800) / 600)); }

// f: { t, Ta, RH, U (m/s), dir (° from), P (mm), sf (snow fraction), ghi, dirH, difH, lw,
//      Ur, dirR (optional: ridge-top wind speed and regional flow direction),
//      Pwx (optional: precipitation in the weather where P is set from snow height) }
// The flat field (a sheltered study plot) sees the local wind U throughout. On
// the slopes, snow is moved by a wind between U and the ridge wind Ur, by
// exposure: it drifts loose snow from the windward slope to the lee slope, loads
// the lee slope during snowfall, and sets the density and wind mark of the snow
// deposited. The slopes' energy balance keeps the local wind U.
export function stepSite(site, f) {
  const sun = sunPosition((f.t - 0.5) * 3600000, site.lat, site.lon);
  const snowTot = f.P * f.sf;
  const rain = f.P * (1 - f.sf);
  const e = f.Ur === undefined ? 0 : exposure(site.z);
  const Us = e > 0 ? Math.exp((1 - e) * Math.log(f.U + 1.4) + e * Math.log(f.Ur + 1.4)) - 1.4 : f.U;
  const lee = (((f.dirR ?? f.dir) + 180) % 360) * DEG;
  const load = Math.min(0.35, Math.max(0, (Us - 5) / 15));
  const flat = site.sims[0];
  const ut = driftThreshold(flat);
  const Q = Us > ut ? Math.min(0.015 * (Us - ut) ** 2, 0.1 * erodibleMass(flat)) : 0;
  const TaK = f.Ta + 273.15;
  for (const sim of site.sims) {
    let sw, lw, snow, drift, Ud = Us;
    if (sim.slope === 0) {
      sw = f.ghi; lw = f.lw; snow = snowTot; drift = 0; Ud = f.U;
    } else {
      const c = Math.cos(sim.aspect - lee);
      const sv = (1 + Math.cos(sim.slope)) / 2;
      sw = slopeShortwave(f.ghi, f.dirH, f.difH, sun, sim.slope, sim.aspect);
      lw = sv * f.lw + (1 - sv) * 0.98 * SIGMA * TaK ** 4;
      snow = snowTot * (1 + load * c);
      drift = Q * c;
    }
    stepHour(sim, { t: f.t, Ta: f.Ta, RH: f.RH, U: f.U, Ud, P: Math.max(f.P, f.Pwx ?? 0), snow, rain, sw, lw, drift });
  }
}
