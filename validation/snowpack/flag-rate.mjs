// How often each model flags a weak layer at all: the base rate behind the
// test-failure and persistent-layer detection scores in compare.mjs, which
// count a hit when a model weak layer with p >= 50 % lies within tolerance of
// the observed one. A model that flags something in most profiles scores hits
// cheaply; this prints what "most" is for each run.
//
//   node validation/snowpack/flag-rate.mjs <label>=<days dir> [<label>=<days dir> ...]
//        [--seasons 2023-24,2024-25] [--min-hs 50]
//
// Over every point, season and day from 1 December to 30 April with the flat
// column at least --min-hs cm deep (default 50): the share of profiles (all
// five sectors) with at least one p >= 50 weak layer, the mean number of such
// layers per profile, and the same at p >= 60 and p >= 90. Our model's p is
// continuous and tops out near 96 (six lemons); SNOWPACK's is 100 / 60 / 0 for
// its poor / fair / good classes (pro2days.mjs), so p >= 90 means "poor" there
// and ">= 6 lemons" here, and p >= 60 admits "fair".
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = {};
const runs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) opt[argv[i].slice(2)] = argv[++i];
  else { const [label, dir] = argv[i].split("="); runs.push({ label, dir }); }
}
if (!runs.length) { console.error("usage: flag-rate.mjs <label>=<days dir> ..."); process.exit(1); }
const MIN_HS = +(opt["min-hs"] || 50);
const ok = (v) => v !== null && v !== undefined && Number.isFinite(v);
const winter = (date) => { const m = +date.slice(5, 7); return m === 12 || m <= 4; };

const rows = [];
for (const { label, dir } of runs) {
  const seasons = (opt.seasons ? opt.seasons.split(",") : readdirSync(dir).filter((s) => /^\d{4}-\d{2}$/.test(s))).filter((s) => existsSync(join(dir, s)));
  const c = { profiles: 0, p50: 0, p60: 0, p100: 0, n50: 0, n60: 0, n100: 0 };
  for (const season of seasons) for (const f of readdirSync(join(dir, season))) {
    if (!f.endsWith(".json.gz")) continue;
    const { days } = JSON.parse(gunzipSync(readFileSync(join(dir, season, f))));
    for (const d of days) {
      if (!winter(d.date) || !ok(d.hs?.[0]) || d.hs[0] < MIN_HS) continue;
      for (let a = 0; a < 5; a++) {
        const W = d.W?.[a];
        if (!W) continue;
        c.profiles++;
        const n50 = W.filter((w) => w[3] >= 50).length, n60 = W.filter((w) => w[3] >= 60).length, n100 = W.filter((w) => w[3] >= 90).length;
        c.n50 += n50; c.n60 += n60; c.n100 += n100;
        if (n50) c.p50++; if (n60) c.p60++; if (n100) c.p100++;
      }
    }
  }
  rows.push({ label, seasons: seasons.join(", "), ...c });
}
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)} %` : "–");
const per = (a, b) => (b ? (a / b).toFixed(2) : "–");
console.log(`Weak-layer flag rate, 1 Dec – 30 Apr, flat HS >= ${MIN_HS} cm, all five sectors\n`);
console.log("| Run | Seasons | Profiles | ≥1 layer p ≥ 50 | layers p ≥ 50 per profile | ≥1 layer p ≥ 60 | ≥1 layer p ≥ 90 |");
console.log("|---|---|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.label} | ${r.seasons} | ${r.profiles} | ${pct(r.p50, r.profiles)} | ${per(r.n50, r.profiles)} | ${pct(r.p60, r.profiles)} | ${pct(r.p100, r.profiles)} |`);
