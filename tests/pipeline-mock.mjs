// End-to-end pipeline test with an in-memory blob store and synthetic
// station/model data (the real sources aren't reachable from CI sandboxes).
//   node tests/pipeline-mock.mjs
import { runPipeline } from "../netlify/lib/pipeline.mjs";
import { deps, clock } from "./mock-deps.mjs";

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
