// Full model run (analysis + forecast). Background function: up to 15 minutes.
// Triggered hourly by `schedule`, or manually with the RUN_TOKEN:
//   curl -X POST -H "x-run-token: $RUN_TOKEN" https://<site>/.netlify/functions/run-background
import { runPipeline } from "../lib/pipeline.mjs";
import { fetchStationObs, fetchModel } from "../lib/fetchers.mjs";
import { boxElevations } from "../lib/terrain.mjs";
import { blobStore, nowHour } from "../lib/store.mjs";

export default async (req) => {
  const url = new URL(req.url);
  const token = Netlify.env.get("RUN_TOKEN");
  const given = req.headers.get("x-run-token") || url.searchParams.get("token");
  if (!token || given !== token) {
    console.log("run-background: unauthorized");
    return;
  }
  const store = blobStore();
  const lock = await store.get("lock", { type: "json" });
  if (lock && Date.now() - lock.at < 14 * 60 * 1000 && url.searchParams.get("force") !== "1") {
    console.log("run-background: another run is in progress");
    return;
  }
  await store.setJSON("lock", { at: Date.now() });
  try {
    await runPipeline(
      { store, fetchStationObs, fetchModel, cellElevations: boxElevations, nowHour },
      {
        forceForecast: url.searchParams.get("fc") === "1",
        maxAnalysisHours: Number(url.searchParams.get("max")) || undefined,
        log: (m) => console.log(m),
      },
    );
  } catch (e) {
    console.error(e);
    await store.setJSON("status-error", { at: new Date().toISOString(), error: String(e && e.stack || e) });
  } finally {
    await store.delete("lock");
  }
};
