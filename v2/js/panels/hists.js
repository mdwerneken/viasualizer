// Field histograms (distance, magnitude, NN separation) and the pair plot.
// Stacked by source kind, with an ∞ bin for quasars (v1's _kind_hist port).
import { D } from '../data.js';
import { state, on } from '../state.js';
import { F } from '../fieldmodel.js';
import * as C from '../compute.js';
import { UI, KIND_COL, scales } from '../colors.js';
import { fitCanvas, label } from './canvas2d.js';

let els = {};

export function initHists(container) {
  for (const id of ['dist', 'mag', 'nn', 'pair']) {
    const box = document.createElement('div');
    box.className = 'hist-box';
    const cvs = document.createElement('canvas');
    box.appendChild(cvs);
    container.appendChild(box);
    els[id] = { box, cvs };
  }
  on('fieldmodel', drawAll);
  new ResizeObserver(drawAll).observe(container);
}

let pairStale = false;
function drawAll(opts) {
  drawKindHist(els.dist.cvs, F.src.dist, 'field distances', 'dist [kpc]', true,
    `${F.idx.filter(i => D.s_dist_known[i]).length} meas · ${F.idx.filter(i => !D.s_dist_known[i]).length} geom`);
  drawKindHist(els.mag.cvs, F.src.G, 'field magnitudes', 'Gaia G', false);
  drawNN(els.nn.cvs);
  // the O(n^2) pair plot waits until a live drag ends
  if (opts?.live && F.src.n > 300) { pairStale = true; return; }
  pairStale = false;
  drawPair(els.pair.cvs);
}

function drawKindHist(cvs, values, title, xlab, infBin, note) {
  const w = cvs.parentElement.clientWidth;
  if (!w) return;
  const h = 130;
  const ctx = fitCanvas(cvs, w, h);
  ctx.clearRect(0, 0, w, h);
  const plot = { x: 30, y: 18, w: w - 40, h: h - 44 };
  label(ctx, title, plot.x, 12, { size: 10, color: UI.text });
  if (note) label(ctx, note, w - 8, 12, { size: 8.5, align: 'right' });

  const kinds = F.src.kind;
  const mm = C.finiteMinMax(values);
  let nInf = 0;
  for (let i = 0; i < values.length; i++) if (values[i] === Infinity) nInf++;
  if (!mm && !nInf) { label(ctx, 'no sources', w / 2, h / 2, { align: 'center' }); return; }

  const nb = 28;
  let lo = mm ? mm[0] : 0, hi = mm ? mm[1] : 1;
  if (hi <= lo) hi = lo + 1;
  const bw = (hi - lo) / nb;
  // stacked counts per kind (draw order: star, member, qso)
  const stacks = [0, 2, 1].map(k => {
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
  }
  if (infBin && nInf) {
    const bh = nInf / maxC * plot.h;
    ctx.fillStyle = KIND_COL[1];
    ctx.fillRect(plot.x + (nb + 1) * colW + 0.4, plot.y + plot.h - bh, colW - 0.8, bh);
    label(ctx, '∞', plot.x + (nb + 1.5) * colW, h - 16, { align: 'center', size: 12, color: KIND_COL[1] });
  }
  // axis
  ctx.strokeStyle = UI.panelBorder;
  ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
  label(ctx, xlab, plot.x + plot.w / 2, h - 4, { align: 'center', size: 9 });
  if (mm) {
    label(ctx, lo.toFixed(hi - lo > 20 ? 0 : 1), plot.x, h - 16, { size: 8 });
    label(ctx, hi.toFixed(hi - lo > 20 ? 0 : 1), plot.x + nb * colW, h - 16, { align: 'right', size: 8 });
  }
  label(ctx, String(maxC), plot.x - 3, plot.y + 8, { align: 'right', size: 8 });
}

function drawNN(cvs) {
  const w = cvs.parentElement.clientWidth;
  if (!w) return;
  const h = 130;
  const ctx = fitCanvas(cvs, w, h);
  ctx.clearRect(0, 0, w, h);
  const plot = { x: 30, y: 18, w: w - 40, h: h - 44 };
  if (!F.nn) {
    label(ctx, F.src.n > 2500 ? 'NN skipped while dragging' : 'fewer than 2 sources',
      w / 2, h / 2, { align: 'center' });
    return;
  }
  const sep = F.nn.sepAm;
  const med = C.median(sep);
  label(ctx, `NN separation (median ${med.toFixed(2)}′)`, plot.x, 12, { size: 10, color: UI.text });
  const mm = C.finiteMinMax(sep);
  const hist = C.histogram(sep, 40, mm[0], mm[1]);
  const maxC = Math.max(1, C.arrMax(hist.counts));
  const colW = plot.w / 40;
  ctx.fillStyle = UI.hist;
  for (let b = 0; b < 40; b++) {
    const bh = hist.counts[b] / maxC * plot.h;
    ctx.fillRect(plot.x + b * colW + 0.3, plot.y + plot.h - bh, colW - 0.6, bh);
  }
  ctx.strokeStyle = UI.panelBorder;
  ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
  label(ctx, 'NN sep [arcmin]', plot.x + plot.w / 2, h - 4, { align: 'center', size: 9 });
  label(ctx, mm[0].toFixed(1), plot.x, h - 16, { size: 8 });
  label(ctx, mm[1].toFixed(1), plot.x + plot.w, h - 16, { align: 'right', size: 8 });
  label(ctx, String(maxC), plot.x - 3, plot.y + 8, { align: 'right', size: 8 });
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
    label(ctx, sMax.toFixed(0) + '′', plot.x + plot.w, h - 18, { align: 'right', size: 8 });
    label(ctx, qMax.toFixed(0), plot.x - 3, plot.y + 8, { align: 'right', size: 8 });
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
  } else {
    // Δd histogram of NN pairs, stacked by kind
    const dd = new Float64Array(F.src.n);
    for (let i = 0; i < F.src.n; i++) {
      const a = F.src.dist[i], b = F.src.dist[F.nn.nn[i]];
      dd[i] = (Number.isFinite(a) && Number.isFinite(b)) ? Math.abs(a - b)
        : (a === Infinity && b === Infinity ? NaN : Infinity);
    }
    const saved = F.src.dist;
    drawKindHistInline(ctx, plot, w, h, dd, F.src.kind, 'NN Δdistance', '|d_i − d_nn| [kpc]');
  }
}

function drawKindHistInline(ctx, plot, w, h, values, kinds, title, xlab) {
  label(ctx, title, plot.x, 12, { size: 10, color: UI.text });
  const mm = C.finiteMinMax(values);
  let nInf = 0;
  for (let i = 0; i < values.length; i++) if (values[i] === Infinity) nInf++;
  if (!mm && !nInf) { label(ctx, 'no pairs', w / 2, h / 2, { align: 'center' }); return; }
  const nb = 34;
  let lo = mm ? mm[0] : 0, hi = mm ? mm[1] : 1;
  if (hi <= lo) hi = lo + 1;
  const stacks = [0, 2, 1].map(k => {
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
  label(ctx, lo.toFixed(1), plot.x, h - 18, { size: 8 });
  label(ctx, hi.toFixed(1), plot.x + nb * colW, h - 18, { align: 'right', size: 8 });
  label(ctx, String(maxC), plot.x - 3, plot.y + 8, { align: 'right', size: 8 });
}
