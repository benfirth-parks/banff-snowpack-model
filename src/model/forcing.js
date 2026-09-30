// Builds hourly meteorological forcing for any location from
//   (1) forecast-model columns at a set of nodes (HRDPS/RDPS via Parks Wx Fx), and
//   (2) FTS station observations (via the Rockies Weather Data Explorer).
//
// Method (in the spirit of MeteoIO's IDW_LAPSE + station residual correction):
//   • Model first guess at the target: inverse-distance weighting of the nearest
//     model nodes, temperature moved to the target elevation with the hourly
//     lapse rate fitted across all nodes, precipitation scaled +5 %/100 m.
//   • Station correction: at each station the observation minus the model
//     first guess is a residual (temperature, humidity) or a log-ratio (wind,
//     24 h precipitation). Residuals are spread to the target with a Gaussian
//     kernel in horizontal distance AND elevation difference, shrunk toward zero
//     away from stations. Ridge-top stations therefore correct alpine cells and
//     valley stations correct valley cells.
//   • Forecast hours: residuals persist from the last observed hours and decay
//     (e-folding 12 h for temperature and wind, 6 h for humidity); precipitation
//     keeps the raw model amounts.
import { kmBetween } from "./domain.js";
import { newSnowDensity } from "./snowpack.js";

const SIGMA = 5.670e-8;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const ok = (v) => v !== null && v !== undefined && Number.isFinite(v);

function esatWater(T) { return 611.2 * Math.exp(17.67 * T / (T + 243.5)); }

export function longwaveIn(Ta, RH, cc) {
  // Prata (1996) clear-sky emissivity + Unsworth & Monteith (1975) cloud correction.
  const TaK = Ta + 273.15;
  const ea = (RH / 100) * esatWater(Ta) / 100; // hPa
  const w = 46.5 * ea / TaK;
  const ecs = 1 - (1 + w) * Math.exp(-Math.sqrt(1.2 + 3 * w));
  const c = clamp(cc, 0, 1);
  const eps = (1 - 0.84 * c) * ecs + 0.84 * c;
  return eps * SIGMA * TaK ** 4;
}

export function snowFraction(Ta) {
  // All snow at or below −0.5 °C, all rain at or above +1.5 °C.
  return clamp((1.5 - Ta) / 2, 0, 1);
}

const KT = { L: 20, Z: 400, k0: 0.15 };
const KW = { L: 20, Z: 300, k0: 0.15 };
const KP = { L: 25, Z: 800, k0: 0.4 };
const TAU_T = 12, TAU_RH = 6, TAU_U = 12;

