// Synthetic-season smoke test: runs one site through an invented winter and
// prints timing, the final profiles and the diagnostics. Not a validation — it
// checks the physics behaves sensibly (settlement, facets under cold clear
// spells on shallow snow, surface hoar on calm clear nights, sun crusts on S).
import { createSite, stepSite } from "../src/model/site.js";
import { sunPosition } from "../src/model/solar.js";
import { diagnose, summarize, layersTopDown, CLASSES, HARDNESS_LABELS } from "../src/model/stability.js";

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const lat = 51.45, lon = -116.35, z = 2300;
const t0 = Date.parse("2026-10-01T00:00:00Z") / 3600000;
const hours = 24 * 150;
const forcing = [];
let synoptic = 0, storm = 0, stormLeft = 0;
for (let k = 1; k <= hours; k++) {
  const t = t0 + k;
  const day = k / 24;
  const seasonal = -2 - 10 * Math.sin(Math.min(1, day / 100) * Math.PI / 2) + (day > 120 ? (day - 120) * 0.12 : 0);
  synoptic = 0.97 * synoptic + (rnd() - 0.5) * 1.2;
  if (stormLeft <= 0 && rnd() < 1 / (24 * 5)) { stormLeft = 12 + Math.floor(rnd() * 48); storm = 0.6 + rnd() * 2; }
  // A deliberate 12-day cold clear spell in late November to grow facets.
  const coldSpell = day > 50 && day < 62;
  const inStorm = stormLeft > 0 && !coldSpell;
  if (stormLeft > 0) stormLeft--;
  const sun = sunPosition((t - 0.5) * 3600000, lat, lon);
  const localH = ((t - 7) % 24 + 24) % 24;
  const diurnal = 4 * Math.sin((localH - 9) / 24 * 2 * Math.PI);
  const cc = inStorm ? 1 : coldSpell ? 0 : Math.min(1, Math.max(0, 0.4 + synoptic * 0.2));
  const Ta = seasonal + synoptic + (inStorm ? 1 : coldSpell ? -8 : 0) + diurnal * (1 - 0.7 * cc);
  const clear = Math.max(0, 1050 * sun.cosZ);
  const ghi = clear * (1 - 0.75 * cc ** 3);
  const dirH = ghi * (1 - cc) * 0.85;
  const RH = inStorm ? 95 : coldSpell ? 75 : 70 + 20 * cc;
  const U = inStorm ? 7 + rnd() * 6 : coldSpell ? 1.5 : 2 + rnd() * 3;
  const P = inStorm ? storm * (0.5 + rnd()) : 0;
  const TaK = Ta + 273.15;
  const ea = RH / 100 * 611.2 * Math.exp(17.67 * Ta / (Ta + 243.5)) / 100;
  const w = 46.5 * ea / TaK;
  const ecs = 1 - (1 + w) * Math.exp(-Math.sqrt(1.2 + 3 * w));
  const eps = (1 - 0.84 * cc) * ecs + 0.84 * cc;
  const lw = eps * 5.67e-8 * TaK ** 4;
  const sf = Math.min(1, Math.max(0, (1.5 - Ta) / 2));
  forcing.push({ t, Ta, RH, U, dir: 250, P, sf, ghi, dirH, difH: ghi - dirH, lw });
}

const site = createSite({ id: "test", lat, lon, z });
const start = process.hrtime.bigint();
for (const f of forcing) stepSite(site, f);
const ms = Number(process.hrtime.bigint() - start) / 1e6;
const totP = forcing.reduce((s, f) => s + f.P * f.sf, 0);
console.log(`${hours} h × 5 sims in ${ms.toFixed(0)} ms → ${(ms * 1000 / hours / 5).toFixed(1)} µs per sim-hour; snowfall ${totP.toFixed(0)} mm`);

const tEnd = t0 + hours;
const diags = site.sims.map((s) => diagnose(s, tEnd));
["flat", "N", "E", "S", "W"].forEach((a, i) => {
  const s = site.sims[i];
  const d = diags[i];
  console.log(`\n== ${a}: HS ${d.hs.toFixed(0)} cm, layers ${s.L.length}, SWE ${s.L.reduce((x, l) => x + l.m + l.w, 0).toFixed(0)} kg/m², Ts ${s.Ts.toFixed(1)}  pNew ${d.pNew.toFixed(2)} pWind ${d.pWind.toFixed(2)} pPwl ${d.pPwl.toFixed(2)} pWet ${d.pWet.toFixed(2)} haz ${d.hazard.toFixed(2)} skiPen ${d.skiPen}`);
  if (i === 0 || i === 3) {
    for (const x of layersTopDown(s)) {
      console.log(`  ${(x.top * 100).toFixed(0).padStart(4)}–${(x.bottom * 100).toFixed(0).padStart(4)} cm ${CLASSES[x.cls].padEnd(5)} ρ=${(x.l.m / x.l.d).toFixed(0).padStart(3)} T=${x.l.T.toFixed(1).padStart(5)} gs=${x.l.gs.toFixed(2)} dd=${x.l.dd.toFixed(2)} sp=${x.l.sp.toFixed(2)} h=${HARDNESS_LABELS[Math.round(x.h) - 1]} born ${new Date(x.l.bd * 3600000).toISOString().slice(5, 10)} mk=${x.l.mk}`);
    }
  }
  console.log("  weak:", d.weak.map((w) => `${CLASSES[w.cls]}@${w.depth}cm L${w.lemons} p${w.p.toFixed(2)}`).join(", "));
});
console.log("\nSummary:", summarize(diags, [{ t: tEnd - 48, snowCm: 12, rainMm: 0 }, { t: tEnd - 24, snowCm: 5, rainMm: 0 }, { t: tEnd, snowCm: 0, rainMm: 0 }]));
