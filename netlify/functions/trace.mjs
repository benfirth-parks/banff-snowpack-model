// Diagnostic: /api/trace?id=fts-sunshine&token=RUN_TOKEN → daily forcing
// (station-corrected vs raw model) and modelled vs observed snow height at a
// point since the season start. Token-gated because it does a full replay.
import { traceSite } from "../lib/pipeline.mjs";
import { fetchStationObs, fetchModel } from "../lib/fetchers.mjs";
import { boxElevations } from "../lib/terrain.mjs";
import { blobStore, nowHour, json } from "../lib/store.mjs";

export default async (req) => {
  const q = new URL(req.url).searchParams;
  const token = Netlify.env.get("RUN_TOKEN");
  if (!token || q.get("token") !== token) return json({ error: "unauthorized" }, { status: 401, maxAge: 0, sMaxAge: 0 });
  try {
    const out = await traceSite({ store: blobStore(), fetchStationObs, fetchModel, cellElevations: boxElevations, nowHour }, { id: q.get("id") || "" });
    return json(out, { maxAge: 0, sMaxAge: 0 });
  } catch (e) {
    return json({ error: String(e.message || e) }, { status: 500, maxAge: 0, sMaxAge: 0 });
  }
};
