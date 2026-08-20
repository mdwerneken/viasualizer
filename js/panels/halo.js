// Halo tab — full-catalog statistics and the scan_fields shortlist browser.
import { D } from '../data.js';
import { state, set, setField, on } from '../state.js';
import * as C from '../compute.js';
import { UI, KIND_COL } from '../colors.js';
import { fitCanvas, label } from './canvas2d.js';

let wrap, built = false;

export function initHalo(container) {
  wrap = container;
  on('quaia', () => { built = false; maybeBuild(); });
  on('ui', () => { built = false; maybeBuild(); });   // FOV / G-limit changes swap the shortlist
  maybeBuild();
  new ResizeObserver(() => { built = false; maybeBuild(); }).observe(container);
}

export function maybeBuild() {
  if (built || !wrap.clientWidth || wrap.offsetParent === null) return;
  built = true;
  wrap.innerHTML = '';

  const totals = document.createElement('div');
  totals.className = 'halo-totals';
  const nq = D.QSO ? D.QSO.lam.length.toLocaleString() : '…';
  totals.innerHTML =
    `<div class="halo-cards">` +
    card(D.N.toLocaleString(), 'stream stars', `${D.STREAM_NAMES.length} streams`) +
    card(D.GCC.lam.length, 'globular clusters', 'Baumgardt+21') +
    card(D.DWF.lam.length, 'dwarf galaxies', 'McConnachie+12') +
    card(D.MEM.lam.length.toLocaleString(), 'dwarf member ★', 'Battaglia+22') +
    card(nq, 'Quaia quasars', 'G < 20.5') +
    `</div>`;
  wrap.appendChild(totals);

  // full-catalog distance + G histograms
  const hbox = document.createElement('div');
  hbox.className = 'halo-hists';
  const cvD = document.createElement('canvas'), cvG = document.createElement('canvas');
  hbox.append(cvD, cvG);
  wrap.appendChild(hbox);
  drawCatalogHist(cvD, D.s_dist_use, 'all stream-star distances', 'dist [kpc]', 0, 100);
  drawCatalogHist(cvG, D.s_G, 'all stream-star G magnitudes', 'Gaia G', D.GMIN, D.GMAX);

  // per-stream table (top 20 by count)
  const counts = new Map();
  for (let i = 0; i < D.N; i++) {
    const nm = D.streamName(i);
    counts.set(nm, (counts.get(nm) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const tbl = document.createElement('div');
  tbl.className = 'halo-table';
  tbl.innerHTML = `<div class="halo-sec">streams by star count <span class="tiny">(click to select + fly to it)</span></div>` +
    top.slice(0, 24).map(([nm, c]) =>
      `<span class="stream-chip${D.VIA_SET.has(nm) ? ' via' : ''}" data-nm="${nm}">${nm} <b>${c}</b></span>`).join('') +
    (top.length > 24 ? `<span class="tiny"> + ${top.length - 24} more</span>` : '');
  wrap.appendChild(tbl);
  tbl.addEventListener('click', e => {
    const nm = e.target.closest?.('.stream-chip')?.dataset?.nm;
    if (nm) window.dispatchEvent(new CustomEvent('v2-goto-stream', { detail: nm }));
  });

  // shortlist browser: the gridpoint nearest the current FOV + G limit
  const pairs = new Map();
  for (const c of D.CANDIDATES) pairs.set(`${c.fov}|${c.glim ?? 20}`, { fov: c.fov, glim: c.glim ?? 20 });
  let best = null, bd = Infinity;
  for (const p of pairs.values()) {
    const d = Math.abs(p.fov - state.fov) * 2 + Math.abs(p.glim - state.ghi);
    if (d < bd) { bd = d; best = p; }
  }
  const cands = best
    ? D.CANDIDATES.filter(c => c.fov === best.fov && (c.glim ?? 20) === best.glim)
    : [];
  const sl = document.createElement('div');
  sl.className = 'halo-shortlist';
  sl.innerHTML = `<div class="halo-sec">scan_fields shortlist <span class="tiny">(top-${cands.length}${best ? ` for ${best.fov}° fields at G ≤ ${best.glim}` : ''} · click to fly)</span></div>`;
  const list = document.createElement('div');
  for (const c of cands) {
    const row = document.createElement('div');
    row.className = 'cand-row';
    row.innerHTML =
      `<span class="cand-rank">${c.fov}° #${c.rank}</span>` +
      `<span class="cand-rungs">${c.n_rungs} rungs</span>` +
      `<span class="cand-combo">${c.combo}</span>` +
      `<span class="cand-site">${c.site}</span>` +
      `<span class="cand-nhi">logN(HI) ${c.log_nhi}</span>` +
      `<div class="cand-ladder tiny">${c.rungs.replaceAll(' | ', ' · ')}</div>`;
    row.addEventListener('click', () => {
      set({ fov: c.fov }, null);
      setField(c.lam, c.bet);
      window.dispatchEvent(new CustomEvent('v2-show-field-tab'));
    });
    list.appendChild(row);
  }
  sl.appendChild(list);
  wrap.appendChild(sl);
}

function card(big, lab, sub) {
  return `<div class="halo-card"><div class="hc-big">${big}</div><div class="hc-lab">${lab}</div><div class="hc-sub tiny">${sub}</div></div>`;
}

function drawCatalogHist(cvs, values, title, xlab, lo, hi) {
  const w = Math.max(200, (wrap.clientWidth - 30) / 2);
  const h = 140;
  const ctx = fitCanvas(cvs, w, h);
  const plot = { x: 34, y: 18, w: w - 44, h: h - 48 };
  label(ctx, title, plot.x, 12, { size: 10, color: UI.text });
  const mm = C.finiteMinMax(values);
  const a = Math.max(lo, mm[0]), b = Math.min(hi, mm[1]);
  const nb = 48;
  const hist = C.histogram(values, nb, a, b);
  const maxC = Math.max(1, C.arrMax(hist.counts));
  const colW = plot.w / nb;
  ctx.fillStyle = UI.hist;
  for (let k = 0; k < nb; k++) {
    const bh = Math.pow(hist.counts[k] / maxC, 0.5) * plot.h;   // sqrt stretch (Sgr dominates)
    ctx.fillRect(plot.x + k * colW + 0.3, plot.y + plot.h - bh, colW - 0.6, bh);
  }
  ctx.strokeStyle = UI.panelBorder;
  ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
  label(ctx, xlab + '  (√ scale)', plot.x + plot.w / 2, h - 6, { align: 'center', size: 9 });
  label(ctx, a.toFixed(0), plot.x, h - 18, { size: 8 });
  label(ctx, b.toFixed(0), plot.x + plot.w, h - 18, { align: 'right', size: 8 });
  label(ctx, maxC.toLocaleString(), plot.x - 3, plot.y + 8, { align: 'right', size: 8 });
}
