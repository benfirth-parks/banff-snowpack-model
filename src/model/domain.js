// Model domain: stations, named profile points, the simulation grid and the
// forecast-model query nodes.

// FTS stations read from the Rockies Weather Data Explorer (/api/fts). Positions
// and elevations are copied from the explorer's station list.
//   wind:   anemometer is representative (the explorer hides the sheltered ones)
//   precip: "gauge" = weighing gauge, "hs" = precipitation from snow-height gain,
//           null = not used for precipitation (e.g. summer tipping buckets)
export const STATIONS = [
  { id: "fts-bosup", name: "Bosworth Upper", lat: 51.46954, lon: -116.34969, z: 2745, park: "Yoho", wind: true, precip: null },
  { id: "fts-boslo", name: "Bosworth Lower", lat: 51.45722, lon: -116.357834, z: 2210, park: "Yoho", wind: false, precip: "hs" },
  { id: "fts-bowsummit", name: "Bow Summit", lat: 51.709373, lon: -116.47904, z: 2040, park: "Banff", wind: false, precip: "hs" },
  { id: "fts-bowprecip", name: "Bow Summit Precip Gauge", lat: 51.712, lon: -116.481, z: 2040, park: "Banff", wind: false, precip: "gauge", noPoint: true },
  { id: "fts-lookout", name: "Lookout", lat: 51.07417, lon: -115.754295, z: 2640, park: "Banff", wind: true, precip: null },
  { id: "fts-simplo", name: "Simpson Lower", lat: 50.98507, lon: -115.984215, z: 2115, park: "Kootenay", wind: false, precip: "hs" },
  { id: "fts-simpup", name: "Simpson Upper", lat: 50.990124, lon: -115.991165, z: 2320, park: "Kootenay", wind: true, precip: null },
  { id: "fts-stanley", name: "Stanley Lower", lat: 51.184673, lon: -116.0892, z: 1930, park: "Kootenay", wind: false, precip: "hs" },
  { id: "fts-sunshine", name: "Sunshine Village", lat: 51.078358, lon: -115.782455, z: 2200, park: "Banff", wind: false, precip: "hs" },
  { id: "fts-vulture", name: "Vulture Peak", lat: 51.6244, lon: -116.47188, z: 2930, park: "Banff", wind: true, precip: null },
  { id: "fts-whymper", name: "Whymper", lat: 51.2126, lon: -116.11409, z: 2600, park: "Kootenay", wind: true, precip: null },
  { id: "fts-boulder", name: "Boulder Creek", lat: 51.3665, lon: -116.5264, z: 1650, park: "Yoho", wind: true, precip: null },
  { id: "fts-pikarun", name: "Pika Run", lat: 51.442, lon: -116.217, z: 2200, park: "Banff", wind: true, precip: "hs" },
  { id: "fts-vermillion", name: "Vermilion Crossing", lat: 51.0194, lon: -115.9766, z: 1310, park: "Kootenay", wind: true, precip: null },
  { id: "fts-lakelouise", name: "Lake Louise", lat: 51.4281, lon: -116.2093, z: 1730, park: "Banff", wind: true, precip: null },
  { id: "fts-castle", name: "Castle", lat: 51.2796, lon: -115.9562, z: 1450, park: "Banff", wind: true, precip: null },
  { id: "fts-skoki", name: "Skoki", lat: 51.482, lon: -116.217, z: 2160, park: "Banff", wind: true, precip: "gauge" },
  { id: "fts-coleman", name: "Coleman Avalanche Control", lat: 52.09691, lon: -116.92602, z: 2176, park: "Banff", wind: true, precip: "hs" },
  { id: "fts-bigbend", name: "Big Bend", lat: 52.193, lon: -117.156, z: 2125, park: "Banff", wind: true, precip: "hs" },
  { id: "fts-saskcrossing", name: "Saskatchewan Crossing", lat: 51.9681, lon: -116.7145, z: 1392, park: "Banff", wind: true, precip: null },
];

