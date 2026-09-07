// Field statistics (v3 rework): (1) distances of the sources, stacked by kind, with the
// rung distances ticked; (2) backlights BEHIND each distance — the cold-gas question
// "how many sightlines pass through gas at distance d?"; (3) magnitudes; (4) fiber
// crowding (nearest-neighbour separations). Bars have hover readouts.
import { D } from '../data.js';
import { state, set, on } from '../state.js';
import { F, KIND } from '../fieldmodel.js';
import * as C from '../compute.js';
import { UI, KIND_COL, KIND_LBL } from '../colors.js';
import { placeTooltip } from '../scene3d.js';
import { fitCanvas, label } from './canvas2d.js';

let els = {};
let tipEl = null;
const ORDER = [KIND.STAR, KIND.MEM, KIND.MEM2, KIND.HALO, KIND.KG, KIND.BHB, KIND.KEP, KIND.QSO];

export function initHists(container) {
  tipEl = document.getElementById('tooltip2d');
  const ctl = document.createElement('div');
  ctl.className = 'hist-controls';
  ctl.innerHTML = `<label class="pc-chk"><input type="checkbox" id="connect-chk" ${state.connect ? 'checked' : ''}> nearest-neighbour lines on the field view</label>`;
  for (const id of ['dist', 'behind', 'mag', 'nn']) {
    const box = document.createElement('div');
    box.className = 'hist-box';
    const cvs = document.createElement('canvas');
    box.appendChild(cvs);
    container.appendChild(box);
    els[id] = { box, cvs, bars: [] };
    cvs.addEventListener('pointermove', e => barHover(id, e));
    cvs.addEventListener('pointerleave', () => { tipEl.style.display = 'none'; });
  }
  container.appendChild(ctl);
  ctl.querySelector('#connect-chk').addEventListener('change', e => set({ connect: e.target.checked }));
  on('fieldmodel', drawAll);
  on('theme', drawAll);
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

function niceStep(span, n = 6) {
  const raw = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
  for (const m of [1, 2, 5, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}
const fmtTick = v => Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : String(+v.toFixed(2));

function xTicks(ctx, plot, h, lo, hi, toX) {
  const step = niceStep(hi - lo, 6);
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
    const X = toX(v);
    ctx.fillStyle = UI.panelBorder;
    ctx.fillRect(X, plot.y + plot.h, 1, 3);
    label(ctx, fmtTick(v), X, h - 16, { align: 'center', size: 8, color: UI.textDim });
  }
}
function yTicks(ctx, plot, maxC) {
  const step = Math.max(1, niceStep(maxC, 4));
  for (let v = step; v <= maxC + 1e-9; v += step) {
    const Y = plot.y + plot.h - v / maxC * plot.h;
    ctx.fillStyle = UI.panelBorder;
    ctx.fillRect(plot.x - 3, Y, 3, 1);
    label(ctx, fmtTick(v), plot.x - 5, Y + 3, { align: 'right', size: 8, color: UI.textDim });
  }
}

function drawAll() {
  if (!F.src) return;
  drawKindHist('dist', F.src.dist, 'distances of sources in the field', 'distance [kpc]', true,
    (n, a, b) => `${n} at ${a}–${b} kpc`,
    `${F.idx.filter(i => D.s_dist_known[i]).length} catalog · ${F.idx.filter(i => !D.s_dist_known[i]).length} geometric`, true);
  drawBehind();
  drawKindHist('mag', F.src.G, 'magnitudes of sources in the field', 'Gaia G (BHB: SDSS g)', false,
    (n, a, b) => `${n} at G = ${a}–${b}`, `limit G ≤ ${state.ghi.toFixed(1)}`, false);
  drawNN();
}

function drawKindHist(id, values, title, xlab, infBin, labFmt, note, rungTicks) {
  const rec = els[id];
  const cvs = rec.cvs;
  const w = cvs.parentElement.clientWidth;
  if (!w) return;
  const h = 138;
  const ctx = fitCanvas(cvs, w, h);
  ctx.clearRect(0, 0, w, h);
  const plot = { x: 34, y: 18, w: w - 44, h: h - 50 };
  rec.bars = [];
  label(ctx, title, plot.x, 12, { size: 10, color: UI.text });
  if (note) label(ctx, note, w - 8, 12, { size: 8.5, align: 'right', color: UI.textDim });

  const kinds = F.src.kind;
  const mm = C.finiteMinMax(values);
  let nInf = 0;
  for (let i = 0; i < values.length; i++) if (values[i] === Infinity) nInf++;
  if (!mm && !nInf) { label(ctx, 'no sources in the field', w / 2, h / 2, { align: 'center', color: UI.textDim }); return; }

  let lo = mm ? Math.floor(mm[0]) : 0, hi = mm ? Math.ceil(mm[1]) : 1;
  if (hi <= lo) hi = lo + 1;
  const bw = Math.max(niceStep(hi - lo, 26), (hi - lo) / 40);
  const nb = Math.max(1, Math.round((hi - lo) / bw));
  const stacks = ORDER.map(k => {
    const arr = new Float64Array(values.length);
    let n = 0;
    for (let i = 0; i < values.length; i++) if (kinds[i] === k && Number.isFinite(values[i])) arr[n++] = values[i];
    return { k, hist: C.histogram(arr.subarray(0, n), nb, lo, hi), n };
  });
  const tot = new Int32Array(nb);
  for (const s of stacks) for (let b = 0; b < nb; b++) tot[b] += s.hist.counts[b];
  let maxC = Math.max(1, C.arrMax(tot));
  if (infBin && nInf) maxC = Math.max(maxC, nInf);

  const nCols = nb + (infBin && nInf ? 2 : 0);
  const colW = plot.w / nCols;
  for (let b = 0; b < nb; b++) {
    let yoff = 0;
    const parts = [];
    for (const s of stacks) {
      const c = s.hist.counts[b];
      if (!c) continue;
      const bh = c / maxC * plot.h;
      ctx.fillStyle = KIND_COL[s.k];
      ctx.fillRect(plot.x + b * colW + 0.4, plot.y + plot.h - yoff - bh, colW - 0.8, bh);
      yoff += bh;
      parts.push(`${c} ${KIND_LBL[s.k]}`);
    }
    if (tot[b]) {
      const b0 = lo + b * (hi - lo) / nb, b1 = lo + (b + 1) * (hi - lo) / nb;
      rec.bars.push({ x0: plot.x + b * colW, x1: plot.x + (b + 1) * colW, y0: plot.y, y1: plot.y + plot.h,
        lab: `${labFmt(tot[b], fmtTick(b0), fmtTick(b1))}<br><span style="opacity:.75">${parts.join(' · ')}</span>` });
    }
  }
  if (infBin && nInf) {
    const bh = nInf / maxC * plot.h;
    ctx.fillStyle = KIND_COL[KIND.QSO];
    ctx.fillRect(plot.x + (nb + 1) * colW + 0.4, plot.y + plot.h - bh, colW - 0.8, bh);
    label(ctx, '∞', plot.x + (nb + 1.5) * colW, h - 16, { align: 'center', size: 12, color: KIND_COL[KIND.QSO] });
    rec.bars.push({ x0: plot.x + (nb + 1) * colW, x1: plot.x + (nb + 2) * colW, y0: plot.y, y1: plot.y + plot.h,
      lab: `${nInf} quasars at ∞` });
  }
  const toX = v => plot.x + (v - lo) / (hi - lo) * (nb * colW);
  // rung distances as small triangles under the axis
  if (rungTicks && F.ladder) {
    for (const grp of F.ladder.groups) {
      const d = grp.reduce((s, r) => s + r.dist, 0) / grp.length;
      if (d < lo || d > hi) continue;
      const X = toX(d);
      ctx.fillStyle = UI.accent;
      ctx.beginPath(); ctx.moveTo(X, plot.y + plot.h + 1); ctx.lineTo(X - 4, plot.y + plot.h + 7); ctx.lineTo(X + 4, plot.y + plot.h + 7); ctx.fill();
    }
    label(ctx, '▲ rung', w - 8, h - 4, { align: 'right', size: 8, color: UI.accent });
  }
  ctx.strokeStyle = UI.panelBorder;
  ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
  label(ctx, xlab, plot.x + plot.w / 2, h - 4, { align: 'center', size: 9, color: UI.textDim });
  xTicks(ctx, plot, h, lo, hi, toX);
  yTicks(ctx, plot, maxC);
  // legend chips for the kinds present
  let lx = plot.x + 4;
  for (const s of stacks) {
    if (!s.n) continue;
    ctx.fillStyle = KIND_COL[s.k];
    ctx.fillRect(lx, plot.y + 4, 7, 7);
    label(ctx, `${KIND_LBL[s.k]} ${s.n}`, lx + 10, plot.y + 10, { size: 7.5, color: UI.textDim });
    lx += 22 + ctx.measureText(`${KIND_LBL[s.k]} ${s.n}`).width * 0.95;
    if (lx > plot.x + plot.w - 40) break;
  }
}

// backlights beyond distance d: N(dist > d) on a log axis; quasars add a constant floor
function drawBehind() {
  const rec = els.behind;
  const cvs = rec.cvs;
  const w = cvs.parentElement.clientWidth;
  if (!w) return;
  const h = 150;
  const ctx = fitCanvas(cvs, w, h);
  ctx.clearRect(0, 0, w, h);
  const plot = { x: 38, y: 18, w: w - 48, h: h - 50 };
  rec.bars = [];
  label(ctx, 'backlights behind distance d', plot.x, 12, { size: 10, color: UI.text });
  label(ctx, 'sightlines that would pass through gas at d', w - 8, 12, { size: 8.5, align: 'right', color: UI.textDim });
  const dist = F.src.dist, kinds = F.src.kind;
  const nQ = F.qq.length;
  const fin = [];
  for (let i = 0; i < dist.length; i++) if (Number.isFinite(dist[i])) fin.push(dist[i]);
  if (!fin.length && !nQ) { label(ctx, 'no sources in the field', w / 2, h / 2, { align: 'center', color: UI.textDim }); return; }
  fin.sort((a, b) => a - b);
  const dMin = 0.5, dMax = 300;
  const lx = d => plot.x + (Math.log10(Math.max(dMin, Math.min(dMax, d))) - Math.log10(dMin)) / (Math.log10(dMax) - Math.log10(dMin)) * plot.w;
  const total = fin.length + nQ;
  const maxC = Math.max(1, total);
  const ly = n => plot.y + plot.h - n / maxC * plot.h;
  // quasar floor (always behind everything)
  if (nQ) {
    ctx.fillStyle = KIND_COL[KIND.QSO] + '55';
    ctx.fillRect(plot.x, ly(nQ), plot.w, plot.y + plot.h - ly(nQ));
    label(ctx, `${nQ} quasars (∞)`, plot.x + plot.w - 4, ly(nQ) - 3, { align: 'right', size: 8, color: KIND_COL[KIND.QSO] });
  }
  // step curve: N(dist > d) + nQ, evaluated at each source distance
  ctx.strokeStyle = UI.text;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  let n = fin.length + nQ;
  ctx.moveTo(plot.x, ly(n));
  for (let i = 0; i < fin.length; i++) {
    const X = lx(fin[i]);
    ctx.lineTo(X, ly(n));
    n--;
    ctx.lineTo(X, ly(n));
  }
  ctx.lineTo(plot.x + plot.w, ly(nQ));
  ctx.stroke();
  // colored ticks at each source distance (by kind) along the bottom
  for (let i = 0; i < dist.length; i++) {
    if (!Number.isFinite(dist[i])) continue;
    ctx.fillStyle = KIND_COL[kinds[i]];
    ctx.fillRect(lx(dist[i]), plot.y + plot.h - 6, 1, 6);
  }
  // rung distances
  if (F.ladder) {
    for (const grp of F.ladder.groups) {
      const d = grp.reduce((s, r) => s + r.dist, 0) / grp.length;
      const X = lx(d);
      let behind = nQ;
      for (let i = fin.length - 1; i >= 0 && fin[i] > d * 1.2; i--) behind++;
      ctx.strokeStyle = UI.accent;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(X, plot.y); ctx.lineTo(X, plot.y + plot.h); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = UI.accent;
      ctx.beginPath(); ctx.moveTo(X, plot.y + plot.h + 1); ctx.lineTo(X - 4, plot.y + plot.h + 7); ctx.lineTo(X + 4, plot.y + plot.h + 7); ctx.fill();
      rec.bars.push({ x0: X - 6, x1: X + 6, y0: plot.y, y1: plot.y + plot.h,
        lab: `rung at ${d.toFixed(1)} kpc (${grp.map(r => r.label).join(' + ')})<br>${behind} backlights more than 20% farther` });
    }
  }
  // hover readout across the plot: N behind d
  const NB = 24;
  for (let k = 0; k < NB; k++) {
    const x0 = plot.x + k * plot.w / NB, x1 = x0 + plot.w / NB;
    const d = 10 ** (Math.log10(dMin) + (k + 0.5) / NB * (Math.log10(dMax) - Math.log10(dMin)));
    let behind = nQ;
    for (let i = fin.length - 1; i >= 0 && fin[i] > d; i--) behind++;
    rec.bars.push({ x0, x1, y0: plot.y, y1: plot.y + plot.h - 8, lab: `${behind} backlights beyond ${d < 10 ? d.toFixed(1) : d.toFixed(0)} kpc` });
  }
  ctx.strokeStyle = UI.panelBorder;
  ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
  for (const t of [1, 2, 5, 10, 20, 50, 100, 200]) {
    const X = lx(t);
    ctx.fillStyle = UI.panelBorder;
    ctx.fillRect(X, plot.y + plot.h, 1, 3);
    label(ctx, String(t), X, h - 16, { align: 'center', size: 8, color: UI.textDim });
  }
  label(ctx, 'distance d [kpc, log]', plot.x + plot.w / 2, h - 4, { align: 'center', size: 9, color: UI.textDim });
  yTicks(ctx, plot, maxC);
  label(ctx, 'N behind', 4, plot.y + 8, { size: 8, color: UI.textDim });
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
    label(ctx, 'fiber crowding — nearest-neighbour separation', plot.x, 12, { size: 10, color: UI.text });
    label(ctx, F.src.n > 2500 ? 'skipped while dragging' : 'fewer than 2 sources', w / 2, h / 2, { align: 'center', color: UI.textDim });
    return;
  }
  const sep = F.nn.sepAm;
  const med = C.median(sep);
  let close = 0;
  for (let i = 0; i < sep.length; i++) if (sep[i] < 1) close++;
  label(ctx, `fiber crowding — nearest-neighbour separation`, plot.x, 12, { size: 10, color: UI.text });
  label(ctx, `median ${med.toFixed(2)}′ · ${close} closer than 1′`, w - 8, 12, { size: 8.5, align: 'right', color: UI.textDim });
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
      rec.bars.push({ x0: plot.x + b * colW, x1: plot.x + (b + 1) * colW, y0: plot.y, y1: plot.y + plot.h,
        lab: `${hist.counts[b]} sources with a neighbour ${(+b0.toFixed(1))}–${(+b1.toFixed(1))}′ away` });
    }
  }
  ctx.strokeStyle = UI.panelBorder;
  ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
  label(ctx, 'nearest-neighbour separation [arcmin]', plot.x + plot.w / 2, h - 4, { align: 'center', size: 9, color: UI.textDim });
  const toX = v => plot.x + (v - lo) / (hi - lo) * plot.w;
  xTicks(ctx, plot, h, lo, hi, toX);
  yTicks(ctx, plot, maxC);
}
