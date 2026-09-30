import { blobStore, json } from "../lib/store.mjs";
import { getRegistry } from "../lib/reanalysis.mjs";

export default async () => {
  const s = blobStore();
  const meta = await s.get("meta", { type: "json" });
  if (!meta) return json({ error: "The model has not run yet." }, { status: 503, maxAge: 0, sMaxAge: 0 });
  const reg = await getRegistry(s);
  meta.seasons = reg.list.map(({ coverage, ...rest }) => rest);
  return json(meta, { maxAge: 60, sMaxAge: 120 });
};
