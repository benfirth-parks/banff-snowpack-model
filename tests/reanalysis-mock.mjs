// Historical-season runner on mock data: two chunks of 2025-26.
//   node tests/reanalysis-mock.mjs
import { runSeasonChunk, getRegistry, nextSeasonToRun } from "../netlify/lib/reanalysis.mjs";
import { deps } from "./mock-deps.mjs";

const reg0 = await getRegistry(deps.store);
console.log("queue:", reg0.list.map((s) => `${s.id}:${s.status}`).join(", "), "→ next", nextSeasonToRun(reg0));
for (let i = 0; i < 2; i++) {
  const t = Date.now();
  const r = await runSeasonChunk(deps, "2025-26", { log: (m) => console.log("  ", m) });
  console.log(`chunk ${i + 1}: ${((Date.now() - t) / 1000).toFixed(1)} s, done=${r.done}`);
}
const reg = await getRegistry(deps.store);
const e = reg.list.find((s) => s.id === "2025-26");
console.log(`registry: ${e.status} ${e.progress}% dates ${e.dates[0]} … ${e.dates.at(-1)} (${e.dates.length})`);
const f = JSON.parse(deps.store.m.get(`seasons/2025-26/field/${e.dates.at(-1)}`));
const hs = f.props.hs.filter((x) => x !== null);
console.log(`field ${f.date} ${f.kind}: HS ${Math.min(...hs)}–${Math.max(...hs)} cm; sample text: ${f.text[500]}`);
const pt = JSON.parse(deps.store.m.get("seasons/2025-26/pts/mt-gordon:ALP"));
console.log(`Mt.Gordon ALP: ${pt.days.length} days; last ${pt.days.at(-1).date}: ${pt.days.at(-1).text}`);
console.log("coverage sample:", JSON.stringify(e.coverage["fts-boslo"]));
