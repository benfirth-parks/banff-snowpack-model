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
//     24 h precipitation).
//   • Temperature profile: each hour, the temperature residuals are fitted
//     against station elevation (a + b·Δz, shrunk toward zero), so the model's
//     vertical profile is corrected everywhere, e.g. ridge-top inversions the
//     model misses. What is left at each station (the local residual) is spread
//     to the target with a Gaussian kernel in horizontal distance AND elevation
//     difference, shrunk toward zero away from stations. Ridge-top stations
//     therefore correct alpine cells and valley stations correct valley cells.
//   • Forecast hours: the last observed residuals fade (e-folding 6 h for
//     temperature and humidity, 12 h for wind) into a persistent bias learned
//     per station and hour of day over the last ~2 weeks of analysis (`bias`,
//     an exponentially weighted state carried between runs). Precipitation
//     keeps the raw model amounts.
import { kmBetween } from "./domain.js";
import { newSnowDensity, createSim, stepHour, snowDepth, packSim, unpackSim } from "./snowpack.js";

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

// Quality-controlled snow height (cm) up to index kA. Each reading is checked
// against the last accepted one:
//   • a rise faster than snow can fall (10 cm plus 6 cm/h, counting at most
//     6 h of gap) or a drop of more than 10 cm plus 3 cm/h is dropped;
//   • a jump of more than 8 cm either way must also hold: most of the readings
//     in the next 12 h have to stay at the new level. Spikes, stuck error values
//     (Bow Summit's 220.9) and Sunshine's evening readings near 190 cm fail
//     this, while a real storm or melt does not;
// then a 3-hour running median.
export function cleanHS(raw, kA = raw.length - 1) {
  const n = Math.min(raw.length, kA + 1);
  const valid = (v) => ok(v) && v >= -5 && v <= 600;
  const keep = new Array(raw.length).fill(null);
  const first = [];
  for (let k = 0; k < n && first.length < 12; k++) if (valid(raw[k])) first.push(raw[k]);
  first.sort((a, b) => a - b);
  let last = first.length ? first[first.length >> 1] : null, lastK = -1;
  const holds = (k, v, up) => {
    let c = 0, m = 0;
    for (let j = k + 1; j <= Math.min(n - 1, k + 12); j++) {
      if (!valid(raw[j])) continue;
      m++;
      if (up ? raw[j] >= v - 8 : raw[j] <= v + 8) c++;
    }
    return m >= 3 ? c >= 0.6 * m : m > 0 ? c === m : true;
  };
  for (let k = 0; k < n; k++) {
    const v = raw[k];
    if (!valid(v) || last === null) continue;
    const dt = lastK < 0 ? 1 : Math.min(6, k - lastK);
    const d = v - last;
    let good = d <= 10 + 6 * dt && -d <= 10 + 3 * (k - lastK);
    if (good && Math.abs(d) > 8) good = holds(k, v, d > 0);
    if (good) { keep[k] = Math.max(0, v); last = v; lastK = k; }
    else if (k - lastK > 72 && holds(k, v, true) && holds(k, v, false)) { keep[k] = Math.max(0, v); last = v; lastK = k; } // long gap: start again
  }
  const out = new Array(raw.length).fill(null);
  for (let k = 0; k < n; k++) {
    const w = [keep[k - 1], keep[k], keep[k + 1]].filter(ok).sort((a, b) => a - b);
    if (ok(keep[k])) out[k] = w[Math.floor(w.length / 2)];
  }
  return out;
}

export function snowFraction(Ta) {
  // 50 % snow at +1 °C air temperature: all snow at or below 0 °C, all rain at
  // or above +2 °C (mountain rain–snow transitions sit at roughly 1–2 °C).
  return clamp((2 - Ta) / 2, 0, 1);
}

