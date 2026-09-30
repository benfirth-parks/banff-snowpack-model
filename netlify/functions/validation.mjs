// Model vs station snow height, per station, for a season:
//   /api/validation?season=2025-26   (omit season for the current one)
// Uses the flat simulation at each station point and the station's HS sensor
// with its bare-ground baseline removed. Only days with an observation count.
import { blobStore, json } from "../lib/store.mjs";
import { LIVE_SEASON } from "../lib/pipeline.mjs";
import { STATIONS } from "../../src/model/domain.js";

const r1 = (x) => Math.round(x * 10) / 10;

export default async (req) => {
  const season = new URL(req.url).searchParams.get("season") || LIVE_SEASON;
  if (!/^\d{4}-\d{2}$/.test(season)) return json({ error: "bad season" }, { status: 400 });
  const s = blobStore();
  const pre = season === LIVE_SEASON ? "" : `seasons/${season}/`;
  const rows = [];
  for (const st of STATIONS) {
    if (st.noPoint) continue;
    const series = await s.get(`${pre}pts/${st.id}`, { type: "json" });
    const pairs = (series?.days || []).filter((d) => d.obsHS !== null && d.obsHS !== undefined && d.hs).map((d) => [d.date, d.hs[0] ?? 0, d.obsHS]);
    if (pairs.length < 5) { rows.push({ id: st.id, name: st.name, z: st.z, n: pairs.length }); continue; }
    const n = pairs.length;
    const m = pairs.map((p) => p[1]), o = pairs.map((p) => p[2]);
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const mm = mean(m), mo = mean(o);
    let cov = 0, vm = 0, vo = 0;
    for (let i = 0; i < n; i++) { cov += (m[i] - mm) * (o[i] - mo); vm += (m[i] - mm) ** 2; vo += (o[i] - mo) ** 2; }
    const iMaxO = o.indexOf(Math.max(...o)), iMaxM = m.indexOf(Math.max(...m));
    // Monthly means for a compact season curve.
    const months = {};
    for (const [date, mv, ov] of pairs) { const k = date.slice(0, 7); (months[k] ||= { m: [], o: [] }); months[k].m.push(mv); months[k].o.push(ov); }
    rows.push({
      id: st.id, name: st.name, z: st.z, n,
      bias: r1(mm - mo), mae: r1(mean(m.map((x, i) => Math.abs(x - o[i])))),
      r: vm > 0 && vo > 0 ? Math.round(100 * cov / Math.sqrt(vm * vo)) / 100 : null,
      obsMax: [pairs[iMaxO][0], Math.round(o[iMaxO])], modelMax: [pairs[iMaxM][0], Math.round(m[iMaxM])],
      monthly: Object.entries(months).map(([k, v]) => [k, Math.round(mean(v.m)), Math.round(mean(v.o))]),
    });
  }
  return json({ season, rows }, { maxAge: 300, sMaxAge: 600 });
};