// Named forecast points (same list and spelling as Parks Wx Fx / Avalanche Canada),
// each simulated at three elevation bands.
export const BANDS = [
  { id: "ALP", z: 2500 },
  { id: "TL", z: 2150 },
  { id: "BTL", z: 1750 },
];
export const NAMED_POINTS = [
  { id: "parker-ridge", name: "Parker Ridge", lat: 52.228, lon: -117.089, park: "Banff" },
  { id: "coleman-cliffs", name: "Coleman Cliffs", lat: 51.95, lon: -116.72, park: "Banff" },
  { id: "mt-wilson", name: "Mt Wilson", lat: 52.018, lon: -116.801, park: "Banff" },
  { id: "observation-pk", name: "Observation Pk", lat: 51.742, lon: -116.467, park: "Banff" },
  { id: "mt-gordon", name: "Mt.Gordon", lat: 51.606, lon: -116.513, park: "Yoho" },
  { id: "emerald-pk", name: "Emerald Pk", lat: 51.453, lon: -116.556, park: "Yoho" },
  { id: "mt-dennis", name: "Mt Dennis", lat: 51.401, lon: -116.492, park: "Yoho" },
  { id: "mt-bosworth", name: "Mt.Bosworth", lat: 51.465, lon: -116.334, park: "Yoho" },
  { id: "ll-richardson", name: "LL/Mt Richardson", lat: 51.492, lon: -116.126, park: "Banff" },
  { id: "mt-whymper", name: "Mt Whymper", lat: 51.206, lon: -116.045, park: "Kootenay" },
  { id: "cascade", name: "Banff/Cascade Mtn", lat: 51.268, lon: -115.582, park: "Banff" },
  { id: "mt-bourgeau", name: "Mt Bourgeau", lat: 51.132, lon: -115.775, park: "Banff" },
  { id: "simpson", name: "Simpson", lat: 51.017, lon: -115.95, park: "Kootenay" },
];

// Simulation grid (~5 km cells) over Banff, Yoho, Kootenay and the southern
// Icefields Parkway.
export const GRID = { lat0: 50.6, lat1: 52.25, lon0: -117.2, lon1: -115.3, dLat: 0.045, dLon: 0.07 };

export function gridCells() {
  const cells = [];
  const nR = Math.round((GRID.lat1 - GRID.lat0) / GRID.dLat);
  const nC = Math.round((GRID.lon1 - GRID.lon0) / GRID.dLon);
  for (let r = 0; r < nR; r++) {
    for (let c = 0; c < nC; c++) {
      const lat = +(GRID.lat0 + (r + 0.5) * GRID.dLat).toFixed(4);
      const lon = +(GRID.lon0 + (c + 0.5) * GRID.dLon).toFixed(4);
      cells.push({ id: `c${r}_${c}`, r, c, lat, lon });
    }
  }
  return { nR, nC, cells };
}

// Forecast-model query nodes: every station, every named point, plus a coarse
// fill grid so that no cell is far from a model column.
export function modelNodes() {
  const nodes = [];
  for (const s of STATIONS) if (!s.noPoint) nodes.push({ id: s.id, lat: s.lat, lon: s.lon });
  for (const p of NAMED_POINTS) nodes.push({ id: p.id, lat: p.lat, lon: p.lon });
  for (let lat = 50.7; lat <= 52.25; lat += 0.3) {
    for (let lon = -117.1; lon <= -115.3; lon += 0.35) {
      nodes.push({ id: `n${lat.toFixed(2)}_${lon.toFixed(2)}`, lat: +lat.toFixed(3), lon: +lon.toFixed(3) });
    }
  }
  return nodes;
}

export const ASPECTS = [
  { id: "flat", slope: 0, aspect: 0 },
  { id: "N", slope: 38, aspect: 0 },
  { id: "E", slope: 38, aspect: 90 },
  { id: "S", slope: 38, aspect: 180 },
  { id: "W", slope: 38, aspect: 270 },
];

export function kmBetween(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180 * Math.cos((a.lat + b.lat) / 2 * Math.PI / 180);
  return R * Math.sqrt(dLat * dLat + dLon * dLon);
}
