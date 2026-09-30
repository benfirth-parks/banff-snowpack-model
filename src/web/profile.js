// Point profile graphic: seasonal stratigraphy (grain type through time), plus
// hand-hardness and temperature profiles for the selected date. Drawn on a
// canvas; hover shows layer details, clicking the seasonal panel picks a date.
import { GRAIN_GROUPS, GROUP_OF, CLASSES, CLASS_NAMES, HARD } from "./props.js";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const INK = "#1f2328", INK2 = "#57606a", GRID = "#e6e8eb", AXIS = "#8c959f";

export function decode(day, aspect) {
  const a = day.A ? day.A[aspect] : null;
  if (!a) return [];
  const hsmm = (day.hs[aspect] || 0) * 10;
  const out = [];
  const n = a.length / 6;
  for (let j = 0; j < n; j++) {
    const top = a[6 * j] / 10, bottom = (j + 1 < n ? a[6 * (j + 1)] : hsmm) / 10;
    out.push({ top, bottom: Math.max(bottom, top), cls: a[6 * j + 1], h: a[6 * j + 2] / 10, T: a[6 * j + 3] / 10, gs: a[6 * j + 4] / 10, rho: a[6 * j + 5] });
  }
  return out;
}

function localParts(t, tz) {
  const d = new Date((t + tz(t)) * 3600000);
  return { m: d.getUTCMonth(), d: d.getUTCDate(), y: d.getUTCFullYear() };
}

export class ProfileChart {
  constructor(canvas, tip, { onPickDate, tzOffset }) {
    this.c = canvas; this.tip = tip; this.onPickDate = onPickDate; this.tz = tzOffset;
    this.data = null;
    canvas.addEventListener("mousemove", (e) => this.hover(e));
    canvas.addEventListener("mouseleave", () => { this.tip.hidden = true; this.cross = null; this.render(); });
    canvas.addEventListener("click", (e) => this.click(e));
    new ResizeObserver(() => this.render()).observe(canvas);
  }

  set(data) { this.data = data; this.render(); }

  layout() {
    const r = this.c.getBoundingClientRect();
    const W = Math.max(320, r.width), H = Math.max(240, r.height);
    const narrow = W < 520;
    const left = 44, top = 34, bottom = H - 30;
    const sRight = narrow ? W - 12 : Math.round(W * 0.6);
    const hL = narrow ? null : sRight + 44, hR = narrow ? null : Math.round(W * 0.84);
    const tL = narrow ? null : hR + 10, tR = W - 10;
    return { W, H, narrow, s: { l: left, r: sRight, t: top, b: bottom }, h: narrow ? null : { l: hL, r: hR, t: top, b: bottom }, T: narrow ? null : { l: tL, r: tR, t: top, b: bottom } };
  }

