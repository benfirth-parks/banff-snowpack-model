// Time helpers. The model runs on whole UTC hours ("epoch hours" = ms / 3.6e6).
// Daily snapshots are taken at 17:00 Mountain time (America/Edmonton), which is
// what the map shows for each date — the same end-of-day convention AVID uses.

export const TZ = "America/Edmonton";
export const SNAP_LOCAL_HOUR = 17;

const offCache = new Map();
// UTC offset in hours (e.g. −6 for MDT, −7 for MST) at a given epoch hour.
export function tzOffset(epochHour) {
  const key = Math.floor(epochHour / 6);
  if (offCache.has(key)) return offCache.get(key);
  const s = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "shortOffset" })
    .formatToParts(new Date(epochHour * 3600000)).find((p) => p.type === "timeZoneName").value;
  const m = /GMT([+-]\d+)(?::(\d+))?/.exec(s);
  const off = m ? Number(m[1]) + (m[2] ? Math.sign(Number(m[1])) * Number(m[2]) / 60 : 0) : -7;
  offCache.set(key, off);
  return off;
}

export const nowHour = () => Math.floor(Date.now() / 3600000);

// Local calendar date string (YYYY-MM-DD) of an epoch hour.
export function localDate(epochHour) {
  const d = new Date((epochHour + tzOffset(epochHour)) * 3600000);
  return d.toISOString().slice(0, 10);
}

// Epoch hour of the 17:00 local snapshot on a local date.
export function snapHour(dateStr) {
  const base = Date.parse(dateStr + "T00:00:00Z") / 3600000 + SNAP_LOCAL_HOUR;
  // Try the two possible offsets; pick the one consistent with itself.
  for (const off of [-6, -7, -5, -8]) {
    const t = base - off;
    if (tzOffset(t) === off) return t;
  }
  return base + 7;
}

export function isSnapHour(epochHour) {
  const d = new Date((epochHour + tzOffset(epochHour)) * 3600000);
  return d.getUTCHours() === SNAP_LOCAL_HOUR;
}

export function addDays(dateStr, n) {
  const d = new Date(Date.parse(dateStr + "T12:00:00Z") + n * 86400000);
  return d.toISOString().slice(0, 10);
}
