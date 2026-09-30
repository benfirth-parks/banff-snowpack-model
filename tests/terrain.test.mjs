// Terrain tiles: PNG decode + box averaging, with synthetic terrarium tiles.
//   node tests/terrain.test.mjs
import assert from "node:assert/strict";
import { deflateSync, crc32 } from "node:zlib";
import { boxElevations } from "../netlify/lib/terrain.mjs";

function chunk(type, data) {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0); b.write(type, 4, "ascii"); data.copy(b, 8);
  b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])) >>> 0, 8 + data.length);
  return b;
}
// Terrarium tile whose elevation = 1000 + 10·(global pixel row) so boxes have a known mean.
function tile(z, x, y) {
  const raw = Buffer.alloc(256 * (1 + 256 * 3));
  for (let r = 0; r < 256; r++) {
    raw[r * 769] = 0;
    const e = 1000 + 10 * ((y * 256 + r) % 200) + 32768;
    for (let c = 0; c < 256; c++) { const o = r * 769 + 1 + c * 3; raw[o] = Math.floor(e / 256); raw[o + 1] = e % 256; raw[o + 2] = 0; }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(256, 0); ihdr.writeUInt32BE(256, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
let fetched = 0;
const fetchImpl = async (url) => {
  fetched++;
  const [z, x, y] = url.match(/(\d+)\/(\d+)\/(\d+)\.png$/).slice(1).map(Number);
  const b = tile(z, x, y);
  return { ok: true, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) };
};
const boxes = [{ lat0: 51.4, lat1: 51.445, lon0: -116.4, lon1: -116.33 }, { lat0: 50.6, lat1: 50.645, lon0: -117.2, lon1: -117.13 }];
const r = await boxElevations(boxes, { zoom: 9, fetchImpl });
console.log(r, "tiles fetched", fetched);
for (const e of r) { assert.ok(e && e.mean >= 1000 && e.mean <= 3000); assert.ok(e.max >= e.mean); }
console.log("terrain test passed");
