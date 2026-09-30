import { blobStore, json } from "../lib/store.mjs";
import { getRegistry } from "../lib/reanalysis.mjs";

export default async () => {
  const s = blobStore();
  const [status, err, lock, slock, reg] = await Promise.all([
    s.get("status", { type: "json" }), s.get("status-error", { type: "json" }), s.get("lock", { type: "json" }),
    s.get("seasons/lock", { type: "json" }), getRegistry(s),
  ]);
  return json({
    status, lastError: err, running: !!(lock && Date.now() - lock.at < 15 * 60 * 1000),
    seasons: reg.list.map(({ dates, ...rest }) => ({ ...rest, days: (dates || []).length })),
    seasonRunning: slock && Date.now() - slock.at < 16 * 60 * 1000 ? slock.season : null,
  }, { maxAge: 0, sMaxAge: 0 });
};
