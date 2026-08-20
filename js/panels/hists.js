// Field histograms (distance, magnitude, NN separation) and the pair plot, with the
// pair-plot controls (moved here from the sidebar). Stacked by source kind, ∞ bin for
// quasars (v1's _kind_hist port). Bars have hover readouts: "4 at 18–20 kpc".
import { D } from '../data.js';
import { state, set, on } from '../state.js';
import { F } from '../fieldmodel.js';
import * as C from '../compute.js';
import { UI, KIND_COL, scales } from '../colors.js';
import { placeTooltip } from '../scene3d.js';
import { fitCanvas, label } from './canvas2d.js';

let els = {};
let tipEl = null;

export function initHists(container) {
  tipEl = document.getElementById('tooltip2d');
  for (const id of ['dist', 'mag', 'nn', 'pairctl', 'pair']) {
    if (id === 'pairctl') {
      const row = document.createElement('div');
      row.className = 'pair-controls';
      row.innerHTML =
        `<label class="pc-chk"><input type="checkbox" id="connect-chk" ${state.connect ? 'checked' : ''}> NN lines on finder</label>` +
        `<select id="pair-sel">` +
        `<option value="dd"${state.pairKind === 'dd' ? ' selected' : ''}>sep vs Δdist (pairs)</option>` +
        `<option value="dv"${state.pairKind === 'dv' ? ' selected' : ''}>sep vs Δv (pairs)</option>` +
        `<option value="nn"${state.pairKind === 'nn' ? ' selected' : ''}>d_i vs d_nn (NN)</option>` +
        `<option value="dnn"${state.pairKind === 'dnn' ? ' selected' : ''}>NN Δdist histogram</option>` +
        `</select>`;
      container.appendChild(row);
      row.querySelector('#connect-chk').addEventListener('change', e => set({ connect: e.target.checked }));
      row.querySelector('#pair-sel').addEventListener('change', e => set({ pairKind: e.target.value }));
      continue;
    }
    const box = document.createElement('div');
    box.className = 'hist-box';
    const cvs = document.createElement('canvas');
    box.appendChild(cvs);
    container.appendChild(box);
    els[id] = { box, cvs, bars: [] };
    cvs.addEventListener('pointermove', e => barHover(id, e));
    cvs.addEventListener('pointerleave', () => { tipEl.style.display = 'none'; });
  }
  on('fieldmodel', drawAll);
  new ResizeObserver(drawAll).observe(container);
}

function barHover(id, e) {
  const rec = els[id];
  const r = rec.cvs.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  for (const b of rec.bars) {
    if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) {
      tipEl.innerHTML = b.lab;
      tipEl.style.display = 'block';
      placeTooltip(tipEl, e);
      return;
    }
  }
  tipEl.style.display = 'none';
}

// nice tick step: 1/2/5 × 10^k targeting ~n ticks, integers preferred
function niceStep(span, n = 6) {
  const raw = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
  for (const m of [1, 2, 5, 10]) {
    if (m * mag >= raw) return m * mag;
  }
  return 10 * mag;
}
const fmtTick = v => Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : String(+v.toFixed(2));

function xTicks(ctx, plot, h, lo, hi, toX) {
  const step = niceStep(hi - lo, 6);
  ctx.fillStyle = UI.panelBorder;
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
    const X = toX(v);
    ctx.fillRect(X, plot.y + plot.h, 1, 3);
    label(ctx, fmtTick(v), X, h - 16, { align: 'center', size: 8 });
    ctx.fillStyle = UI.panelBorder;
  }
}

function yTicks(ctx, plot, maxC) {
  const step = Math.max(1, niceStep(maxC, 4));
  ctx.fillStyle = UI.panelBorder;
  for (let v = step; v <= maxC + 1e-9; v += step) {
    const Y = plot.y + plot.h - v / maxC * plot.h;
    ctx.fillRect(plot.x - 3, Y, 3, 1);
    label(ctx, fmtTick(v), plot.x - 5, Y + 3, { align: 'right', size: 8 });
    ctx.fillStyle = UI.panelBorder;
  }
}