export function prepareForcing({ times, nodes, stations, tA, windows }) {
  const N = times.length;
  const kA = times.indexOf(tA);
  const nodeList = nodes.filter((n) => ok(n.z));

  // Hourly lapse rate from the model nodes (least squares, clamped).
  const gamma = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    let n = 0, sz = 0, sT = 0, szz = 0, szT = 0;
    for (const nd of nodeList) {
      const T = nd.v.T[k];
      if (!ok(T)) continue;
      n++; sz += nd.z; sT += T; szz += nd.z * nd.z; szT += nd.z * T;
    }
    const den = n * szz - sz * sz;
    gamma[k] = n > 4 && den > 0 ? clamp((n * szT - sz * sT) / den, -0.01, 0.005) : -0.0065;
  }

  function nodeWeights(p) {
    const d = nodeList.map((nd, i) => ({ i, d: Math.max(0.5, kmBetween(p, nd)) }))
      .sort((a, b) => a.d - b.d).slice(0, 6);
    return d.map(({ i, d }) => [i, 1 / (d * d)]);
  }

  // Model first guess at a location for time index k.
  function modelAt(nw, z, k) {
    let wT = 0, T = 0, wR = 0, RH = 0, wU = 0, U = 0, ux = 0, uy = 0, wP = 0, P = 0;
    let wS = 0, ghi = 0, dirH = 0, difH = 0, cc = 0;
    for (const [i, w] of nw) {
      const v = nodeList[i].v, zn = nodeList[i].z;
      const t = v.T[k];
      if (ok(t)) { T += w * (t + gamma[k] * (z - zn)); wT += w; }
      if (ok(v.RH[k])) { RH += w * v.RH[k]; wR += w; }
      if (ok(v.U[k])) {
        U += w * v.U[k]; wU += w;
        if (ok(v.dir[k])) { const a = v.dir[k] * Math.PI / 180; ux += w * v.U[k] * Math.sin(a); uy += w * v.U[k] * Math.cos(a); }
      }
      if (ok(v.P[k])) { P += w * v.P[k] * clamp(1 + 0.0005 * (z - zn), 0.6, 1.8); wP += w; }
      if (ok(v.ghi[k])) {
        ghi += w * v.ghi[k]; dirH += w * (v.dirH[k] || 0); difH += w * (v.difH[k] || 0); cc += w * (v.cc[k] ?? 50); wS += w;
      }
    }
    let dir = Math.atan2(ux, uy) * 180 / Math.PI; if (dir < 0) dir += 360;
    return {
      T: wT ? T / wT : null, RH: wR ? RH / wR : null, U: wU ? U / wU : null, dir,
      P: wP ? P / wP : null, ghi: wS ? ghi / wS : 0, dirH: wS ? dirH / wS : 0, difH: wS ? difH / wS : 0, cc: wS ? cc / wS / 100 : 0.5,
    };
  }

  // ---- Station residuals -------------------------------------------------
  const st = stations.map((s) => {
    const nw = nodeWeights(s);
    const rT = new Array(N).fill(null), rRH = new Array(N).fill(null), rU = new Array(N).fill(null);
    const mP = new Array(N).fill(null), mT = new Array(N).fill(null);
    for (let k = 0; k <= kA && k < N; k++) {
      const m = modelAt(nw, s.z, k);
      mP[k] = m.P; mT[k] = m.T;
      const o = s.o;
      if (ok(o.T[k]) && ok(m.T)) rT[k] = clamp(o.T[k] - m.T, -15, 15);
      if (ok(o.RH[k]) && ok(m.RH)) rRH[k] = clamp(o.RH[k] - m.RH, -60, 60);
      if (s.wind && ok(o.U[k]) && ok(m.U)) rU[k] = clamp(Math.log((o.U[k] + 5) / (m.U + 5)), -1.1, 1.1);
    }
    // Mean residual over the last 6 observed hours → persisted into the forecast.
    const tail = (arr) => { const v = []; for (let k = kA; k >= 0 && k > kA - 12 && v.length < 6; k--) if (ok(arr[k])) v.push(arr[k]); return v.length >= 2 ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const mT_ = tail(rT), mRH_ = tail(rRH), mU_ = tail(rU);
    for (let k = kA + 1; k < N; k++) {
      const h = times[k] - tA;
      if (mT_ !== null) rT[k] = mT_ * Math.exp(-h / TAU_T);
      if (mRH_ !== null) rRH[k] = mRH_ * Math.exp(-h / TAU_RH);
      if (mU_ !== null) rU[k] = mU_ * Math.exp(-h / TAU_U);
    }
    // 24 h precipitation ratios over the analysis windows.
    const lnP = new Array(N).fill(null);
    const precipDiag = [];
    if (s.precip) {
      for (const [a, b, from = a] of windows) {
        if (a < 0 || b > kA) continue;
        let pm = 0, nm = 0, po = 0, no = 0, tsum = 0, tn = 0;
        for (let k = a; k <= b; k++) {
          if (ok(mP[k])) { pm += mP[k]; nm++; }
          if (ok(mT[k])) { tsum += mT[k] + (rT[k] || 0); tn++; }
          if (s.precip === "gauge" && ok(s.o.P[k])) { po += s.o.P[k]; no++; }
        }
        const tMean = tn ? tsum / tn : 0;
        let obs = null;
        if (s.precip === "gauge" && no >= (b - a + 1) * 0.75) obs = po * (tMean < 0 ? 1.2 : 1);
        if (s.precip === "hs") {
          const med = (ks) => { const v = ks.map((k) => s.o.HS[k]).filter(ok).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };
          const h0 = med([a - 1, a, a + 1, a + 2]);
          const h1 = med([b - 2, b - 1, b]);
          if (ok(h0) && ok(h1) && tMean < 1) {
            const dHS = h1 - h0;
            if (dHS >= 1.5) obs = dHS * 1.15 * newSnowDensity(tMean, 2) / 100;
            else if (pm >= 3) obs = 0.4 * pm; // HS says little/no gain: weak evidence the model is high
          }
        }
        if (obs === null || nm < (b - a + 1) * 0.75) continue;
        if (obs < 1 && pm < 1) continue; // dry both ways: no information
        const r = clamp(Math.log((obs + 1) / (pm + 1)), -1.1, 1.1);
        precipDiag.push({ a: times[a], b: times[b], obs: +obs.toFixed(1), model: +pm.toFixed(1) });
        for (let k = Math.max(0, from); k <= b; k++) lnP[k] = r;
      }
    }
    const kern = (p, K) => Math.exp(-((kmBetween(p, s) / K.L) ** 2) - (((p.z - s.z) / K.Z) ** 2));
    return { s, rT, rRH, rU, lnP, kern, precipDiag, bias: { T: mT_, RH: mRH_, U: mU_ } };
  });

  function weightsFor(p) {
    const nw = nodeWeights(p);
    const sw = [];
    for (let j = 0; j < st.length; j++) {
      const x = st[j];
      const kT = x.kern(p, KT), kW = x.s.wind ? x.kern(p, KW) : 0;
      const kP = x.s.precip ? x.kern(p, KP) * (x.s.precip === "gauge" ? 1 : 0.6) : 0;
      if (kT > 0.005 || kW > 0.005 || kP > 0.005) sw.push([j, kT, kW, kP]);
    }
    return { nw, sw, z: p.z };
  }

  function at(W, k) {
    const m = modelAt(W.nw, W.z, k);
    let sT = 0, wT = 0, sR = 0, wR = 0, sU = 0, wU = 0, sP = 0, wP = 0;
    for (const [j, kT, kW, kP] of W.sw) {
      const x = st[j];
      if (kT > 0.005 && ok(x.rT[k])) { sT += kT * x.rT[k]; wT += kT; }
      if (kT > 0.005 && ok(x.rRH[k])) { sR += kT * x.rRH[k]; wR += kT; }
      if (kW > 0.005 && ok(x.rU[k])) { sU += kW * x.rU[k]; wU += kW; }
      if (kP > 0.005 && ok(x.lnP[k])) { sP += kP * x.lnP[k]; wP += kP; }
    }
    const Ta = (m.T ?? 0) + (wT ? sT / (wT + KT.k0) : 0);
    const RH = clamp((m.RH ?? 80) + (wR ? sR / (wR + KT.k0) : 0), 5, 100);
    const Ukmh = Math.max(0, (m.U ?? 10) * Math.exp(wU ? sU / (wU + KW.k0) : 0));
    const P = Math.max(0, (m.P ?? 0) * Math.exp(wP ? sP / (wP + KP.k0) : 0));
    return {
      t: times[k], Ta, RH, U: Ukmh / 3.6, dir: m.dir, P, sf: snowFraction(Ta),
      ghi: m.ghi, dirH: m.dirH, difH: m.difH, cc: m.cc, lw: longwaveIn(Ta, RH, m.cc),
    };
  }

  function stationDiagnostics() {
    return st.map((x) => ({
      id: x.s.id, name: x.s.name, biasT: x.bias.T === null ? null : +x.bias.T.toFixed(2),
      biasRH: x.bias.RH === null ? null : +x.bias.RH.toFixed(1),
      windRatio: x.bias.U === null ? null : +Math.exp(x.bias.U).toFixed(2),
      precip: x.precipDiag.slice(-7),
    }));
  }

  return { times, kA, weightsFor, at, stationDiagnostics, gamma };
}

// 24 h windows ending at each 17:00-local snapshot hour up to the analysis end
// kA, as [startIdx, endIdx, assignFromIdx]. Hours after the last snapshot use a
// rolling 24 h window ending at kA.
export function snapshotWindows(times, kA, isSnap) {
  const w = [];
  let last = -1;
  for (let k = 0; k <= kA && k < times.length; k++) if (isSnap(times[k])) { w.push([k - 23, k, k - 23]); last = k; }
  if (kA > last && kA >= 23) w.push([kA - 23, kA, last + 1]);
  return w;
}
