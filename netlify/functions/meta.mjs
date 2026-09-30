import { blobStore, json } from "../lib/store.mjs";

export default async () => {
  const meta = await blobStore().get("meta", { type: "json" });
  if (!meta) return json({ error: "The model has not run yet." }, { status: 503, maxAge: 0, sMaxAge: 0 });
  return json(meta, { maxAge: 60, sMaxAge: 120 });
};