const KT = { L: 20, Z: 400, k0: 0.15 };
const KW = { L: 20, Z: 300, k0: 0.15 };
const KP = { L: 40, Z: 1200, k0: 0.1 };
const TAU_T = 6, TAU_RH = 6, TAU_U = 12;
// Elevation trend of the temperature residuals: reference height, ridge
// penalties (in "stations' worth" of shrinkage toward zero) and slope limit.
const Z_REF = 2000, LAM_A = 1, LAM_B = 0.5, B_MAX = 8; // b in °C per km
const BIAS_ALPHA = 1 / 14; // one sample per hour of day per day → ~2-week memory

// Persistent-bias state: per station, exponentially weighted residual means by
// UTC hour of day ({ v, w, n } per bin; the estimate is v / w, shrunk while n is small).
export function emptyBias() { return { version: 1, trend: newBins(2), st: {} }; }
function newBins(m) { return Array.from({ length: m }, () => ({ v: new Array(24).fill(0), w: new Array(24).fill(0), n: new Array(24).fill(0) })); }
function binUpdate(b, h, x) { b.v[h] += BIAS_ALPHA * (x - b.v[h]); b.w[h] += BIAS_ALPHA * (1 - b.w[h]); b.n[h]++; }
function binEst(b, h) {
  // Smooth over neighbouring hours (1-2-1) and shrink toward zero while samples are few.
  let v = 0, w = 0, n = 0;
  for (const [dh, f] of [[-1, 1], [0, 2], [1, 1]]) {
    const j = (h + dh + 24) % 24;
    if (b.w[j] > 0) { v += f * b.v[j] / b.w[j]; w += f; n += f * b.n[j]; }
  }
  if (!w) return null;
  n /= 4;
  return (v / w) * n / (n + 3);
}

