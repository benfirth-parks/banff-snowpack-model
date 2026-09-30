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
  const seasonal = 6 - (t - 494000) / 24 * 0.25; // cooling through autumn
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
  fetchElevations: async (pts) => pts.map((p) => 1400 + 700 * (1 + Math.sin(p.lat * 40) * Math.cos(p.lon * 30))),
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
};

