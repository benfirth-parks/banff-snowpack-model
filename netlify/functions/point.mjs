import { blobStore, json } from "../lib/store.mjs";
import { LIVE_SEASON } from "../lib/pipeline.mjs";

export default async (req) => {
  const q = new URL(req.url).searchParams;
  const id = q.get("id") || "";
  const season = q.get("season") || LIVE_SEASON;
  if (!/^[a-z0-9:_-]{2,60}$/i.test(id)) return json({ error: "id required" }, { status: 400 });
  if (!/^\d{4}-\d{2}$/.test(season)) return json({ error: "bad season" }, { status: 400 });
  const s = blobStore();
  if (season !== LIVE_SEASON) {
    const series = await s.get(`seasons/${season}/pts/${id}`, { type: "json" });
    if (!series) return json({ error: "Not built yet for this season." }, { status: 404, maxAge: 60, sMaxAge: 60 });
    return json({ id, season, days: series.days, forecast: null }, { maxAge: 600, sMaxAge: 600 });
  }
  const [series, fc] = await Promise.all([s.get(`pts/${id}`, { type: "json" }), s.get(`ptf/${id}`, { type: "json" })]);
  if (!series && !fc) return json({ error: "Unknown point." }, { status: 404 });
  return json({ id, season, days: series?.days || [], forecast: fc || null }, { maxAge: 60, sMaxAge: 120 });
};