export function prepareForcing({ times, nodes, stations, tA, windows, bias = null, biasFrom = 0, trace = null }) {
  const N = times.length;
  const kA = times.indexOf(tA);
  const nodeList = nodes.filter((n) => ok(n.z));
  const B = bias && bias.version === 1 ? JSON.parse(JSON.stringify(bias)) : emptyBias();
  const hod = (k) => ((times[k] % 24) + 24) % 24;

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
    return { s, nw, rT, rRH, rU, mP, mT, x: (s.z - Z_REF) / 1000 };
  });

  // Hourly elevation trend of the temperature residuals (ridge regression).
  const trA = new Float64Array(N), trB = new Float64Array(N);
  const fitTrend = (k) => {
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const x of st) { const r = x.rT[k]; if (!ok(r)) continue; n++; sx += x.x; sy += r; sxx += x.x * x.x; sxy += x.x * r; }
    if (n < 4) return [0, 0];
    // Minimise Σ(r − a − b·x)² + LAM_A·a² + LAM_B·b²
    const a11 = n + LAM_A, a12 = sx, a22 = sxx + LAM_B;
    const det = a11 * a22 - a12 * a12;
    const a = (sy * a22 - sxy * a12) / det;
    const b = clamp((a11 * sxy - a12 * sy) / det, -B_MAX, B_MAX);
    return [(sy - b * sx) / (n + LAM_A), b];
  };
  for (let k = 0; k <= kA && k < N; k++) { const [a, b] = fitTrend(k); trA[k] = a; trB[k] = b; }
  // Local residuals: what the trend leaves at each station.
  for (const x of st) for (let k = 0; k <= kA && k < N; k++) if (ok(x.rT[k])) x.rT[k] -= trA[k] + trB[k] * x.x;

  // Update the persistent-bias state with the new analysis hours.
  for (let k = Math.max(0, biasFrom); k <= kA && k < N; k++) {
    const h = hod(k);
    if (st.some((x) => ok(x.rT[k]))) { binUpdate(B.trend[0], h, trA[k]); binUpdate(B.trend[1], h, trB[k]); }
    for (const x of st) {
      const e = B.st[x.s.id] || (B.st[x.s.id] = { T: newBins(1)[0], RH: newBins(1)[0], U: newBins(1)[0] });
      if (ok(x.rT[k])) binUpdate(e.T, h, x.rT[k]);
      if (ok(x.rRH[k])) binUpdate(e.RH, h, x.rRH[k]);
      if (ok(x.rU[k])) binUpdate(e.U, 0, x.rU[k]); // wind: one bin, not by hour
    }
  }

  // Mean over the last observed hours → faded into the persistent bias.
  const tail = (arr, n = 6) => { const v = []; for (let k = kA; k >= 0 && k > kA - 12 && v.length < n; k--) if (ok(arr[k])) v.push(arr[k]); return v.length >= 2 ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const blend = (last, persist, h, tau) => {
    const e = Math.exp(-h / tau);
    if (last === null && persist === null) return null;
    return e * (last ?? persist ?? 0) + (1 - e) * (persist ?? 0);
  };
  const tA_ = tail(Array.from(trA.subarray(0, kA + 1))), tB_ = tail(Array.from(trB.subarray(0, kA + 1)));
  for (let k = kA + 1; k < N; k++) {
    const h = times[k] - tA, hh = hod(k);
    trA[k] = blend(tA_, binEst(B.trend[0], hh), h, TAU_T) ?? 0;
    trB[k] = blend(tB_, binEst(B.trend[1], hh), h, TAU_T) ?? 0;
  }
  for (const x of st) {
    const e = B.st[x.s.id];
    const mT_ = tail(x.rT), mRH_ = tail(x.rRH), mU_ = tail(x.rU);
    x.bias = { T: mT_, RH: mRH_, U: mU_ };
    for (let k = kA + 1; k < N; k++) {
      const h = times[k] - tA, hh = hod(k);
      x.rT[k] = blend(mT_, e ? binEst(e.T, hh) : null, h, TAU_T);
      x.rRH[k] = blend(mRH_, e ? binEst(e.RH, hh) : null, h, TAU_RH);
      x.rU[k] = blend(mU_, e ? binEst(e.U, 0) : null, h, TAU_U);
    }
  }

  for (const x of st) {
    const s = x.s;
    x.kern = (p, K) => Math.exp(-((kmBetween(p, s) / K.L) ** 2) - (((p.z - s.z) / K.Z) ** 2));
    x.lnP = new Array(N).fill(null);
    x.precipDiag = [];
  }

  // ---- Snow-height-driven snowfall at HS stations ---------------------------
  // As SNOWPACK does at automatic stations: a flat snow column at the station is
  // run with the station's corrected weather, and snow falls on it only when the
  // measured snow height rises above the simulated one. That hourly snowfall,
  // which already allows for settlement of the snowpack underneath, is the
  // station's precipitation estimate. The column is carried between runs in `bias.hs`.
  for (const x of st) {
    if (x.s.precip !== "hs") continue;
    const base = x.s.hsBase || 0; // sensor reading over bare ground
    const hs = cleanHS(x.s.o.HS, kA).map((v) => (ok(v) ? Math.max(0, v - base) : v));
    if (!hs.some(ok)) continue;
    const prev = B.hs?.[x.s.id];
    x.S = new Array(N).fill(null);
    if (prev?.S) prev.S.v.forEach((v, j) => { const k = prev.S.t0 + j - times[0]; if (k >= 0 && k < N) x.S[k] = v; });
    let sim = prev?.sim ? unpackSim({ lat: x.s.lat, lon: x.s.lon, z: x.s.z }, prev.sim) : createSim({ lat: x.s.lat, lon: x.s.lon, z: x.s.z });
    let kFrom = Math.max(0, biasFrom);
    if (prev && ok(prev.t)) kFrom = Math.max(kFrom, prev.t - times[0] + 1);
    const W = weightsFor({ lat: x.s.lat, lon: x.s.lon, z: x.s.z });
    let lastHS = -1;
    for (let j = kFrom - 1; j >= Math.max(0, kFrom - 24); j--) if (ok(hs[j])) { lastHS = j; break; }
    for (let k = kFrom; k <= kA; k++) {
      const f = at(W, k);
      const P = ok(x.mP[k]) ? x.mP[k] : f.P;
      const rain = P * (1 - f.sf);
      let snow, S = null;
      const h = hs[k];
      if (ok(h)) {
        // Rising: above the lowest reading of the previous 12 h by at least 1 cm.
        let lo = Infinity;
        for (let j = Math.max(0, k - 12); j < k; j++) if (ok(hs[j]) && hs[j] < lo) lo = hs[j];
        const gap = h - snowDepth(sim) * 100;
        const rising = lo < Infinity && h - lo >= 1;
        snow = rising && gap > 1.5 && f.Ta < 1.5 ? (Math.min(gap, 8) / 100) * newSnowDensity(f.Ta, f.U) : 0;
        S = snow;
        lastHS = k;
      } else if (lastHS >= 0 && k - lastHS <= 24) {
        // A short gap in the readings: wait for them, the snow is added when they resume.
        snow = 0; S = 0;
      } else {
        snow = P * f.sf; // no readings for a day: fall back to the model
      }
      stepHour(sim, { t: times[k], Ta: f.Ta, RH: f.RH, U: f.U, P: snow + rain, snow, rain, sw: f.ghi, lw: f.lw, drift: 0 });
      x.S[k] = S;
      if (trace) (trace[x.s.id] ||= []).push({ t: times[k], hsObs: h, hsCol: snowDepth(sim) * 100, S, Pm: P * f.sf, swe: sim.L.reduce((a, l) => a + l.m + l.w, 0) });
    }
    const keep = Math.max(0, kA - 71);
    B.hs = B.hs || {};
    B.hs[x.s.id] = { t: times[kA], sim: packSim(sim), S: { t0: times[keep], v: x.S.slice(keep, kA + 1).map((v) => (ok(v) ? Math.round(v * 100) / 100 : null)) } };
    x.hsModel = Math.round(snowDepth(sim) * 1000) / 10;
  }

  // ---- 24 h precipitation ratios over the analysis windows --------------------
  for (const x of st) {
    const { s, rT, mP, mT, lnP, precipDiag } = x;
    const e = B.st[s.id];
    if (s.precip) {
      for (const [a0, b, from = a0] of windows) {
        // Ratios over the 72 h ending with the window, so a storm the model has a
        // few hours early or late still counts; applied to the window's hours.
        const a = Math.max(0, b - 71);
        if (a0 < 0 || b > kA) continue;
        let pm = 0, nm = 0, po = 0, no = 0, tsum = 0, tn = 0, ns = 0, so = 0, rm = 0;
        for (let k = a; k <= b; k++) {
          if (ok(mP[k])) { pm += mP[k]; nm++; }
          const Tk = ok(mT[k]) ? mT[k] + trA[k] + trB[k] * x.x + (rT[k] || 0) : null;
          if (ok(Tk)) { tsum += Tk; tn++; if (ok(mP[k])) rm += mP[k] * (1 - snowFraction(Tk)); }
          if (s.precip === "gauge" && ok(s.o.P[k])) { po += s.o.P[k]; no++; }
          if (x.S && ok(x.S[k])) { so += x.S[k]; ns++; }
        }
        const tMean = tn ? tsum / tn : 0;
        let obs = null;
        // Weighing gauges under-catch snow in wind (roughly 20–40 % for a single Alter shield).
        if (s.precip === "gauge" && no >= (b - a + 1) * 0.75) obs = po * (tMean < -1 ? 1.3 : tMean < 1 ? 1.15 : 1);
        // HS stations: snowfall from the snow-height-driven column, plus the model's rain.
        if (s.precip === "hs" && x.S && ns >= (b - a + 1) * 0.75) obs = so + rm;
        if (obs === null || nm < (b - a + 1) * 0.75) continue;
        if (obs < 2 && pm < 2) continue; // dry both ways: no information
        const r = clamp(Math.log((obs + 2) / (pm + 2)), Math.log(0.25), Math.log(4));
        precipDiag.push({ a: times[a], b: times[b], obs: +obs.toFixed(1), model: +pm.toFixed(1) });
        for (let k = Math.max(0, from); k <= b; k++) lnP[k] = r;
        if (b >= biasFrom) {
          const ent = e || (B.st[s.id] = { T: newBins(1)[0], RH: newBins(1)[0], U: newBins(1)[0] });
          ent.P = ent.P || newBins(1)[0];
          binUpdate(ent.P, 0, r);
        }
      }
      // Forecast: the station's recent precipitation ratio persists (shrunk while it has few samples).
      const pe = B.st[s.id]?.P;
      const rf = pe ? binEst(pe, 0) : null;
      if (ok(rf)) for (let k = kA + 1; k < N; k++) lnP[k] = rf;
    }
  }

  function weightsFor(p) {
    const nw = nodeWeights(p);
    const sw = [];
    for (let j = 0; j < st.length; j++) {
      const x = st[j];
      const kT = x.kern(p, KT), kW = x.s.wind ? x.kern(p, KW) : 0;
      const kP = x.s.precip ? x.kern(p, KP) : 0;
      if (kT > 0.005 || kW > 0.005 || kP > 0.005) sw.push([j, kT, kW, kP]);
    }
    // The station's own point takes its snow-height-driven snowfall directly.
    const own = p.id ? st.findIndex((x) => x.s.id === p.id && x.S) : -1;
    return { nw, sw, z: p.z, own: own >= 0 ? own : null };
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
    const Ta = (m.T ?? 0) + trA[k] + trB[k] * (W.z - Z_REF) / 1000 + (wT ? sT / (wT + KT.k0) : 0);
    const RH = clamp((m.RH ?? 80) + (wR ? sR / (wR + KT.k0) : 0), 5, 100);
    const Ukmh = Math.max(0, (m.U ?? 10) * Math.exp(wU ? sU / (wU + KW.k0) : 0));
    let P = Math.max(0, (m.P ?? 0) * Math.exp(wP ? sP / (wP + KP.k0) : 0));
    let sf = snowFraction(Ta);
    const Pwx = P; // precipitation in the weather (no surface hoar growth while it falls)
    if (W.own !== null && k <= kA && ok(st[W.own].S[k])) {
      const snow = st[W.own].S[k], rain = P * (1 - sf);
      P = snow + rain;
      sf = P > 0 ? snow / P : sf;
    }
    return {
      t: times[k], Ta, RH, U: Ukmh / 3.6, dir: m.dir, P, sf, Pwx,
      ghi: m.ghi, dirH: m.dirH, difH: m.difH, cc: m.cc, lw: longwaveIn(Ta, RH, m.cc),
    };
  }

  function stationDiagnostics() {
    return st.map((x) => ({
      // biasT: observed minus raw model over the last hours (elevation trend included);
      // biasTlocal: what is left after the elevation trend.
      id: x.s.id, name: x.s.name, biasT: x.bias.T === null ? null : +(x.bias.T + trA[kA] + trB[kA] * x.x).toFixed(2),
      biasTlocal: x.bias.T === null ? null : +x.bias.T.toFixed(2),
      biasRH: x.bias.RH === null ? null : +x.bias.RH.toFixed(1),
      windRatio: x.bias.U === null ? null : +Math.exp(x.bias.U).toFixed(2),
      precip: x.precipDiag.slice(-7),
      hsModel: x.hsModel ?? null,
    }));
  }

  const trend = { a: +trA[kA].toFixed(2), b: +trB[kA].toFixed(2), zRef: Z_REF };
  return { times, kA, weightsFor, at, stationDiagnostics, gamma, trend, bias: B };
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