let pairStale = false;
const labKpc = (n, a, b) => `${n} at ${a}–${b} kpc`;
const labMag = (n, a, b) => `${n} at G=${a}–${b}`;
function drawAll(opts) {
  drawKindHist('dist', F.src.dist, 'field distances', 'dist [kpc]', true, labKpc,
    `${F.idx.filter(i => D.s_dist_known[i]).length} meas · ${F.idx.filter(i => !D.s_dist_known[i]).length} geom`);
  drawKindHist('mag', F.src.G, 'field magnitudes', 'Gaia G', false, labMag);
  drawNN();
  // the O(n^2) pair plot waits until a live drag ends
  if (opts?.live && F.src.n > 300) { pairStale = true; return; }
  pairStale = false;
  drawPair(els.pair.cvs);
}

function drawKindHist(id, values, title, xlab, infBin, labFmt, note) {
  const rec = els[id];
  const cvs = rec.cvs;
  const w = cvs.parentElement.clientWidth;
  if (!w) return;
  const h = 132;
  const ctx = fitCanvas(cvs, w, h);
  ctx.clearRect(0, 0, w, h);
  const plot = { x: 34, y: 18, w: w - 44, h: h - 46 };
  rec.bars = [];
  label(ctx, title, plot.x, 12, { size: 10, color: UI.text });
  if (note) label(ctx, note, w - 8, 12, { size: 8.5, align: 'right' });

  const kinds = F.src.kind;
  const mm = C.finiteMinMax(values);
  let nInf = 0;
  for (let i = 0; i < values.length; i++) if (values[i] === Infinity) nInf++;
  if (!mm && !nInf) { label(ctx, 'no sources', w / 2, h / 2, { align: 'center' }); return; }

  // whole-number bin edges: snap the range out to integers, use a nice bin width
  let lo = mm ? Math.floor(mm[0]) : 0, hi = mm ? Math.ceil(mm[1]) : 1;
  if (hi <= lo) hi = lo + 1;
  const bw = Math.max(niceStep(hi - lo, 26), (hi - lo) / 40);
  const nb = Math.max(1, Math.round((hi - lo) / bw));
  const stacks = [0, 2, 3, 1].map(k => {
    const arr = new Float64Array(values.length);
    let n = 0;
    for (let i = 0; i < values.length; i++) {
      if (kinds[i] === k && Number.isFinite(values[i])) arr[n++] = values[i];
    }
    return { k, hist: C.histogram(arr.subarray(0, n), nb, lo, hi) };
  });
  const tot = new Int32Array(nb);
  for (const s of stacks) for (let b = 0; b < nb; b++) tot[b] += s.hist.counts[b];
  let maxC = Math.max(1, C.arrMax(tot));
  if (infBin && nInf) maxC = Math.max(maxC, nInf);

  const nCols = nb + (infBin && nInf ? 2 : 0);
  const colW = plot.w / nCols;
  for (let b = 0; b < nb; b++) {
    let yoff = 0;
    for (const s of stacks) {
      const c = s.hist.counts[b];
      if (!c) continue;
      const bh = c / maxC * plot.h;
      ctx.fillStyle = KIND_COL[s.k];
      ctx.fillRect(plot.x + b * colW + 0.4, plot.y + plot.h - yoff - bh, colW - 0.8, bh);
      yoff += bh;
    }
    if (tot[b]) {
      const b0 = lo + b * (hi - lo) / nb, b1 = lo + (b + 1) * (hi - lo) / nb;
      rec.bars.push({
        x0: plot.x + b * colW, x1: plot.x + (b + 1) * colW,
        y0: plot.y, y1: plot.y + plot.h,
        lab: labFmt(tot[b], fmtTick(b0), fmtTick(b1)),
      });
    }
  }
  if (infBin && nInf) {
    const bh = nInf / maxC * plot.h;
    ctx.fillStyle = KIND_COL[1];
    ctx.fillRect(plot.x + (nb + 1) * colW + 0.4, plot.y + plot.h - bh, colW - 0.8, bh);
    label(ctx, '∞', plot.x + (nb + 1.5) * colW, h - 16, { align: 'center', size: 12, color: KIND_COL[1] });
    rec.bars.push({
      x0: plot.x + (nb + 1) * colW, x1: plot.x + (nb + 2) * colW,
      y0: plot.y, y1: plot.y + plot.h, lab: `${nInf} at ∞ (quasars)`,
    });
  }
  // axes
  ctx.strokeStyle = UI.panelBorder;
  ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
  label(ctx, xlab, plot.x + plot.w / 2, h - 4, { align: 'center', size: 9 });
  const toX = v => plot.x + (v - lo) / (hi - lo) * (nb * colW);
  xTicks(ctx, plot, h, lo, hi, toX);
  yTicks(ctx, plot, maxC);
}

