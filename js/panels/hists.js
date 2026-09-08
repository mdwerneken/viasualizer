// Field statistics: (1) distances of the sources, stacked by kind, with the rung
// distances ticked; (2) magnitudes; (3) fiber crowding (nearest-neighbour separations,
// with the fiber-collision limit). Bars have hover readouts. ("backlights behind d"
// plot removed 9-7-26.)
import { D } from '../data.js';
import { state, set, on } from '../state.js';
import { F, KIND } from '../fieldmodel.js';
import * as C from '../compute.js';
import { UI, KIND_COL, KIND_LBL, scales } from '../colors.js';
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
  for (const id of ['dist', 'mag', 'nn']) {
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
    ctx.fillStyle = UI.axis;
    ctx.fillRect(X, plot.y + plot.h, 1, 3);
    label(ctx, fmtTick(v), X, h - 16, { align: 'center', size: 8, color: UI.textDim });
  }
}
function yTicks(ctx, plot, maxC) {
  const step = Math.max(1, niceStep(maxC, 4));
  for (let v = step; v <= maxC + 1e-9; v += step) {
    const Y = plot.y + plot.h - v / maxC * plot.h;
    ctx.fillStyle = UI.axis;
    ctx.fillRect(plot.x - 3, Y, 3, 1);
    label(ctx, fmtTick(v), plot.x - 5, Y + 3, { align: 'right', size: 8, color: UI.textDim });
  }
}

function drawAll() {
  if (!F.src) return;
  drawKindHist('dist', F.src.dist, 'distances', 'distance [kpc]', true,
    (n, a, b) => `${n} at ${a}–${b} kpc`,
    `${F.idx.filter(i => D.s_dist_known[i]).length} catalog · ${F.idx.filter(i => !D.s_dist_known[i]).length} geometric`, true);
  drawKindHist('mag', F.src.G, 'magnitudes', 'Gaia G (BHB: SDSS g)', false,
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
  ctx.strokeStyle = UI.axis;
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
const FIBER_MIN_SEP = 1.2;   // arcmin — minimum fiber separation (confirmed by Matt 9-8-26 as the working value)
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
    label(ctx, 'fiber crowding', plot.x, 12, { size: 10, color: UI.text });
    label(ctx, F.src.n > 2500 ? 'skipped while dragging' : 'fewer than 2 sources', w / 2, h / 2, { align: 'center', color: UI.textDim });
    return;
  }
  const sep = F.nn.sepAm;
  label(ctx, `fiber crowding`, plot.x, 12, { size: 10, color: UI.text });
  const mm = C.finiteMinMax(sep);
  let lo = Math.min(0, Math.floor(mm[0])), hi = Math.ceil(Math.max(mm[1], FIBER_MIN_SEP + 0.5));
  if (hi <= lo) hi = lo + 1;
  const nb = 40;
  const hist = C.histogram(sep, nb, lo, hi);
  const maxC = Math.max(1, C.arrMax(hist.counts));
  const colW = plot.w / nb;
  ctx.fillStyle = scales.dist.css(0.82);   // a blue from the distance colormap (its far end is the blue side)
  for (let b = 0; b < nb; b++) {
    const bh = hist.counts[b] / maxC * plot.h;
    ctx.fillRect(plot.x + b * colW + 0.3, plot.y + plot.h - bh, colW - 0.6, bh);
    if (hist.counts[b]) {
      const b0 = lo + b * (hi - lo) / nb, b1 = lo + (b + 1) * (hi - lo) / nb;
      rec.bars.push({ x0: plot.x + b * colW, x1: plot.x + (b + 1) * colW, y0: plot.y, y1: plot.y + plot.h,
        lab: `${hist.counts[b]} sources with a neighbour ${(+b0.toFixed(1))}–${(+b1.toFixed(1))}′ away` });
    }
  }
  ctx.strokeStyle = UI.axis;
  ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
  label(ctx, 'nearest-neighbour separation [arcmin]', plot.x + plot.w / 2, h - 4, { align: 'center', size: 9, color: UI.textDim });
  const toX = v => plot.x + (v - lo) / (hi - lo) * plot.w;
  xTicks(ctx, plot, h, lo, hi, toX);
  yTicks(ctx, plot, maxC);
  // fibers cannot be placed closer than this: sources left of the line collide
  const xc = toX(FIBER_MIN_SEP);
  ctx.save();
  ctx.strokeStyle = UI.text; ctx.lineWidth = 2.5; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(xc, plot.y); ctx.lineTo(xc, plot.y + plot.h); ctx.stroke();
  ctx.restore();
  let close = 0;
  for (let i = 0; i < sep.length; i++) if (sep[i] < FIBER_MIN_SEP) close++;
  const txt = `< ${FIBER_MIN_SEP}′ (${close})`;
  ctx.font = '8.5px "SF Mono", ui-monospace, Menlo, monospace';
  const tw = ctx.measureText(txt).width;
  ctx.fillStyle = 'rgba(25,24,22,0.85)';
  ctx.beginPath(); ctx.roundRect(xc + 3, plot.y + 2, tw + 6, 12, 3); ctx.fill();
  label(ctx, txt, xc + 6, plot.y + 11, { size: 8.5, color: UI.text });
}
