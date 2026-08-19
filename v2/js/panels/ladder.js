// Distance-ladder panel: the field's rung count (headline metric), the ladder graphic
// on a log-distance axis, and the Via fiber budget (576 positioners / 540 Viaspec).
import { state, on } from '../state.js';
import { F } from '../fieldmodel.js';
import { UI, KIND_COL } from '../colors.js';
import { fitCanvas, hexagram, diamond, dot, label, starGlyph } from './canvas2d.js';

let wrap, headEl, cvs, fibEl;
const KC = { stream: '#e08585', GC: UI.gc, dwarf: UI.dwarf, qso: UI.accent2 };

export function initLadder(container) {
  wrap = container;
  headEl = document.createElement('div');
  headEl.className = 'ladder-head';
  cvs = document.createElement('canvas');
  fibEl = document.createElement('div');
  fibEl.className = 'fiber-box';
  container.append(headEl, cvs, fibEl);
  on('fieldmodel', draw);
  new ResizeObserver(draw).observe(container);
}

function draw() {
  const L = F.ladder;
  headEl.innerHTML =
    `<span class="rung-count">${L.nRungs}</span> distance rung${L.nRungs === 1 ? '' : 's'}` +
    `<span class="rung-sub"> · ${L.groups.length} structure group${L.groups.length === 1 ? '' : 's'}` +
    `${L.qsoRung ? ` + quasars (∞)` : ''}</span>`;

  const w = wrap.clientWidth;
  if (!w) return;
  const rows = L.groups.length + (L.qsoRung ? 1 : 0);
  const h = Math.max(46, 22 + rows * 21);
  const ctx = fitCanvas(cvs, w, h);
  ctx.clearRect(0, 0, w, h);
  if (!rows) {
    label(ctx, 'no rungs — no structures with ≥2 sources in field', w / 2, h / 2, { align: 'center' });
    renderFibers();
    return;
  }
  const x0 = 8, x1 = w - 8;
  const dMin = 1.5, dMax = 130;                  // kpc log axis; ∞ parked at right
  const lx = d => x0 + (Math.log10(Math.max(d, dMin)) - Math.log10(dMin)) /
    (Math.log10(dMax) - Math.log10(dMin)) * (x1 - x0 - 46);
  // axis
  ctx.fillStyle = UI.panelBorder;
  ctx.fillRect(x0, h - 14, x1 - x0, 1);
  for (const t of [2, 5, 10, 20, 50, 100]) {
    label(ctx, String(t), lx(t), h - 3, { align: 'center', size: 8 });
    ctx.fillRect(lx(t), h - 17, 1, 3);
  }
  label(ctx, '∞', x1 - 20, h - 3, { align: 'center', size: 10, color: UI.accent2 });

  let y = 14;
  for (const grp of L.groups) {
    const xs = grp.map(r => lx(r.dist));
    ctx.strokeStyle = '#2b3448';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(Math.min(...xs) - 2, y);
    ctx.lineTo(Math.max(...xs) + 2, y);
    ctx.stroke();
    for (const r of grp) {
      const X = lx(r.dist);
      if (r.kind === 'GC') hexagram(cvs.getContext('2d'), X, y, 6, KC.GC, '#000a');
      else if (r.kind === 'dwarf') diamond(cvs.getContext('2d'), X, y, 5.5, KC.dwarf, '#000a');
      else dot(cvs.getContext('2d'), X, y, 4.5, KC.stream, 0.95);
      const nl = r.kind === 'stream' ? `${r.n}★` : r.label.length > 14 ? '' : '';
      label(ctx, `${r.label} ${r.dist.toFixed(1)}${r.kind === 'stream' ? ` (${r.n}★)` : ''}`,
        Math.min(X + 9, w - 120), y + 3, { size: 8.5, color: UI.textDim });
    }
    y += 21;
  }
  if (L.qsoRung) {
    dot(ctx, x1 - 20, y, 4.5, KC.qso, 0.95);
    label(ctx, `${L.nQso} quasars`, x1 - 30, y + 3, { align: 'right', size: 8.5, color: UI.textDim });
  }
  renderFibers();
}

function renderFibers() {
  const f = F.fibers;
  const segs = [
    ['stars', f.stars, KIND_COL[0]],
    ['dwarf ★', f.members, KIND_COL[2]],
    ['QSO', f.qsos, KIND_COL[1]],
  ].filter(s => s[1] > 0);
  const pct = v => Math.min(100, v / f.science * 100);
  let barHtml = '<div class="fiber-bar">';
  for (const [nm, v, c] of segs) {
    barHtml += `<span style="width:${pct(v)}%;background:${c}" title="${nm}: ${v}"></span>`;
  }
  barHtml += '</div>';
  const status = f.over
    ? `<b class="over">${f.over} over</b> the 540 Viaspec fibers — field is target-rich`
    : `<b>${f.spare}</b> spare fibers for ancillary science`;
  fibEl.innerHTML =
    `<div class="fiber-title">Via fiber budget <span class="tiny">(1° focal plane · 576 positioners)</span></div>` +
    barHtml +
    `<div class="fiber-line">${f.targets} targets` +
    ` (${segs.map(([nm, v]) => `${v} ${nm}`).join(' · ')}) → ${status}</div>` +
    (state.fov > 1.001 ? `<div class="tiny warn">FOV ${state.fov}° > instrument field — budget applies per 1° pointing</div>` : '');
}
