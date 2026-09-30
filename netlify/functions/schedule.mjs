// Hourly trigger. The station archive syncs at :15, so the model runs at :25.
// Scheduled functions are limited to 30 s, so this only starts background runs:
// the live analysis + forecast, and (if any past season is still being rebuilt
// and its chain has stalled) the historical-season queue.
import { getStore } from "@netlify/blobs";
import { getRegistry, nextSeasonToRun } from "../lib/reanalysis.mjs";

export default async () => {
  const base = Netlify.env.get("URL") || process.env.URL;
  const token = Netlify.env.get("RUN_TOKEN");
  if (!base || !token) { console.log("schedule: URL or RUN_TOKEN missing"); return; }
  const headers = { "x-run-token": token };
  const res = await fetch(`${base}/.netlify/functions/run-background`, { method: "POST", headers });
  console.log(`schedule: run-background → ${res.status}`);
  try {
    const store = getStore({ name: "snowpack-v1", consistency: "strong" });
    const lock = await store.get("seasons/lock", { type: "json" });
    const season = nextSeasonToRun(await getRegistry(store));
    if (season && !(lock && Date.now() - lock.at < 16 * 60 * 1000)) {
      const r = await fetch(`${base}/.netlify/functions/season-background?season=${season}`, { method: "POST", headers });
      console.log(`schedule: season-background ${season} → ${r.status}`);
    }
  } catch (e) {
    console.log(`schedule: season check failed: ${e.message}`);
  }
};

export const config = { schedule: "25 * * * *" };
