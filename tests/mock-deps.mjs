// Mock data sources + in-memory blob store for local tests and previews.
import { sunPosition } from "../src/model/solar.js";

export class MemStore {
  constructor() { this.m = new Map(); }
  async get(k, o) { const v = this.m.get(k); return v === undefined ? null : o?.type === "json" ? JSON.parse(v) : v; }
  async setJSON(k, v) { this.m.set(k, JSON.stringify(v)); }
  async delete(k) { this.m.delete(k); }
}

// Deterministic synthetic weather: a shared synoptic sequence + elevation lapse.
function hash(n) { const x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x); }
function synoptic(t) {
  const day = Math.floor(t / 24);
  const storm = hash(Math.floor(t / 30)) < 0.22;
  return { storm, anom: 4 * Math.sin(t / 97) + 3 * (hash(day) - 0.5), P: storm ? 0.25 + 0.8 * hash(t) : 0, cc: storm ? 1 : hash(day * 7) * 0.6 };
}
function wx(lat, lon, z, t, bias = { T: 0, P: 1 }) {
  const s = synoptic(t);
  const doy = ((t / 24) % 365.25 + 365.25) % 365.25; // ~day of year (epoch-aligned)
  const seasonal = 2 - 10 * Math.cos(2 * Math.PI * (doy - 15) / 365.25);
  const localH = ((t - 7) % 24 + 24) % 24;
  const T = seasonal + s.anom - 0.0065 * (z - 1500) + 4 * Math.sin((localH - 9) / 24 * 2 * Math.PI) * (1 - 0.7 * s.cc) + bias.T;
  const sun = sunPosition((t - 0.5) * 3600000, lat, lon);
  const ghi = Math.max(0, 1000 * sun.cosZ) * (1 - 0.75 * s.cc ** 3);
  const orog = 1 + (z - 1500) / 2000 + (lon < -116.3 ? 0.4 : 0);
  return { T, RH: s.storm ? 95 : 65, U: s.storm ? 35 : 10, dir: 250, P: s.P * orog * bias.P, ghi, dirH: ghi * (1 - s.cc) * 0.8, difH: ghi * (1 - (1 - s.cc) * 0.8), cc: s.cc * 100, HS: null };
}

export const NOW0 = Math.floor(Date.parse("2026-09-30T16:00:00Z") / 3600000);
export const clock = { now: NOW0 };
// Knobs the tests turn: the age of the newest 6-hourly Canadian run (its data
// ends 84 h after the run, 48 h for HRDPS; Open-Meteo pads the rest with nulls)
// and a factor on what the gauges report against the model's precipitation.
export const mock = { lag: 4, gauge: 1 };
const latestRun = () => Math.floor((clock.now - mock.lag) / 6) * 6;

export const deps = {
  store: new MemStore(),
  nowHour: () => clock.now,
  cellElevations: async (boxes) => boxes.map((b) => { const lat = (b.lat0 + b.lat1) / 2, lon = (b.lon0 + b.lon1) / 2; const m = Math.round(1400 + 700 * (1 + Math.sin(lat * 40) * Math.cos(lon * 30))); return { mean: m, max: m + 400 }; }),
  fetchStationObs: async (stations, hours) => {
    const obs = {};
    for (const s of stations) {
      obs[s.id] = [];
      for (let t = clock.now - Math.ceil(hours); t <= clock.now - 1; t++) {
        const w = wx(s.lat, s.lon, s.z, t);
        obs[s.id].push({ t, T: w.T, RH: w.RH, U: w.U * (s.z > 2400 ? 1.6 : 0.6), dir: w.dir, HS: null, P: s.precip === "gauge" ? w.P * mock.gauge : null });
      }
    }
    return { obs, errors: [] };
  },
  // Canadian-model columns: HRDPS then RDPS, so the data ends 84 h after the
  // newest run and the arrays are null beyond it.
  fetchModel: async (nodes, pastDays) => {
    const t0 = Math.floor(clock.now / 24) * 24 - pastDays * 24, dataEnd = latestRun() + 84;
    const out = nodes.map((n) => {
      const z = 1500 + 900 * hash(n.lat * 100 + n.lon);
      const v = { T: [], RH: [], U: [], dir: [], P: [], ghi: [], dirH: [], difH: [], cc: [] };
      for (let t = t0; t < t0 + (pastDays + 4) * 24; t++) {
        const w = wx(n.lat, n.lon, z, t, { T: 1.5, P: 1.3 });
        for (const k of Object.keys(v)) v[k].push(t <= dataEnd ? w[k] : null);
      }
      return { id: n.id, lat: n.lat, lon: n.lon, z, t0, v };
    });
    return { nodes: out, source: "mock", errors: [] };
  },
  // Spread members: the same synthetic weather with a per-member temperature,
  // precipitation and wind offset. The Open-Meteo members sit at the model
  // node's elevation; HRDPS is the model nodes' own weather and ends 48 h after
  // the newest run, RDPS 84 h after it; the NAM run is 6 h old, runs 84 h and
  // sits 300 m above the point.
  fetchSpread: async (points, ids) => {
    const members = {}, run = latestRun();
    ids.forEach((id, m) => {
      const t0 = id === "noaa_nam12" ? clock.now - 6 : Math.floor(clock.now / 24) * 24 - 24;
      const n = id === "noaa_nam12" ? 85 : 5 * 24;
      const last = id === "gem_hrdps_continental" ? run + 48 : id === "gem_regional" ? run + 84 : Infinity;
      const off = { T: 2 * Math.sin(m * 1.7), P: 0.6 + 0.08 * m, U: 0.7 + 0.06 * m };
      if (m === 0) Object.assign(off, { T: 0, P: 1, U: 1 }); // HRDPS: the model nodes' own weather
      if (m === 1) off.P = 1; // RDPS: the control's precipitation beyond HRDPS's 48 h
      members[id] = points.map((pt) => {
        const z = id === "noaa_nam12" ? 2300 : 1500 + 900 * hash(pt.lat * 100 + pt.lon);
        const v = { T: [], RH: [], P: [], U: [], dir: [], ghi: [], cc: [] };
        for (let t = t0; t < t0 + n; t++) {
          const w = wx(pt.lat, pt.lon, z, t, { T: 1.5 + off.T, P: 1.3 * off.P });
          const has = t <= last;
          v.T.push(has ? w.T : null); v.RH.push(has ? w.RH : null); v.P.push(!has || (t === t0 && id === "noaa_nam12") ? null : w.P); v.U.push(has ? w.U * off.U : null);
          v.dir.push(has ? w.dir + 10 * m : null); v.ghi.push(has ? w.ghi : null); v.cc.push(has ? w.cc / 100 : null);
        }
        return { t0, z, v };
      });
    });
    return { members, source: "mock spread", errors: [] };
  },
  fetchModelHistory: async (nodes, startDate, endDate) => {
    const t0 = Date.parse(startDate + "T00:00:00Z") / 3600000, t1 = Date.parse(endDate + "T23:00:00Z") / 3600000;
    const out = nodes.map((n) => {
      const z = 1500 + 900 * hash(n.lat * 100 + n.lon);
      const v = { T: [], RH: [], U: [], dir: [], P: [], ghi: [], dirH: [], difH: [], cc: [] };
      for (let t = t0; t <= t1; t++) {
        const w = wx(n.lat, n.lon, z, t, { T: 1.5, P: 1.3 });
        for (const k of Object.keys(v)) v[k].push(w[k]);
      }
      return { id: n.id, lat: n.lat, lon: n.lon, z, t0, v };
    });
    return { nodes: out, source: "mock archive", errors: [] };
  },
};

