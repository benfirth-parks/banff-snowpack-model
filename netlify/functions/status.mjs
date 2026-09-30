import { blobStore, json } from "../lib/store.mjs";

export default async () => {
  const s = blobStore();
  const [status, err, lock] = await Promise.all([
    s.get("status", { type: "json" }), s.get("status-error", { type: "json" }), s.get("lock", { type: "json" }),
  ]);
  return json({ status, lastError: err, running: !!(lock && Date.now() - lock.at < 15 * 60 * 1000) }, { maxAge: 0, sMaxAge: 0 });
};