function drawNN() {
  const rec = els.nn;
  const cvs = rec.cvs;
  const w = cvs.parentElement.clientWidth;
  if (!w) return;
  const h = 132;
  const ctx = fitCanvas(cvs, w, h);
  ctx.clearRect(0, 0, w, h);
  const plot = { x: 34, y: 18, w: w - 44, h: h - 46 };
  rec.bars = [];
  if (!F.nn) {
    label(ctx, F.src.n > 2500 ? 'NN skipped while dragging' : 'fewer than 2 sources',
      w / 2, h / 2, { align: 'center' });
    return;
  }
  const sep = F.nn.sepAm;
  const med = C.median(sep);
  label(ctx, `NN separation (median ${med.toFixed(2)}′)`, plot.x, 12, { size: 10, color: UI.text });
  const mm = C.finiteMinMax(sep);
  let lo = Math.floor(mm[0]), hi = Math.ceil(mm[1]);
  if (hi <= lo) hi = lo + 1;
  const nb = 40;
  const hist = C.histogram(sep, nb, lo, hi);
  const maxC = Math.max(1, C.arrMax(hist.counts));
  const colW = plot.w / nb;
  ctx.fillStyle = UI.hist;
  for (let b = 0; b < nb; b++) {
    const bh = hist.counts[b] / maxC * plot.h;
    ctx.fillRect(plot.x + b * colW + 0.3, plot.y + plot.h - bh, colW - 0.6, bh);
    if (hist.counts[b]) {
      const b0 = lo + b * (hi - lo) / nb, b1 = lo + (b + 1) * (hi - lo) / nb;
      rec.bars.push({
        x0: plot.x + b * colW, x1: plot.x + (b + 1) * colW,
        y0: plot.y, y1: plot.y + plot.h,
        lab: `${hist.counts[b]} at ${(+b0.toFixed(1))}–${(+b1.toFixed(1))}′`,
      });
    }
  }
  ctx.strokeStyle = UI.panelBorder;
  ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
  label(ctx, 'NN sep [arcmin]', plot.x + plot.w / 2, h - 4, { align: 'center', size: 9 });
  const toX = v => plot.x + (v - lo) / (hi - lo) * plot.w;
  xTicks(ctx, plot, h, lo, hi, toX);
  yTicks(ctx, plot, maxC);
}

// ---- pair plot -------------------------------------------------------------------
function subsample(cap = 700) {
  const n = F.src.n;
  if (n <= cap) return null;                    // null = use all
  const idx = [];
  const step = n / cap;
  for (let i = 0; i < cap; i++) idx.push(Math.floor(i * step));
  return idx;
}

