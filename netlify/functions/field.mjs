import { blobStore, json } from "../lib/store.mjs";

export default async (req) => {
  const date = new URL(req.url).searchParams.get("date") || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "date=YYYY-MM-DD required" }, { status: 400 });
  const f = await blobStore().get(`field/${date}`, { type: "json" });
  if (!f) return json({ error: `No simulation for ${date}.` }, { status: 404, maxAge: 60, sMaxAge: 60 });
  return json(f, { maxAge: 60, sMaxAge: 120 });
};
