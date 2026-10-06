// End-to-end pipeline test with an in-memory blob store and synthetic
// station/model data (the real sources aren't reachable from CI sandboxes).
//   node tests/pipeline-mock.mjs
import { runPipeline } from "../netlify/lib/pipeline.mjs";
import { deps, clock, mock } from "./mock-deps.mjs";

const t = Date.now();
const st1 = await runPipeline(deps, { log: (m) => console.log("  run1:", m) });
console.log(`run 1: ${Date.now() - t} ms; stations`, st1.stations.slice(0, 3));
clock.now += 1;
const t2 = Date.now();
await runPipeline(deps, { log: (m) => console.log("  run2:", m) });
console.log(`run 2 (1 h later): ${Date.now() - t2} ms`);
clock.now += 3;
const t3 = Date.now();
await runPipeline(deps, { log: (m) => console.log("  run3:", m) });
console.log(`run 3 (+3 h, forecast): ${Date.now() - t3} ms`);

const meta = JSON.parse(deps.store.m.get("meta"));
console.log("dates", meta.dates, "cells", meta.cells.length, "points", meta.points.length);
const sizes = [...deps.store.m.entries()].map(([k, v]) => [k, v.length]).sort((a, b) => b[1] - a[1]);
console.log("largest blobs:", sizes.slice(0, 6).map(([k, n]) => `${k} ${(n / 1024).toFixed(0)} KB`).join(", "));
console.log("total blobs", sizes.length, "total MB", (sizes.reduce((s, x) => s + x[1], 0) / 1048576).toFixed(1));
const last = meta.dates.forecast.at(-1) || meta.dates.analysis.at(-1);
const f = JSON.parse(deps.store.m.get(`field/${last}`));
const hs = f.props.hs.filter((x) => x !== null);
console.log(`field ${last} (${f.kind}): HS min ${Math.min(...hs)} max ${Math.max(...hs)} mean ${(hs.reduce((a, b) => a + b, 0) / hs.length).toFixed(0)}; hazard max ${Math.max(...f.props.hazard)}`);
const i = f.props.hs.indexOf(Math.max(...hs));
console.log("deepest cell text:", f.text[i]);
const pt = JSON.parse(deps.store.m.get("pts/mt-gordon:ALP"));
console.log("Mt.Gordon ALP days:", pt.days.length, "last:", pt.days.at(-1).date, pt.days.at(-1).text);

// Forecast spread at a named point: the corrected control and every member run
// to about 84 h, and the control matches the point's own forecast.
const ptf = JSON.parse(deps.store.m.get("ptf/mt-gordon:ALP"));
const sp = ptf.spread;
if (!sp || sp.members.length !== 13) throw new Error(`spread: expected 13 runs, got ${sp?.members.length}`);
if (sp.horizon - sp.analysisHour < 72) throw new Error(`spread horizon only ${sp.horizon - sp.analysisHour} h`);
const ctrl = sp.members[0], nam = sp.members.find((m) => m.id === "noaa_nam12"), hr = sp.members.find((m) => m.id === "gem_hrdps_continental");
for (const d of ptf.days) {
  const c = ctrl.days.find((x) => x.t === d.t);
  if (!c || JSON.stringify(c.p) !== JSON.stringify(d.p) || JSON.stringify(c.hs) !== JSON.stringify(d.hs)) throw new Error(`spread control differs from the point forecast on ${d.date}`);
}
if (hr.days.at(-1).t > sp.analysisHour + 49) throw new Error("HRDPS member ran past its data");
// HRDPS is the control's own model, so its row reproduces the control's weather within rounding.
const sameAsControl = (s, label) => {
  const c0 = s.members[0], h = s.members.find((m) => m.id === "gem_hrdps_continental");
  for (const d of h.days) {
    const c = c0.days.find((x) => x.t === d.t);
    if (!c || Math.abs(c.snow24 - d.snow24) > 1 || Math.abs(c.precip24 - d.precip24) > 1) throw new Error(`${label}: HRDPS member differs from the control on ${d.date}: ${d.snow24} cm / ${d.precip24} mm vs ${c?.snow24} / ${c?.precip24}`);
  }
};
sameAsControl(sp, "run3");
const spread = (k) => { const v = sp.members.map((m) => m.days.find((x) => x.t === ctrl.days.at(-1).t)?.[k]).filter((x) => x != null); return `${Math.min(...v)}–${Math.max(...v)}`; };
console.log(`spread: ${sp.members.length} runs to +${sp.horizon - sp.analysisHour} h; last day snow24 ${spread("snow24")} cm; NAM ${nam.days.length} days; status`, JSON.stringify(JSON.parse(deps.store.m.get("status")).spread));

