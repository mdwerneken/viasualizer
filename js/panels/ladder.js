// Distance-ladder panel: the field's rung count (headline metric) and the ladder
// graphic on a log-distance axis. Hovering a rung icon pops those sources out on
// the finder chart (via the 'hilite' topic).
import { D } from '../data.js';
import { state, on, emit } from '../state.js';
import { F } from '../fieldmodel.js';
import { UI, streamColorByName, dwarfColorByName } from '../colors.js';
import { fitCanvas, hexagram, diamond, dot, starGlyph, label } from './canvas2d.js';

let wrap, headEl, cvs;
let iconHits = [];
let hoverRung = null;
const KC = () => ({ stream: '#e08585', GC: UI.gc, dwarf: UI.dwarf, halo: UI.halo, kg: UI.kg, bhb: UI.bhb, qso: UI.accent2 });

export function initLadder(container) {
  wrap = container;
  headEl = document.getElementById('ladder-title');
  cvs = document.createElement('canvas');
  container.append(cvs);
  on('fieldmodel', draw);
  on('theme', draw);
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
  if (!L) return;
  const dists = L.groups.map(g => {
    const md = g.reduce((s, r) => s + r.dist, 0) / g.length;
    return md >= 100 ? md.toFixed(0) : md.toFixed(1);
  });
  const distTxt = [...dists.map(d => `${d} kpc`), ...(L.qsoRung ? ['∞'] : [])].join(' • ');
  if (headEl) headEl.innerHTML = `<span class="tcount">${L.nRungs}</span> distance rung${L.nRungs === 1 ? '' : 's'}`;
  const sub = document.getElementById('ladder-dists');
  if (sub) sub.textContent = distTxt;

  const w = wrap.clientWidth;
  if (!w) return;
  const rows = L.groups.length + (L.qsoRung ? 1 : 0);
  if (!rows) {
    const ctx0 = fitCanvas(cvs, w, 46);
    ctx0.clearRect(0, 0, w, 46);
    iconHits = [];
    label(ctx0, 'no rungs — no structure with ≥2 sources in the field', w / 2, 24, { align: 'center', color: UI.textDim });
    return;
  }
  const x0 = 8, x1 = w - 8;
  const dMin = 1.5, dMax = 130;
  const lx = d => Math.min(x1 - 50,
    x0 + (Math.log10(Math.max(d, dMin)) - Math.log10(dMin)) /
    (Math.log10(dMax) - Math.log10(dMin)) * (x1 - x0 - 46));

  const meas = cvs.getContext('2d');
  meas.font = '10px "SF Mono", ui-monospace, Menlo, monospace';
  const XRIGHT = w - 62;
  const lbl = r => (r.kind === 'GC') ? r.label : `${r.label} (${r.n}★)`;
  const layouts = L.groups.map(grp => {
    const items = grp.map(r => ({ r, X: lx(r.dist) })).sort((a, b) => a.X - b.X);
    const labItems = items.length > 3
      ? [{ it: items[0], txt: lbl(items[0].r) },
         { it: items[1], txt: lbl(items[1].r) },
         { it: items[2], txt: `+${items.length - 2} more` }]
      : items.map(it => ({ it, txt: lbl(it.r) }));
    const lines = [];
    const spans = [];
    let nLines = 1;
    for (const { it, txt } of labItems) {
      const tw = meas.measureText(txt).width;
      let tx = it.X + 11;
      if (tx + tw > XRIGHT) tx = it.X - 11 - tw;
      tx = Math.max(2, Math.min(tx, w - tw - 2));
      let line = 0, placed = false;
      for (; line < 3; line++) {
        const row = spans[line] ?? (spans[line] = []);
        if (!row.some(([a, b]) => tx < b + 6 && tx + tw > a - 6)) {
          row.push([tx, tx + tw]);
          placed = true;
          break;
        }
      }
      if (!placed) { line = 3; (spans[3] ?? (spans[3] = [])).push([tx, tx + tw]); }
      lines.push({ txt, tx, line });
      nLines = Math.max(nLines, line + 1);
    }
    return { items, lines, nLines };
  });
  const rowH = 26, lineH = 13;
  let hTot = 22;
  for (const lay of layouts) hTot += rowH + (lay.nLines - 1) * lineH;
  if (L.qsoRung) hTot += rowH;
  const h = Math.max(46, hTot);
  const ctx = fitCanvas(cvs, w, h);
  ctx.clearRect(0, 0, w, h);
  iconHits = [];
  const kc = KC();
  ctx.fillStyle = UI.axis;
  ctx.fillRect(x0, h - 14, x1 - x0, 1);
  for (const t of [2, 5, 10, 20, 50, 100]) {
    label(ctx, String(t), lx(t), h - 3, { align: 'center', size: 8, color: UI.textDim });
    ctx.fillRect(lx(t), h - 17, 1, 3);
  }
  label(ctx, 'kpc', x0, h - 3, { size: 8, color: UI.textDim });
  label(ctx, '∞', x1 - 20, h - 3, { align: 'center', size: 10, color: UI.accent2 });

  let y = 14;
  for (const lay of layouts) {
    const xs = lay.items.map(it => it.X);
    ctx.strokeStyle = UI.rungLine;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(Math.min(...xs) - 2, y);
    ctx.lineTo(Math.max(...xs) + 2, y);
    ctx.stroke();
    for (const it of lay.items) {
      const { r, X } = it;
      if (r.kind === 'GC') hexagram(ctx, X, y, 8, kc.GC, '#000a');
      else if (r.kind === 'dwarf') {
        const c = D.DWF.name.includes(r.label) ? dwarfColorByName(r.label) : streamColorByName(r.label);
        diamond(ctx, X, y, 7.5, c, '#000a');
      } else if (r.kind === 'halo' || r.kind === 'kg' || r.kind === 'bhb') dot(ctx, X, y, 6.5, kc[r.kind], 0.95);
      else starGlyph(ctx, X, y, 8, streamColorByName(r.label), '#000a');
      iconHits.push({ x: X, y, r: 11, rung: r });
    }
    for (const ln of lay.lines) {
      label(ctx, ln.txt, ln.tx, y + 3.5 + ln.line * lineH, { size: 10, color: UI.textDim });
    }
    y += rowH + (lay.nLines - 1) * lineH;
  }
  if (L.qsoRung) {
    dot(ctx, x1 - 20, y, 6.5, kc.qso, 0.95);
    label(ctx, `${L.nQso} quasars`, x1 - 32, y + 3.5, { align: 'right', size: 10, color: UI.textDim });
    iconHits.push({ x: x1 - 20, y, r: 11, rung: { kind: 'qso' } });
  }
}
