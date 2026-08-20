// Distance-ladder panel: the field's rung count (headline metric) and the ladder
// graphic on a log-distance axis. Hovering a rung icon pops those sources out on
// the finder chart (via the 'hilite' topic). The fiber budget lives in the stats box.
import { D } from '../data.js';
import { state, on, emit } from '../state.js';
import { F } from '../fieldmodel.js';
import { UI, streamColorByName, dwarfColorByName } from '../colors.js';
import { fitCanvas, hexagram, diamond, dot, label } from './canvas2d.js';

let wrap, headEl, cvs;
let iconHits = [];            // [{x, y, r, rung}] for hover pop-out
let hoverRung = null;
const KC = { stream: '#e08585', GC: UI.gc, dwarf: UI.dwarf, halo: UI.halo, qso: UI.accent2 };

export function initLadder(container) {
  wrap = container;
  headEl = document.createElement('div');
  headEl.className = 'ladder-head';
  cvs = document.createElement('canvas');
  container.append(headEl, cvs);
  on('fieldmodel', draw);
  new ResizeObserver(draw).observe(container);
  cvs.addEventListener('pointermove', e => {
    const r = cvs.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null;
    for (const h of iconHits) {
      if (Math.hypot(h.x - x, h.y - y) <= h.r) { best = h.rung; break; }
    }
    if (best !== hoverRung) {
      hoverRung = best;
      emit('hilite', !best ? null
        : best.kind === 'qso' ? { type: 'kind', kind: 1 }
        : { type: 'rung', rung: best });
      cvs.style.cursor = best ? 'pointer' : '';
    }
  });
  cvs.addEventListener('pointerleave', () => {
    if (hoverRung) { hoverRung = null; emit('hilite', null); }
  });
}

function draw() {
  const L = F.ladder;
  // headline: rung count + the rung distances themselves
  const dists = L.groups.map(g => {
    const md = g.reduce((s, r) => s + r.dist, 0) / g.length;
    return md >= 100 ? md.toFixed(0) : md.toFixed(1);
  });
  const distTxt = [...dists.map(d => `${d} kpc`), ...(L.qsoRung ? ['∞'] : [])].join(' • ');
  headEl.innerHTML =
    `<span class="rung-count">${L.nRungs}</span> distance rung${L.nRungs === 1 ? '' : 's'}` +
    `<span class="rung-sub">${distTxt ? ' • ' + distTxt : ''}</span>`;

  const w = wrap.clientWidth;
  if (!w) return;
  const rows = L.groups.length + (L.qsoRung ? 1 : 0);
  if (!rows) {
    const ctx0 = fitCanvas(cvs, w, 46);
    ctx0.clearRect(0, 0, w, 46);
    iconHits = [];
    label(ctx0, 'no rungs — no structures with ≥2 sources in field', w / 2, 24, { align: 'center' });
    return;
  }
  const x0 = 8, x1 = w - 8;
  const dMin = 1.5, dMax = 130;                  // kpc log axis; ∞ parked at right
  // beyond-axis objects (e.g. M31-distance dwarfs) clamp to the axis end
  const lx = d => Math.min(x1 - 50,
    x0 + (Math.log10(Math.max(d, dMin)) - Math.log10(dMin)) /
    (Math.log10(dMax) - Math.log10(dMin)) * (x1 - x0 - 46));

  // measure + lay out each group's labels first (wrapping onto extra lines when a
  // group is crowded), so the canvas height fits before anything is drawn
  const meas = cvs.getContext('2d');
  meas.font = '8.5px "SF Mono", ui-monospace, Menlo, monospace';
  const layouts = L.groups.map(grp => {
    const items = grp.map(r => ({ r, X: lx(r.dist) })).sort((a, b) => a.X - b.X);
    const lines = [];
    let cursor = -Infinity, line = 0;
    for (const it of items) {
      const txt = (it.r.kind === 'GC') ? it.r.label : `${it.r.label} (${it.r.n}★)`;
      const tw = meas.measureText(txt).width;
      let tx = Math.min(it.X + 9, w - tw - 6);
      if (tx < cursor + 8) tx = cursor + 8;
      if (tx + tw > w - 4) {                     // wrap to a continuation line
        line++;
        tx = Math.max(x0, Math.min(items[0].X + 9, w - tw - 6));
      }
      lines.push({ txt, tx, line });
      cursor = tx + tw;
    }
    return { items, lines, nLines: line + 1 };
  });
  const rowH = 21, lineH = 11;
  let hTot = 22;
  for (const lay of layouts) hTot += rowH + (lay.nLines - 1) * lineH;
  if (L.qsoRung) hTot += rowH;
  const h = Math.max(46, hTot);
  const ctx = fitCanvas(cvs, w, h);
  ctx.clearRect(0, 0, w, h);
  iconHits = [];
  // axis
  ctx.fillStyle = UI.panelBorder;
  ctx.fillRect(x0, h - 14, x1 - x0, 1);
  for (const t of [2, 5, 10, 20, 50, 100]) {
    label(ctx, String(t), lx(t), h - 3, { align: 'center', size: 8 });
    ctx.fillRect(lx(t), h - 17, 1, 3);
  }
  label(ctx, '∞', x1 - 20, h - 3, { align: 'center', size: 10, color: UI.accent2 });

  let y = 14;
  for (const lay of layouts) {
    const xs = lay.items.map(it => it.X);
    ctx.strokeStyle = '#2b3448';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(Math.min(...xs) - 2, y);
    ctx.lineTo(Math.max(...xs) + 2, y);
    ctx.stroke();
    for (const it of lay.items) {
      const { r, X } = it;
      // icon colors match the per-object colors in the field view (merged systems
      // like "Sgr system" have dwarf kind but a stream label — use the stream color)
      if (r.kind === 'GC') hexagram(ctx, X, y, 6, KC.GC, '#000a');
      else if (r.kind === 'dwarf') {
        const c = D.DWF.name.includes(r.label) ? dwarfColorByName(r.label) : streamColorByName(r.label);
        diamond(ctx, X, y, 5.5, c, '#000a');
      } else if (r.kind === 'halo') dot(ctx, X, y, 4.5, KC.halo, 0.95);
      else dot(ctx, X, y, 4.5, streamColorByName(r.label), 0.95);
      iconHits.push({ x: X, y, r: 8, rung: r });
    }
    for (const ln of lay.lines) {
      label(ctx, ln.txt, ln.tx, y + 3 + ln.line * lineH, { size: 8.5, color: UI.textDim });
    }
    y += rowH + (lay.nLines - 1) * lineH;
  }
  if (L.qsoRung) {
    dot(ctx, x1 - 20, y, 4.5, KC.qso, 0.95);
    label(ctx, `${L.nQso} quasars`, x1 - 30, y + 3, { align: 'right', size: 8.5, color: UI.textDim });
    iconHits.push({ x: x1 - 20, y, r: 8, rung: { kind: 'qso' } });
  }
}
