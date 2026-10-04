// Forecast spread: the named points' snowpack run through each weather model of
// the Parks Wx Fx spread (11 Open-Meteo models plus the NOAA NAM 12 km parent) to
// 84 h at most, and never past the end of the Canadian models' data.
//
// The station corrections (temperature trend and bias, humidity, wind and
// precipitation ratios, ridge wind) are learned against the Canadian models
// (HRDPS, then RDPS beyond its 48 h). A member is therefore run as a departure
// from that corrected forcing: at each hour its difference from the Canadian
// models at the same point is added to the corrected control.
//   temperature, humidity, cloud: + (member − control)
//   wind (10 m and ridge): × (member + 5)/(control + 5) km/h, within ×⅓ … ×3
//   wind direction: turned by the member's difference where both blow > 7 km/h
//   precipitation: the member's own amount × the control's correction at this
//     point over the run (corrected ÷ raw control). The bound is the product of
//     the forcing's own bounds (orographic ×0.6 … ×1.8, station ratio ×0.25 … ×4),
//     so the HRDPS member reproduces the control exactly.
//   shortwave: × member ÷ control global radiation in daylight, within 0 … 1.5
// Missing member hours fall back to the control. The run ends where the Canadian
// models' data ends, so no hour is ever filled with the forcing's defaults.
//
// It is a spread of deterministic models, not a calibrated ensemble.
import { longwaveIn, snowFraction } from "./forcing.js";

// Same list, order and short names as the Wx Fx spread.
export const SPREAD_MEMBERS = [
  { id: "gem_hrdps_continental", short: "HRDPS", label: "ECCC HRDPS 2.5 km" },
  { id: "gem_regional", short: "RDPS", label: "ECCC RDPS 10 km" },
  { id: "gem_global", short: "GDPS", label: "ECCC GDPS 15 km" },
  { id: "gfs_seamless", short: "GFS", label: "NOAA GFS" },
  { id: "noaa_nam12", short: "NAM", label: "NOAA NAM 12 km" },
  { id: "icon_global", short: "ICON", label: "DWD ICON global" },
  { id: "ecmwf_ifs025", short: "ECMWF", label: "ECMWF IFS 0.25°" },
  { id: "ecmwf_aifs025_single", short: "AIFS", label: "ECMWF AIFS 0.25° (machine-learning emulator)", ai: true },
  { id: "meteofrance_arpege_world", short: "ARPEGE", label: "Météo-France ARPEGE" },
  { id: "ukmo_global_deterministic_10km", short: "UKMO", label: "UK Met Office global 10 km" },
  { id: "jma_gsm", short: "JMA", label: "JMA GSM" },
  { id: "cma_grapes_global", short: "CMA", label: "CMA GRAPES global" },
];
export const SPREAD_HOURS = 84;

const ok = (v) => v !== null && v !== undefined && Number.isFinite(v);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

// Control's precipitation correction at a point over the run: corrected ÷ raw.
// The ratio is over the whole run against the same model cell, so it is not a
// noisy quantity; the bound only guards against a near-empty run.
export function precipScale(corrected, raw) {
  let c = 0, r = 0;
  for (let i = 0; i < corrected.length; i++) if (ok(corrected[i]) && ok(raw[i])) { c += corrected[i]; r += raw[i]; }
  return r > 1 ? clamp(c / r, 0.6 * 0.25, 1.8 * 4) : 1;
}

// One hour of member forcing. f: the corrected control hour (forcing.js at());
// r, m: raw control and member values at the point ({ T, RH, U, dir, P, ghi, cc },
// U in km/h, cc as a fraction); pScale from precipScale().
export function memberForcing(f, r, m, pScale) {
  if (!r || !m) return f;
  const d = (k) => (ok(m[k]) && ok(r[k]) ? m[k] - r[k] : 0);
  const Ta = f.Ta + d("T");
  const RH = clamp(f.RH + d("RH"), 5, 100);
  const kU = ok(m.U) && ok(r.U) ? clamp((m.U + 5) / (r.U + 5), 1 / 3, 3) : 1;
  let turn = 0;
  if (ok(m.dir) && ok(r.dir) && m.U > 7 && r.U > 7) turn = ((m.dir - r.dir + 540) % 360) - 180;
  const rot = (x) => (ok(x) ? (x + turn + 360) % 360 : x);
  const P = ok(m.P) ? Math.max(0, m.P) * pScale : f.Pwx;
  // Member and control radiation must share Open-Meteo's preceding-hour mean;
  // a member whose radiation is on another convention passes ghi null.
  const kS = ok(m.ghi) && ok(r.ghi) && r.ghi > 20 ? clamp(m.ghi / r.ghi, 0, 1.5) : 1;
  const cc = ok(f.cc) ? clamp(f.cc + d("cc"), 0, 1) : f.cc;
  return {
    ...f, Ta, RH, U: f.U * kU, Ur: f.Ur * kU, dir: rot(f.dir), dirR: rot(f.dirR),
    P, Pwx: P, sf: snowFraction(Ta),
    ghi: ok(f.ghi) ? f.ghi * kS : f.ghi, dirH: ok(f.dirH) ? f.dirH * kS : f.dirH, difH: ok(f.difH) ? f.difH * kS : f.difH,
    cc, lw: longwaveIn(Ta, RH, cc),
  };
}
