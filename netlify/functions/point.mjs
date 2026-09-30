import { blobStore, json } from "../lib/store.mjs";

export default async (req) => {
  const id = new URL(req.url).searchParams.get("id") || "";
  if (!/^[a-z0-9:_-]{2,60}$/i.test(id)) return json({ error: "id required" }, { status: 400 });
  const s = blobStore();
  const [series, fc] = await Promise.all([s.get(`pts/${id}`, { type: "json" }), s.get(`ptf/${id}`, { type: "json" })]);
  if (!series && !fc) return json({ error: "Unknown point." }, { status: 404 });
  return json({ id, days: series?.days || [], forecast: fc || null }, { maxAge: 60, sMaxAge: 120 });
};
