// Data access: station actuals (Rockies Weather Data Explorer), forecast-model
// columns (Parks Wx Fx cached Open-Meteo proxy, falling back to Open-Meteo
// directly), and terrain elevations (Open-Meteo elevation API, 90 m DEM).
// All sources are free and keyless.

export const EXPLORER = "https://rockiesweatherdataexplorer.netlify.app";
export const FXTOOL = "https://rockiesweatherfxtool.netlify.app";
const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";
const OPEN_METEO_HIST = "https://historical-forecast-api.open-meteo.com/v1/forecast";
const ELEVATION = "https://api.open-meteo.com/v1/elevation";

const UA = { "user-agent": "banff-snowpack-model (+netlify function)" };
const ok = (v) => v !== null && v !== undefined && Number.isFinite(v);

async function fetchJSON(url, { timeoutMs = 25000, retries = 1 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: UA, signal: ctl.signal });
      const text = await res.text();
      if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 160)}`);
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// ---- Station actuals --------------------------------------------------------
// Returns { [stationId]: [{ t (epoch hour), T, RH, U, dir, HS, P }] } — P is the
// hourly precipitation increment in mm (from the increment channel, or from the
// change in the accumulating total).
export async function fetchStationObs(stations, hours) {
  const out = {};
  const errors = [];
  await Promise.all(stations.map(async (s) => {
    try {
      const rows = await fetchJSON(`${EXPLORER}/api/fts?station=${encodeURIComponent(s.id)}&hours=${Math.ceil(hours)}`, { retries: 1 });
      const recs = [];
      let prevTotal = null;
      for (const r of Array.isArray(rows) ? rows : []) {
        const ms = Date.parse(r.measurementDateTime);
        if (!Number.isFinite(ms)) continue;
        const t = Math.round(ms / 3600000);
        let P = null;
        if (ok(r.precipIncr)) P = r.precipIncr;
        else if (ok(r.precipTotal)) {
          if (ok(prevTotal)) { const d = r.precipTotal - prevTotal; P = d >= 0 && d < 40 ? d : null; }
          prevTotal = r.precipTotal;
        }
        recs.push({
          t,
          T: ok(r.airTempAvg) && r.airTempAvg > -50 && r.airTempAvg < 35 ? r.airTempAvg : null,
          RH: ok(r.relativeHumidity) && r.relativeHumidity > 1 ? Math.min(100, r.relativeHumidity) : null,
          U: ok(r.windSpeedAvg) && r.windSpeedAvg >= 0 && r.windSpeedAvg < 250 ? r.windSpeedAvg : null,
          dir: ok(r.windDirAvg) ? r.windDirAvg : null,
          HS: ok(r.snowHeight) && r.snowHeight >= 0 && r.snowHeight < 900 ? r.snowHeight : null,
          P: ok(P) && P >= 0 && P < 40 ? P : null,
        });
      }
      // Temperature spike filter: drop values > 8 °C off the median of ±2 h.
      for (let i = 2; i < recs.length - 2; i++) {
        const w = [recs[i - 2].T, recs[i - 1].T, recs[i + 1].T, recs[i + 2].T].filter(ok).sort((a, b) => a - b);
        if (w.length >= 3 && ok(recs[i].T) && Math.abs(recs[i].T - w[Math.floor(w.length / 2)]) > 8) recs[i].T = null;
      }
      out[s.id] = recs;
    } catch (e) {
      errors.push(`${s.id}: ${e.message}`);
      out[s.id] = [];
    }
  }));
  return { obs: out, errors };
}

// ---- Forecast-model columns -------------------------------------------------
const VARS = [
  ["T", "temperature_2m"], ["RH", "relative_humidity_2m"], ["P", "precipitation"],
  ["U", "wind_speed_10m"], ["dir", "wind_direction_10m"], ["ghi", "shortwave_radiation"],
  ["dirH", "direct_radiation"], ["difH", "diffuse_radiation"], ["cc", "cloud_cover"],
];
export const MODELS = ["gem_hrdps_continental", "gem_regional"];

function modelQuery(chunk, models, extra) {
  const p = new URLSearchParams();
  p.set("latitude", chunk.map((n) => n.lat).join(","));
  p.set("longitude", chunk.map((n) => n.lon).join(","));
  p.set("hourly", VARS.map((v) => v[1]).join(","));
  p.set("models", models.join(","));
  for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
  p.set("timeformat", "unixtime");
  p.set("timezone", "GMT");
  return p.toString();
}

// Model columns for one chunk of nodes from an Open-Meteo response. Where
// several models are requested, the first model with a value wins each hour.
function parseModel(chunk, data, models, into, allNodes) {
  const list = Array.isArray(data) ? data : [data];
  chunk.forEach((n, i) => {
    const d = list[i];
    if (!d || !d.hourly) return;
    const time = d.hourly.time.map((s) => Math.round(s / 3600));
    const v = {};
    for (const [k, name] of VARS) {
      const cols = models.map((m) => d.hourly[`${name}_${m}`] || []);
      const plain = d.hourly[name] || [];
      v[k] = time.map((_, j) => {
        for (const c of cols) if (ok(c[j])) return c[j];
        return ok(plain[j]) ? plain[j] : null;
      });
    }
    into[allNodes.indexOf(n)] = { id: n.id, lat: n.lat, lon: n.lon, z: d.elevation, t0: time[0], v };
  });
}

const chunksOf = (a, n) => { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };

// Returns { nodes: [{ id, lat, lon, z, t0, v: { T: [], … } }], source, errors }
// where v arrays are hourly from epoch hour t0. HRDPS (2.5 km) is used wherever
// it has data; RDPS (10 km) fills the hours beyond HRDPS's 48 h horizon.
export async function fetchModel(nodes, pastDays, forecastDays = 4) {
  const errors = [];
  const sources = new Set();
  const out = [];
  await Promise.all(chunksOf(nodes, 20).map(async (chunk, ci) => {
    const q = modelQuery(chunk, MODELS, { past_days: pastDays, forecast_days: forecastDays });
    let data;
    try {
      data = await fetchJSON(`${FXTOOL}/api/forecast?${q}`, { retries: 1, timeoutMs: 30000 });
      sources.add("Parks Wx Fx proxy");
    } catch (e) {
      errors.push(`fx proxy chunk ${ci}: ${e.message}`);
      data = await fetchJSON(`${OPEN_METEO}?${q}`, { retries: 1, timeoutMs: 30000 });
      sources.add("Open-Meteo direct");
    }
    parseModel(chunk, data, MODELS, out, nodes);
  }));
  return { nodes: out.filter(Boolean), source: [...sources].join(" + "), errors };
}

// Archived model runs for past seasons (Open-Meteo Historical Forecast API:
// HRDPS archived from March 2023, RDPS from November 2022). HRDPS alone is
// requested first; RDPS is fetched only for columns with gaps, which keeps the
// weighted request cost down. Dates are UTC YYYY-MM-DD, inclusive.
export async function fetchModelHistory(nodes, startDate, endDate) {
  const errors = [];
  const out = [];
  for (const chunk of chunksOf(nodes, 20)) {
    const q = modelQuery(chunk, [MODELS[0]], { start_date: startDate, end_date: endDate });
    const data = await fetchJSON(`${OPEN_METEO_HIST}?${q}`, { retries: 2, timeoutMs: 45000 });
    parseModel(chunk, data, [MODELS[0]], out, nodes);
  }
  const gappy = nodes.filter((n, i) => !out[i] || out[i].v.T.filter((x) => x === null).length > out[i].v.T.length * 0.02);
  if (gappy.length) {
    const fill = [];
    for (const chunk of chunksOf(gappy, 20)) {
      try {
        const q = modelQuery(chunk, MODELS, { start_date: startDate, end_date: endDate });
        const data = await fetchJSON(`${OPEN_METEO_HIST}?${q}`, { retries: 1, timeoutMs: 45000 });
        parseModel(chunk, data, MODELS, fill, gappy);
      } catch (e) { errors.push(`RDPS gap fill: ${e.message}`); }
    }
    gappy.forEach((n, j) => { if (fill[j]) out[nodes.indexOf(n)] = fill[j]; });
  }
  return { nodes: out.filter(Boolean), source: gappy.length ? "Open-Meteo archive (HRDPS, RDPS gap-fill)" : "Open-Meteo archive (HRDPS)", errors };
}

// ---- Terrain ----------------------------------------------------------------
export async function fetchElevations(points) {
  const out = new Array(points.length).fill(null);
  const chunks = [];
  for (let i = 0; i < points.length; i += 100) chunks.push(i);
  for (let g = 0; g < chunks.length; g += 6) {
    await Promise.all(chunks.slice(g, g + 6).map(async (i) => {
      const part = points.slice(i, i + 100);
      const q = `latitude=${part.map((p) => p.lat.toFixed(5)).join(",")}&longitude=${part.map((p) => p.lon.toFixed(5)).join(",")}`;
      const d = await fetchJSON(`${ELEVATION}?${q}`, { retries: 2 });
      (d.elevation || []).forEach((z, j) => { out[i + j] = ok(z) ? z : null; });
    }));
  }
  return out;
}