// Run 4, 60 h later at 08:00 UTC with the gauges reading 2.2× the model: the
// newest Canadian run (00Z) ends 7 h before analysis + 84 h, so the spread stops
// at the data, and the control's precipitation correction is well over ×2 at
// ALP, which the HRDPS row must still reproduce.
mock.gauge = 2.2; clock.now += 60;
const st4 = await runPipeline(deps, { log: (m) => console.log("  run4:", m) });
const dataEnd = Math.floor((clock.now - mock.lag) / 6) * 6 + 84;
const sp4 = JSON.parse(deps.store.m.get("ptf/mt-gordon:ALP")).spread;
if (!sp4 || sp4.members.length !== 13) throw new Error(`run4 spread: expected 13 runs, got ${sp4?.members.length}`);
if (sp4.horizon > dataEnd) throw new Error(`spread horizon runs ${sp4.horizon - dataEnd} h past the Canadian models' data`);
if (sp4.horizon - sp4.analysisHour < 70) throw new Error(`spread horizon only ${sp4.horizon - sp4.analysisHour} h`);
for (const m of sp4.members) for (const d of m.days) if (d.t > sp4.horizon) throw new Error(`${m.id} ran past the spread horizon`);
if (sp4.members[0].days.at(-1).t !== sp4.horizon) throw new Error("control has no column at the horizon");
sameAsControl(sp4, "run4");
console.log(`spread run4: to +${sp4.horizon - sp4.analysisHour} h, data to +${dataEnd - sp4.analysisHour} h; status`, JSON.stringify(st4.spread));

// Run 5, 3 h later with the spread fetch failing: the previous spread is kept and reported.
const realSpread = deps.fetchSpread;
deps.fetchSpread = async (pts, ids) => ({ members: Object.fromEntries(ids.map((id) => [id, pts.map(() => null)])), source: "", errors: ["mock outage"] });
clock.now += 3;
const st5 = await runPipeline(deps, { log: (m) => console.log("  run5:", m) });
deps.fetchSpread = realSpread; mock.gauge = 1;
const ptf5 = JSON.parse(deps.store.m.get("ptf/mt-gordon:ALP"));
if (ptf5.analysisHour <= sp4.analysisHour || !ptf5.spread || ptf5.spread.members.length !== 13 || ptf5.spread.analysisHour !== sp4.analysisHour) throw new Error("spread not kept over a failed fetch");
if (!st5.spread || !st5.spread.carried || st5.spread.members !== 0) throw new Error(`kept spread not reported: ${JSON.stringify(st5.spread)}`);
console.log(`spread run5: fetch failed, ${st5.spread.carried} points kept the previous spread`);

if (process.env.INSPECT) {
  for (const d of meta.dates.analysis.slice(-6).concat(meta.dates.forecast)) {
    const f = JSON.parse(deps.store.m.get(`field/${d}`));
    const st = (p) => { const v = f.props[p].filter((x) => x !== null); return `${p} ${Math.min(...v)}/${Math.round(v.reduce((a, b) => a + b, 0) / v.length)}/${Math.max(...v)}`; };
    console.log(d, f.kind, ["hazard", "pNew", "pWind", "pPwl", "pWet", "snow24", "snow72", "wind24", "hs", "skiPen", "critPwlDist"].map(st).join(" | "));
  }
  const pts = JSON.parse(deps.store.m.get("pts/mt-gordon:ALP"));
  const dd = pts.days.at(-1);
  console.log("gordon last day weak:", JSON.stringify(dd.W), "p:", JSON.stringify(dd.p));
}