function drawPair(cvs) {
  const w = cvs.parentElement.clientWidth;
  if (!w) return;
  const h = 210;
  const ctx = fitCanvas(cvs, w, h);
  ctx.clearRect(0, 0, w, h);
  const plot = { x: 40, y: 18, w: w - 52, h: h - 46 };
  els.pair.bars = [];
  if (F.src.n < 2 || !F.nn) {
    label(ctx, 'fewer than 2 sources', w / 2, h / 2, { align: 'center' });
    return;
  }
  const kind = state.pairKind;
  if (kind === 'dd' || kind === 'dv') {
    const key = kind === 'dd' ? 'dist' : 'Vr';
    const title = kind === 'dd' ? 'pair sep vs Δdistance' : 'pair sep vs Δvelocity';
    const ylab = kind === 'dd' ? '|Δd| [kpc]' : '|ΔVr| [km/s]';
    label(ctx, title, plot.x, 12, { size: 10, color: UI.text });
    const sel = subsample();
    const src = sel ? {
      lam: Float64Array.from(sel, i => F.src.lam[i]),
      bet: Float64Array.from(sel, i => F.src.bet[i]),
      v: Float64Array.from(sel, i => F.src[key][i]),
    } : { lam: F.src.lam, bet: F.src.bet, v: F.src[key] };
    const uv = C.unitVectors(src.lam, src.bet);
    const n = src.lam.length;
    const seps = [], dqs = [];
    let anyInf = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dotp = uv[3 * i] * uv[3 * j] + uv[3 * i + 1] * uv[3 * j + 1] + uv[3 * i + 2] * uv[3 * j + 2];
        const s = Math.acos(Math.max(-1, Math.min(1, dotp))) * 180 / Math.PI * 60;
        const dq = Math.abs(src.v[i] - src.v[j]);
        if (!Number.isFinite(s) || Number.isNaN(dq)) continue;
        if (dq === Infinity) { anyInf = true; continue; }
        seps.push(s); dqs.push(dq);
      }
    }
    if (!seps.length) {
      label(ctx, kind === 'dv' ? 'no radial velocities in field' : 'no finite pairs',
        w / 2, h / 2, { align: 'center' });
      return;
    }
    // 2D histogram heatmap
    const nx = 45, ny = 45;
    const sMax = C.arrMax(seps), qMax = C.arrMax(dqs) || 1;
    const H = new Int32Array(nx * ny);
    for (let k = 0; k < seps.length; k++) {
      const bx = Math.min(nx - 1, Math.floor(seps[k] / sMax * nx));
      const by = Math.min(ny - 1, Math.floor(dqs[k] / qMax * ny));
      H[by * nx + bx]++;
    }
    const maxH = C.arrMax(H);
    const cw = plot.w / nx, chh = plot.h / ny;
    for (let by = 0; by < ny; by++) {
      for (let bx = 0; bx < nx; bx++) {
        const v = H[by * nx + bx];
        if (!v) continue;
        ctx.fillStyle = scales.pairs.css(Math.sqrt(v / maxH));
        ctx.fillRect(plot.x + bx * cw, plot.y + plot.h - (by + 1) * chh, cw + 0.4, chh + 0.4);
      }
    }
    ctx.strokeStyle = UI.panelBorder;
    ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
    label(ctx, 'on-sky sep [arcmin]', plot.x + plot.w / 2, h - 6, { align: 'center', size: 9 });
    ctx.save();
    ctx.translate(10, plot.y + plot.h / 2);
    ctx.rotate(-Math.PI / 2);
    label(ctx, ylab, 0, 0, { align: 'center', size: 9 });
    ctx.restore();
    xTicks(ctx, plot, h, 0, sMax, v => plot.x + v / sMax * plot.w);
    label(ctx, fmtTick(qMax), plot.x - 3, plot.y + 8, { align: 'right', size: 8 });
    if (anyInf) label(ctx, '(quasar pairs at Δd=∞ omitted)', w - 8, 12, { align: 'right', size: 8 });
  } else if (kind === 'nn') {
    // d_i vs d_nn scatter
    label(ctx, 'NN pair distances (∞ = quasar)', plot.x, 12, { size: 10, color: UI.text });
    const di = F.src.dist;
    const mm = C.finiteMinMax(di);
    const top = mm ? mm[1] * 1.12 : 1;
    const lo = mm ? mm[0] : 0;
    const put = v => Number.isFinite(v) ? v : top;
    const sx = v => plot.x + (put(v) - lo) / (top - lo || 1) * plot.w;
    const sy = v => plot.y + plot.h - (put(v) - lo) / (top - lo || 1) * plot.h;
    ctx.strokeStyle = '#39445a';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(sx(lo), sy(lo)); ctx.lineTo(sx(top), sy(top));
    ctx.stroke();
    ctx.setLineDash([]);
    const sepMax = C.arrMax(F.nn.sepAm) || 1;
    for (let i = 0; i < F.src.n; i++) {
      const j = F.nn.nn[i];
      ctx.fillStyle = scales.dens.css(F.nn.sepAm[i] / sepMax);
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.arc(sx(di[i]), sy(di[j]), 2.4, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = UI.panelBorder;
    ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
    label(ctx, 'd_i [kpc]', plot.x + plot.w / 2, h - 6, { align: 'center', size: 9 });
    label(ctx, 'd_nn', 12, plot.y + plot.h / 2, { size: 9 });
    label(ctx, '∞→', plot.x + plot.w, h - 18, { align: 'right', size: 9, color: UI.accent2 });
    xTicks(ctx, plot, h, lo, top, sx);
  } else {
    // Δd histogram of NN pairs, stacked by kind
    const dd = new Float64Array(F.src.n);
    for (let i = 0; i < F.src.n; i++) {
      const a = F.src.dist[i], b = F.src.dist[F.nn.nn[i]];
      dd[i] = (Number.isFinite(a) && Number.isFinite(b)) ? Math.abs(a - b)
        : (a === Infinity && b === Infinity ? NaN : Infinity);
    }
    drawKindHistInline(ctx, plot, w, h, dd, F.src.kind, 'NN Δdistance', '|d_i − d_nn| [kpc]');
  }
}

function drawKindHistInline(ctx, plot, w, h, values, kinds, title, xlab) {
  label(ctx, title, plot.x, 12, { size: 10, color: UI.text });
  const mm = C.finiteMinMax(values);
  let nInf = 0;
  for (let i = 0; i < values.length; i++) if (values[i] === Infinity) nInf++;
  if (!mm && !nInf) { label(ctx, 'no pairs', w / 2, h / 2, { align: 'center' }); return; }
  let lo = mm ? Math.floor(mm[0]) : 0, hi = mm ? Math.ceil(mm[1]) : 1;
  if (hi <= lo) hi = lo + 1;
  const nb = 34;
  const stacks = [0, 2, 3, 1].map(k => {
    const vals = [];
    for (let i = 0; i < values.length; i++) if (kinds[i] === k && Number.isFinite(values[i])) vals.push(values[i]);
    return { k, hist: C.histogram(Float64Array.from(vals), nb, lo, hi) };
  });
  const tot = new Int32Array(nb);
  for (const s of stacks) for (let b = 0; b < nb; b++) tot[b] += s.hist.counts[b];
  let maxC = Math.max(1, C.arrMax(tot), nInf);
  const nCols = nb + (nInf ? 2 : 0);
  const colW = plot.w / nCols;
  for (let b = 0; b < nb; b++) {
    let yoff = 0;
    for (const s of stacks) {
      const c = s.hist.counts[b];
      if (!c) continue;
      const bh = c / maxC * plot.h;
      ctx.fillStyle = KIND_COL[s.k];
      ctx.fillRect(plot.x + b * colW + 0.4, plot.y + plot.h - yoff - bh, colW - 0.8, bh);
      yoff += bh;
    }
    if (tot[b]) {
      const b0 = lo + b * (hi - lo) / nb, b1 = lo + (b + 1) * (hi - lo) / nb;
      els.pair.bars.push({
        x0: plot.x + b * colW, x1: plot.x + (b + 1) * colW,
        y0: plot.y, y1: plot.y + plot.h,
        lab: `${tot[b]} at ${fmtTick(b0)}–${fmtTick(b1)} kpc`,
      });
    }
  }
  if (nInf) {
    const bh = nInf / maxC * plot.h;
    ctx.fillStyle = KIND_COL[1];
    ctx.fillRect(plot.x + (nb + 1) * colW + 0.4, plot.y + plot.h - bh, colW - 0.8, bh);
    label(ctx, '∞', plot.x + (nb + 1.5) * colW, h - 18, { align: 'center', size: 12, color: KIND_COL[1] });
  }
  ctx.strokeStyle = UI.panelBorder;
  ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
  label(ctx, xlab, plot.x + plot.w / 2, h - 6, { align: 'center', size: 9 });
  const toX = v => plot.x + (v - lo) / (hi - lo) * (nb * colW);
  xTicks(ctx, plot, h, lo, hi, toX);
  yTicks(ctx, plot, maxC);
}
