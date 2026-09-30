// Cell elevations from the AWS Open Data "terrarium" terrain tiles (Mapzen),
// the same keyless tiles the map's hillshade uses. No rate limits, and we can
// average every pixel inside a cell instead of a handful of point samples.
//   elevation (m) = R·256 + G + B/256 − 32768
import { inflateSync } from "node:zlib";

const TILE_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

// Minimal PNG decoder: 8-bit greyscale/RGB/RGBA, non-interlaced (all terrarium tiles are 8-bit RGB).
export function decodePNG(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error("not a PNG");
  let pos = 8, width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (depth !== 8 || interlace) throw new Error(`unsupported PNG (depth ${depth}, interlace ${interlace})`);
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype];
  if (!bpp) throw new Error(`unsupported PNG colour type ${ctype}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const b = y > 0 ? out[dst - stride + i] : 0;
      const c = i >= bpp && y > 0 ? out[dst - stride + i - bpp] : 0;
      let v;
      switch (f) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break; }
        default: throw new Error(`bad PNG filter ${f}`);
      }
      out[dst + i] = v & 255;
    }
  }
  return { width, height, bpp, data: out };
}

const lon2x = (lon, n) => ((lon + 180) / 360) * n;
const lat2y = (lat, n) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n; };

// Mean elevation of each lat/lon box: boxes = [{ lat0, lat1, lon0, lon1 }].
export async function boxElevations(boxes, { zoom = 9, fetchImpl = fetch } = {}) {
  const n = 2 ** zoom;
  const need = new Set();
  for (const b of boxes) {
    for (let x = Math.floor(lon2x(b.lon0, n)); x <= Math.floor(lon2x(b.lon1, n)); x++)
      for (let y = Math.floor(lat2y(b.lat1, n)); y <= Math.floor(lat2y(b.lat0, n)); y++) need.add(`${x}/${y}`);
  }
  const tiles = new Map();
  const keys = [...need];
  for (let i = 0; i < keys.length; i += 6) {
    await Promise.all(keys.slice(i, i + 6).map(async (k) => {
      const [x, y] = k.split("/").map(Number);
      const res = await fetchImpl(TILE_URL(zoom, x, y));
      if (!res.ok) throw new Error(`terrain tile ${zoom}/${k}: ${res.status}`);
      tiles.set(k, decodePNG(Buffer.from(await res.arrayBuffer())));
    }));
  }
  const elevAt = (px, py) => {
    const tx = Math.floor(px / 256), ty = Math.floor(py / 256);
    const t = tiles.get(`${tx}/${ty}`);
    if (!t) return null;
    const ix = Math.min(255, Math.floor(px - tx * 256)), iy = Math.min(255, Math.floor(py - ty * 256));
    const o = (iy * t.width + ix) * t.bpp;
    return t.data[o] * 256 + t.data[o + 1] + t.data[o + 2] / 256 - 32768;
  };
  return boxes.map((b) => {
    const x0 = lon2x(b.lon0, n) * 256, x1 = lon2x(b.lon1, n) * 256;
    const y0 = lat2y(b.lat1, n) * 256, y1 = lat2y(b.lat0, n) * 256;
    let s = 0, c = 0, max = -Infinity;
    for (let py = Math.ceil(y0); py < y1; py++) for (let px = Math.ceil(x0); px < x1; px++) {
      const e = elevAt(px + 0.5, py + 0.5);
      if (e === null || e < -500) continue;
      s += e; c++; if (e > max) max = e;
    }
    return c ? { mean: Math.round(s / c), max: Math.round(max) } : null;
  });
}
