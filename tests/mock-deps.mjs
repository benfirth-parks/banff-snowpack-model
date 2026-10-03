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
        obs[s.id].push({ t, T: w.T, RH: w.RH, U: w.U * (s.z > 2400 ? 1.6 : 0.6), dir: w.dir, HS: null, P: s.precip === "gauge" ? w.P : null });
      }
    }
    return { obs, errors: [] };
  },
  fetchModel: async (nodes, pastDays) => {
    const t0 = Math.floor(clock.now / 24) * 24 - pastDays * 24;
    const out = nodes.map((n) => {
      const z = 1500 + 900 * hash(n.lat * 100 + n.lon);
      const v = { T: [], RH: [], U: [], dir: [], P: [], ghi: [], dirH: [], difH: [], cc: [] };
      for (let t = t0; t < t0 + (pastDays + 4) * 24; t++) {
        const w = wx(n.lat, n.lon, z, t, { T: 1.5, P: 1.3 });
        for (const k of Object.keys(v)) v[k].push(w[k]);
      }
      return { id: n.id, lat: n.lat, lon: n.lon, z, t0, v };
    });
    return { nodes: out, source: "mock", errors: [] };
  },
  // Spread members: the same synthetic weather with a per-member temperature,
  // precipitation and wind offset. HRDPS stops at 48 h; the NAM run is 6 h old,
  // runs 84 h and sits 300 m above the point.
  fetchSpread: async (points, ids) => {
    const members = {};
    ids.forEach((id, m) => {
      const t0 = id === "noaa_nam12" ? clock.now - 6 : Math.floor(clock.now / 24) * 24 - 24;
      const n = id === "noaa_nam12" ? 85 : id === "gem_hrdps_continental" ? clock.now + 48 - t0 : 5 * 24;
      const off = { T: 2 * Math.sin(m * 1.7), P: 0.6 + 0.08 * m, U: 0.7 + 0.06 * m };
      members[id] = points.map((pt) => {
        const z = id === "noaa_nam12" ? 2300 : 2000;
        const v = { T: [], RH: [], P: [], U: [], dir: [], ghi: [], cc: [] };
        for (let t = t0; t < t0 + n; t++) {
          const w = wx(pt.lat, pt.lon, z, t, { T: 1.5 + off.T, P: 1.3 * off.P });
          v.T.push(w.T); v.RH.push(w.RH); v.P.push(t === t0 && id === "noaa_nam12" ? null : w.P); v.U.push(w.U * off.U);
          v.dir.push(w.dir + 10 * m); v.ghi.push(w.ghi); v.cc.push(w.cc / 100);
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

