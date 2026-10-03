// Checks the station-correction interpolation and the time helpers.
//   node tests/forcing.test.mjs
import assert from "node:assert/strict";
import { prepareForcing, snapshotWindows } from "../src/model/forcing.js";
import { snapHour, isSnapHour, localDate, tzOffset } from "../src/model/time.js";

// --- time helpers across the DST change (1 Nov 2026) ---
assert.equal(tzOffset(Date.parse("2026-09-30T18:00:00Z") / 3.6e6), -6);
assert.equal(tzOffset(Date.parse("2026-12-15T18:00:00Z") / 3.6e6), -7);
assert.equal(new Date(snapHour("2026-09-30") * 3.6e6).toISOString(), "2026-09-30T23:00:00.000Z");
assert.equal(new Date(snapHour("2026-11-02") * 3.6e6).toISOString(), "2026-11-03T00:00:00.000Z");
assert.ok(isSnapHour(snapHour("2026-11-01")));
assert.equal(localDate(snapHour("2026-11-01")), "2026-11-01");
assert.equal(localDate(snapHour("2027-03-14")), "2027-03-14");

// --- forcing: a uniformly 2 °C-too-warm, 1.5×-too-wet model, corrected by one station ---
const t0 = Date.parse("2026-10-10T00:00:00Z") / 3.6e6;
const times = Array.from({ length: 96 }, (_, i) => t0 + i);
const tA = t0 + 47;
const mk = (lat, lon, z, T0) => ({
  id: `n${lat}${lon}`, lat, lon, z,
  v: {
    T: times.map(() => T0 - 0.0065 * (z - 2000) + 2), RH: times.map(() => 80), U: times.map(() => 20), dir: times.map(() => 270),
    P: times.map((t) => (t % 24 < 12 ? 1.5 : 0)), ghi: times.map(() => 0), dirH: times.map(() => 0), difH: times.map(() => 0), cc: times.map(() => 50),
  },
});
const nodes = [];
for (let a = 0; a < 5; a++) for (let b = 0; b < 5; b++) nodes.push(mk(51 + a * 0.2, -116.8 + b * 0.3, 1500 + 250 * ((a + b) % 5), -5));
const st = {
  id: "s1", name: "S1", lat: 51.4, lon: -116.2, z: 2300, wind: true, precip: "gauge",
  o: {
    T: times.map((t) => (t <= tA ? -5 - 0.0065 * 300 : null)), RH: times.map((t) => (t <= tA ? 90 : null)),
    U: times.map((t) => (t <= tA ? 40 : null)), HS: times.map(() => null), P: times.map((t) => (t <= tA ? (t % 24 < 12 ? 1.0 : 0) : null)),
  },
};
const kA = times.indexOf(tA);
const windows = snapshotWindows(times, kA, (t) => (t - t0) % 24 === 23);
const F = prepareForcing({ times, nodes, stations: [st], tA, windows });
assert.ok(Math.abs(F.gamma[10] + 0.0065) < 1e-6, "lapse rate recovered from the nodes");

const atStation = F.weightsFor({ lat: 51.4, lon: -116.2, z: 2300 });
const far = F.weightsFor({ lat: 51.9, lon: -115.5, z: 2300 });
const valley = F.weightsFor({ lat: 51.4, lon: -116.2, z: 1300 });
const k = 30;
const fs = F.at(atStation, k), ff = F.at(far, k), fv = F.at(valley, k);
const truth = -5 - 0.0065 * 300;
console.log(`T at station ${fs.Ta.toFixed(2)} (obs ${truth.toFixed(2)}), far ${ff.Ta.toFixed(2)}, same place 1000 m lower ${fv.Ta.toFixed(2)}`);
assert.ok(Math.abs(fs.Ta - truth) < 0.4, "station cell pulled to the observation");
assert.ok(Math.abs(ff.Ta - (truth + 2)) < 0.2, "far cell keeps the model");
assert.ok(fv.Ta - (truth + 6.5) > 1.5, "valley cell barely corrected by a ridge station");
const fc6 = F.at(atStation, kA + 6), fc36 = F.at(atStation, kA + 36);
console.log(`forecast correction at +6 h ${(fc6.Ta - truth - 2).toFixed(2)}, +36 h ${(fc36.Ta - truth - 2).toFixed(2)}`);
// The last residual (−2 °C) fades into the learned per-hour bias, which after two
// days of samples is still shrunk toward zero.
assert.ok(fc6.Ta - truth - 2 < -1 && fc36.Ta - truth - 2 > -1.5 && fc36.Ta - truth - 2 < -0.3, "correction fades into a persistent bias");
// With a full fortnight of bias state the forecast keeps most of the correction.
let bias = null;
for (let d = 0; d < 14; d++) bias = prepareForcing({ times, nodes, stations: [st], tA, windows, bias, biasFrom: 0 }).bias;
const F14 = prepareForcing({ times, nodes, stations: [st], tA, windows, bias, biasFrom: kA + 1 });
const fc36b = F14.at(F14.weightsFor({ lat: 51.4, lon: -116.2, z: 2300 }), kA + 36);
console.log(`forecast correction at +36 h after two weeks of the same bias ${(fc36b.Ta - truth - 2).toFixed(2)}`);
assert.ok(fc36b.Ta - truth - 2 < -1.3, "learned bias persists");
const pIdx = times.findIndex((t) => t > t0 + 24 && t % 24 < 12);
console.log(`precip at station ${F.at(atStation, pIdx).P.toFixed(2)} mm/h (model 1.5 ×elev, gauge 1.0×1.2 undercatch)`);
assert.ok(F.at(atStation, pIdx).P < 1.45, "precip scaled toward the gauge");
console.log(`wind at station ${(fs.U * 3.6).toFixed(1)} km/h (model 20, obs 40)`);
assert.ok(fs.U * 3.6 > 30);
// --- elevation trend: ridges 3 °C warmer than the model, valleys 2 °C colder ---
const ridgeValley = [];
for (let i = 0; i < 6; i++) {
  const z = 1300 + 300 * i, err = -2 + 5 * (z - 1300) / 1500;
  ridgeValley.push({
    id: `rv${i}`, name: `RV${i}`, lat: 51.0 + 0.15 * i, lon: -116.8 + 0.25 * i, z, wind: false, precip: null,
    o: { T: times.map((t) => (t <= tA ? -5 - 0.0065 * (z - 2000) + 2 + err : null)), RH: times.map(() => null), U: times.map(() => null), HS: times.map(() => null), P: times.map(() => null) },
  });
}
const Fe = prepareForcing({ times, nodes, stations: ridgeValley, tA, windows: [] });
const away = (z) => Fe.at(Fe.weightsFor({ lat: 52.1, lon: -115.4, z }), 30).Ta - (-5 - 0.0065 * (z - 2000) + 2);
console.log(`trend ${Fe.trend.b} °C/km; correction far from any station at 2800 m ${away(2800).toFixed(2)}, 1400 m ${away(1400).toFixed(2)}`);
assert.ok(away(2800) > 1.5 && away(1400) < -0.8, "ridge/valley pattern carried to places without a station");

console.log("forcing + time tests passed");