  render() {
    const d = this.data;
    const ctx = this.c.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const L = this.layout();
    this.c.width = Math.round(L.W * dpr); this.c.height = Math.round(L.H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, L.W, L.H);
    ctx.font = "12px system-ui, -apple-system, Segoe UI, sans-serif";
    if (!d || !d.days.length) {
      ctx.fillStyle = INK2; ctx.fillText(d ? "No simulated days yet for this point." : "Loading…", 16, 30);
      return;
    }
    this.L = L;
    const days = d.days;
    const asp = d.aspect;
    const tEnd = days[days.length - 1].t, tStart = days[0].t - 24;
    let ymax = 0;
    for (const day of days) { ymax = Math.max(ymax, day.hs[asp] || 0, day.obsHS || 0); }
    const step = ymax > 200 ? 50 : ymax > 80 ? 25 : ymax > 30 ? 10 : 5;
    ymax = Math.max(step * 2, Math.ceil((ymax * 1.08) / step) * step);
    const S = L.s;
    const X = (t) => S.l + (S.r - S.l) * (t - tStart) / Math.max(1, tEnd - tStart);
    const Y = (cm) => S.b - (S.b - S.t) * cm / ymax;
    this.S = { X, Y, tStart, tEnd, ymax };

    // Title
    ctx.fillStyle = INK; ctx.font = "600 13px system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(d.title, (S.l + S.r) / 2, 16);
    // Grid + y axis
    ctx.font = "11px system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.textAlign = "right"; ctx.fillStyle = INK2;
    for (let v = 0; v <= ymax; v += step) {
      ctx.strokeStyle = GRID; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(S.l, Y(v) + 0.5); ctx.lineTo(S.r, Y(v) + 0.5); ctx.stroke();
      ctx.fillText(String(v), S.l - 6, Y(v) + 4);
    }
    ctx.save(); ctx.translate(12, (S.t + S.b) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = "center"; ctx.fillText("Height (cm)", 0, 0); ctx.restore();
    // Forecast shading
    const firstFc = days.find((x) => x.fc);
    if (firstFc) {
      ctx.fillStyle = "rgba(90,110,163,0.08)";
      ctx.fillRect(X(firstFc.t - 24), S.t, S.r - X(firstFc.t - 24), S.b - S.t);
      ctx.fillStyle = INK2; ctx.textAlign = "left"; ctx.fillText("forecast", X(firstFc.t - 24) + 3, S.t + 11);
    }
    // Stratigraphy columns
    for (const day of days) {
      const x0 = X(day.t - 24), x1 = X(day.t);
      const w = Math.max(1, x1 - x0 + 0.4);
      const hs = day.hs[asp] || 0;
      for (const l of decode(day, asp)) {
        const g = GROUP_OF[l.cls];
        const yTop = Y(hs - l.top), yBot = Y(hs - l.bottom);
        let h = yBot - yTop;
        if (g === 2) h = Math.max(h, 1.6);
        if (h < 0.3) continue;
        ctx.fillStyle = GRAIN_GROUPS[g].color;
        ctx.globalAlpha = day.fc ? 0.75 : 1;
        ctx.fillRect(x0, yTop, w, h);
      }
      ctx.globalAlpha = 1;
      if (day.obsHS !== undefined && day.obsHS !== null) {
        ctx.fillStyle = INK; ctx.beginPath(); ctx.arc((x0 + x1) / 2, Y(day.obsHS), 2.2, 0, 2 * Math.PI); ctx.fill();
      }
    }
    // X axis
    ctx.strokeStyle = AXIS; ctx.beginPath(); ctx.moveTo(S.l, S.b + 0.5); ctx.lineTo(S.r, S.b + 0.5); ctx.stroke();
    const nd = (tEnd - tStart) / 24;
    const tickDays = nd > 150 ? 28 : nd > 60 ? 14 : nd > 20 ? 7 : 2;
    ctx.fillStyle = INK2; ctx.textAlign = "center";
    for (let i = days.length - 1; i >= 0; i -= tickDays) {
      const p = localParts(days[i].t, this.tz);
      const x = X(days[i].t - 12);
      ctx.fillText(`${MON[p.m]} ${String(p.d).padStart(2, "0")}`, x, S.b + 16);
      ctx.beginPath(); ctx.moveTo(x, S.b); ctx.lineTo(x, S.b + 4); ctx.stroke();
    }
    // Selected day marker + weak-layer labels
    const sel = days.find((x) => x.date === d.selectedDate) || days[days.length - 1];
    this.sel = sel;
    const xs = X(sel.t - 12);
    ctx.strokeStyle = INK; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(xs + 0.5, S.t); ctx.lineTo(xs + 0.5, S.b); ctx.stroke(); ctx.setLineDash([]);
    const hsSel = sel.hs[asp] || 0;
    ctx.font = "10px system-ui, -apple-system, Segoe UI, sans-serif"; ctx.textAlign = "right";
    for (const w of (sel.W && sel.W[asp]) || []) {
      if (w[3] < 50) continue;
      const p = localParts(w[2], this.tz);
      const label = `${MON[p.m][0]}${p.d}-${CLASSES[w[1]]}-${w[0]}`;
      const y = Y(hsSel - w[0]);
      ctx.fillStyle = "rgba(255,255,255,0.85)"; const tw = ctx.measureText(label).width;
      ctx.fillRect(xs - tw - 8, y - 7, tw + 4, 12);
      ctx.fillStyle = INK; ctx.fillText(label, xs - 6, y + 3);
    }
    // Legend (top-left inside the panel)
    ctx.font = "10px system-ui, -apple-system, Segoe UI, sans-serif"; ctx.textAlign = "left";
    GRAIN_GROUPS.forEach((g, i) => {
      const y = S.t + 8 + i * 13;
      ctx.fillStyle = "rgba(255,255,255,0.8)"; ctx.fillRect(S.l + 4, y - 7, 64, 13);
      ctx.fillStyle = g.color; ctx.fillRect(S.l + 8, y - 4, 8, 8);
      ctx.fillStyle = INK; ctx.fillText(g.label, S.l + 20, y + 4);
    });
    if (d.hasObs) {
      const y = S.t + 8 + 5 * 13;
      ctx.fillStyle = "rgba(255,255,255,0.8)"; ctx.fillRect(S.l + 4, y - 7, 64, 13);
      ctx.fillStyle = INK; ctx.beginPath(); ctx.arc(S.l + 12, y, 2.2, 0, 2 * Math.PI); ctx.fill(); ctx.fillText("obs HS*", S.l + 20, y + 4);
    }
    if (d.hoverT) {
      const x = X(d.hoverT - 12);
      ctx.strokeStyle = "rgba(31,35,40,0.35)"; ctx.beginPath(); ctx.moveTo(x + 0.5, S.t); ctx.lineTo(x + 0.5, S.b); ctx.stroke();
    }
    if (!L.narrow) this.renderProfile(ctx, L, sel, asp);
  }

  renderProfile(ctx, L, sel, asp) {
    const layers = decode(sel, asp);
    const hs = sel.hs[asp] || 0;
    const H = L.h, T = L.T;
    const dmax = Math.max(10, Math.ceil(hs / 10) * 10);
    const Yd = (cm) => H.t + (H.b - H.t) * cm / dmax;
    const Xh = (h) => H.l + (H.r - H.l) * h / 6;
    let tmin = -20;
    for (const l of layers) tmin = Math.min(tmin, Math.floor(l.T / 5) * 5);
    const Xt = (v) => T.l + (T.r - T.l) * (v - tmin) / (0 - tmin);
    this.P = { Yd, layers, hs, dmax };
    ctx.font = "600 13px system-ui, -apple-system, Segoe UI, sans-serif"; ctx.fillStyle = INK; ctx.textAlign = "center";
    ctx.fillText(this.data.dateLabel, (H.l + T.r) / 2, 16);
    ctx.font = "11px system-ui, -apple-system, Segoe UI, sans-serif";
    // depth axis + grid
    const st = dmax > 200 ? 50 : dmax > 80 ? 25 : dmax > 30 ? 10 : 5;
    ctx.textAlign = "right"; ctx.fillStyle = INK2;
    for (let v = 0; v <= dmax; v += st) {
      ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(H.l, Yd(v) + 0.5); ctx.lineTo(H.r, Yd(v) + 0.5); ctx.moveTo(T.l, Yd(v) + 0.5); ctx.lineTo(T.r, Yd(v) + 0.5); ctx.stroke();
      ctx.fillText(String(v), H.l - 6, Yd(v) + 4);
    }
    ctx.save(); ctx.translate(H.l - 32, (H.t + H.b) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = "center"; ctx.fillText("Depth (cm)", 0, 0); ctx.restore();
    // hardness bars
    for (const l of layers) {
      const y0 = Yd(l.top), y1 = Yd(l.bottom);
      const g = GROUP_OF[l.cls];
      ctx.fillStyle = GRAIN_GROUPS[g].color;
      ctx.fillRect(H.l, y0, Math.max(1, Xh(l.h) - H.l), Math.max(g === 2 ? 1.6 : 0.6, y1 - y0));
    }
    ctx.strokeStyle = AXIS; ctx.strokeRect(H.l + 0.5, H.t + 0.5, H.r - H.l, H.b - H.t);
    ctx.fillStyle = INK2; ctx.textAlign = "center";
    for (let i = 1; i <= 5; i++) ctx.fillText(HARD[i - 1], Xh(i), H.b + 16);
    // temperature panel
    ctx.strokeStyle = AXIS; ctx.strokeRect(T.l + 0.5, T.t + 0.5, T.r - T.l, T.b - T.t);
    ctx.fillStyle = INK2;
    ctx.fillText(String(tmin), Xt(tmin) + 8, T.b + 16);
    ctx.fillText("0", Xt(0) - 4, T.b + 16);
    ctx.fillText("T °C", (T.l + T.r) / 2, T.b + 28 > L.H ? T.b + 16 : T.b + 28);
    if (layers.length) {
      ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.beginPath();
      layers.forEach((l, i) => { const y = Yd((l.top + l.bottom) / 2); if (i) ctx.lineTo(Xt(l.T), y); else ctx.moveTo(Xt(l.T), y); });
      ctx.stroke(); ctx.lineWidth = 1;
    }
  }

  hit(e) {
    const r = this.c.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  hover(e) {
    if (!this.data || !this.L || !this.data.days.length) return;
    const { x, y } = this.hit(e);
    const L = this.L, d = this.data;
    const tip = this.tip;
    if (x >= L.s.l && x <= L.s.r && y >= L.s.t && y <= L.s.b) {
      const t = this.S.tStart + (x - L.s.l) / (L.s.r - L.s.l) * (this.S.tEnd - this.S.tStart);
      let best = null;
      for (const day of d.days) if (day.t - 24 <= t && t <= day.t) best = day;
      if (!best) { tip.hidden = true; return; }
      d.hoverT = best.t; this.render();
      const hs = best.hs[d.aspect] || 0;
      const depth = hs - (L.s.b - y) / (L.s.b - L.s.t) * this.S.ymax;
      const lay = decode(best, d.aspect).find((l) => depth >= l.top - 0.3 && depth <= l.bottom + 0.3);
      tip.innerHTML = `<b>${best.dateLabel || best.date}${best.fc ? " (forecast)" : ""}</b><br>HS ${hs} cm${best.obsHS != null ? ` · observed ${Math.round(best.obsHS)} cm` : ""}` +
        (lay ? `<br>${CLASS_NAMES[CLASSES[lay.cls]]} at ${Math.round(lay.top)}–${Math.round(lay.bottom)} cm depth` : "") + `<br><span class="muted">Click to show this date</span>`;
      this.place(tip, x, y);
      return;
    }
    if (d.hoverT) { d.hoverT = null; this.render(); }
    if (this.P && L.h && x >= L.h.l && x <= L.T.r && y >= L.h.t && y <= L.h.b) {
      const depth = (y - L.h.t) / (L.h.b - L.h.t) * this.P.dmax;
      const l = this.P.layers.find((q) => depth >= q.top - 0.3 && depth <= q.bottom + 0.3);
      if (!l) { tip.hidden = true; return; }
      const w = ((this.sel.W && this.sel.W[d.aspect]) || []).find((q) => Math.abs(q[0] - l.top) <= 1);
      tip.innerHTML = `<b>${CLASS_NAMES[CLASSES[l.cls]]} (${CLASSES[l.cls]})</b><br>${Math.round(l.top)}–${Math.round(l.bottom)} cm depth<br>` +
        `Grain ${l.gs.toFixed(1)} mm · ${l.rho} kg/m³ · ${HARD[Math.min(5, Math.max(0, Math.round(l.h) - 1))]}<br>T ${l.T.toFixed(1)} °C` +
        (w ? `<br>Weak layer: ${w[4]} lemons, instability ${w[3]}%` : "");
      this.place(tip, x, y);
      return;
    }
    tip.hidden = true;
  }

  place(tip, x, y) {
    tip.hidden = false;
    const W = this.L.W;
    tip.style.left = `${Math.min(x + 14, W - 230)}px`;
    tip.style.top = `${y + 12}px`;
  }

  click(e) {
    if (!this.data || !this.L) return;
    const { x, y } = this.hit(e);
    const L = this.L;
    if (x >= L.s.l && x <= L.s.r && y >= L.s.t && y <= L.s.b && this.data.hoverT) {
      const day = this.data.days.find((q) => q.t === this.data.hoverT);
      if (day) this.onPickDate(day.date);
    }
  }
}
