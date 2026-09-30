import { blobStore, json } from "../lib/store.mjs";
import { LIVE_SEASON } from "../lib/pipeline.mjs";

export default async (req) => {
  const q = new URL(req.url).searchParams;
  const date = q.get("date") || "";
  const season = q.get("season") || LIVE_SEASON;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "date=YYYY-MM-DD required" }, { status: 400 });
  if (!/^\d{4}-\d{2}$/.test(season)) return json({ error: "bad season" }, { status: 400 });
  const key = season === LIVE_SEASON ? `field/${date}` : `seasons/${season}/field/${date}`;
  const f = await blobStore().get(key, { type: "json" });
  if (!f) return json({ error: `No simulation for ${date}.` }, { status: 404, maxAge: 60, sMaxAge: 60 });
  // Past seasons don't change once built.
  return season === LIVE_SEASON ? json(f, { maxAge: 60, sMaxAge: 120 }) : json(f, { maxAge: 3600, sMaxAge: 3600 });
};
