// Rebuilds past seasons (reanalysis) in chunks. Background function (15 min).
// Each invocation runs up to ~10 minutes of chunks, then re-invokes itself; when
// a season finishes it moves to the next queued one. The hourly `schedule`
// function restarts the queue if a chain is ever broken.
//   curl -X POST -H "x-run-token: $RUN_TOKEN" "https://<site>/.netlify/functions/season-background?season=2024-25"
//   add &reset=1 to rebuild a season from scratch.
import { runSeasonChunk, getRegistry, nextSeasonToRun, resetSeason, updateRegistry } from "../lib/reanalysis.mjs";
import { fetchStationObs, fetchModelHistory, fetchElevations } from "../lib/fetchers.mjs";
import { blobStore, nowHour } from "../lib/store.mjs";

const BUDGET_MS = 10 * 60 * 1000;
const CHUNK_MS_GUESS = 4 * 60 * 1000;

export default async (req) => {
  const url = new URL(req.url);
  const token = Netlify.env.get("RUN_TOKEN");
  if (!token || (req.headers.get("x-run-token") || url.searchParams.get("token")) !== token) {
    console.log("season-background: unauthorized");
    return;
  }
  const store = blobStore();
  const lock = await store.get("seasons/lock", { type: "json" });
  if (lock && Date.now() - lock.at < 16 * 60 * 1000 && url.searchParams.get("chain") !== "1") {
    console.log(`season-background: ${lock.season} already running`);
    return;
  }
  let reg = await getRegistry(store);
  let season = url.searchParams.get("season") || nextSeasonToRun(reg, 0);
  if (season && url.searchParams.get("reset") === "1") await resetSeason(store, season);
  if (!season) { console.log("season-background: nothing queued"); return; }

  const started = Date.now();
  await store.setJSON("seasons/lock", { at: Date.now(), season });
  let next = null;
  try {
    const deps = { store, fetchStationObs, fetchModelHistory, fetchElevations, nowHour };
    let lastChunk = 0;
    while (Date.now() - started + Math.max(lastChunk, CHUNK_MS_GUESS) < BUDGET_MS) {
      const t = Date.now();
      const r = await runSeasonChunk(deps, season, { log: (m) => console.log(m) });
      lastChunk = Date.now() - t;
      if (r.done) {
        console.log(`season ${season} complete`);
        reg = await getRegistry(store);
        season = nextSeasonToRun(reg, 0);
        if (!season) break;
      }
    }
    next = season;
  } catch (e) {
    console.error(e);
    const e0 = (await getRegistry(store)).list.find((x) => x.id === season);
    await updateRegistry(store, season, { status: "error", error: String(e && e.message || e).slice(0, 300), errors: (e0?.errors || 0) + 1 });
  }
  // Hand the lock straight to the next invocation so the hourly schedule can't
  // start a second runner on the same season in between.
  if (next) await store.setJSON("seasons/lock", { at: Date.now(), season: next });
  else await store.delete("seasons/lock");
  if (next) {
    const base = Netlify.env.get("URL") || process.env.URL;
    const res = await fetch(`${base}/.netlify/functions/season-background?season=${next}&chain=1`, { method: "POST", headers: { "x-run-token": token } });
    console.log(`season-background: continuing ${next} → ${res.status}`);
  }
};
