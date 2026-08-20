// Sgr-frame (Λ–B) strip map — HI background in the Sgr grid, star scatter, objects,
// draggable field circle, full-screen enlarge with whole-structure hover.
// Λ runs vertically; y-axis FLIPPED 8-19-26 so dragging up here matches the sky map.
import { D } from '../data.js';
import { state, setField, on } from '../state.js';
import { F } from '../fieldmodel.js';
import * as C from '../compute.js';
import { UI, scales, streamColor } from '../colors.js';
import { fitCanvas, hexagram, diamond, label } from './canvas2d.js';
import { makeExpandable } from './expand.js';
import { placeTooltip } from '../scene3d.js';

let cv, wrap, tipEl, expander;
let bgCache = {};
let hiStretchSgr = {};   // himap -> {v0, v1} used for the background stretch
let map = { x0: 26, y0: 8, w: 0, h: 0 };   // plot rect
let dragging = false;
let hoverObj = null;
const BMIN = -30, BMAX = 30, LMIN = -180, LMAX = 180;

export function initSgrmap(container) {
  wrap = container;
  cv = document.createElement('canvas');
  cv.className = 'sgrmap-canvas';
  container.appendChild(cv);
  tipEl = document.getElementById('tooltip2d');
  expander = makeExpandable(container, { onToggle: () => { bgCache = {}; starCache = null; hoverObj = null; draw(); } });
  on('fieldmodel', draw);
  new ResizeObserver(() => { bgCache = {}; starCache = null; draw(); }).observe(container);
  cv.addEventListener('pointerdown', (e) => { dragging = true; try { cv.setPointerCapture(e.pointerId); } catch {} moveTo(e, true); });
  cv.addEventListener('pointermove', (e) => {
    if (dragging) { moveTo(e, true); return; }
    if (expander.isExpanded()) hoverStructure(e);
  });
  cv.addEventListener('pointerup', (e) => { if (dragging) { dragging = false; moveTo(e, false); } });
  cv.addEventListener('pointerleave', () => {
    if (hoverObj) { hoverObj = null; draw(); }
    tipEl.style.display = 'none';
  });
}

// y-axis flipped: Λ = -180 at the top, +180 at the bottom
function toPx(lam, bet) {
  return [
    map.x0 + (bet - BMIN) / (BMAX - BMIN) * map.w,
    map.y0 + (lam - LMIN) / (LMAX - LMIN) * map.h,
  ];
}
function fromPx(x, y) {
  return [
    LMIN + (y - map.y0) / map.h * (LMAX - LMIN),
    BMIN + (x - map.x0) / map.w * (BMAX - BMIN),
  ];
}

function moveTo(e, live) {
  const r = cv.getBoundingClientRect();
  const [lam, bet] = fromPx(e.clientX - r.left, e.clientY - r.top);
  if (bet < BMIN - 2 || bet > BMAX + 2) return;
  setField(Math.max(-180, Math.min(180, lam)), Math.max(BMIN, Math.min(BMAX, bet)),
    live ? { live: true } : {});
}

function buildBg(w, h) {
  const key = state.himap + '|' + w + '|' + h;
  if (bgCache[key]) return bgCache[key];
  const off = document.createElement('canvas');
  const dpr = Math.min(devicePixelRatio || 1, 2);
  off.width = w * dpr; off.height = h * dpr;
  const ctx = off.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0e1420';
  ctx.fillRect(0, 0, w, h);
  const useHvc = state.himap === 'hvc';
  const overlay = state.himap === 'overlay' && D.HI_SGR_HVC;
  const layers = [[useHvc && D.HI_SGR_HVC ? D.HI_SGR_HVC : D.HI_SGR_TOTAL,
    useHvc ? scales.hiRed : scales.hiBlue, 1]];
  if (overlay) layers.push([D.HI_SGR_HVC, scales.hiRed, 0.55]);
  const [nb, nl] = D.HI_SGR_SHAPE;                  // (61 bet, 361 lam)
  for (const [grid, scale, alphaMul] of layers) {
    const fin = [];
    for (let i = 0; i < grid.length; i += 3) if (Number.isFinite(grid[i])) fin.push(grid[i]);
    fin.sort((a, b) => a - b);
    const v0 = C.quantileSorted(fin, 0.25), v1 = C.quantileSorted(fin, 0.99);
    if (!hiStretchSgr[state.himap]) hiStretchSgr[state.himap] = { v0, v1 };
    const cw = map.w / nb, ch = map.h / nl;
    ctx.globalAlpha = alphaMul * 0.75;
    for (let ib = 0; ib < nb; ib++) {
      for (let il = 0; il < nl; il++) {
        const v = grid[ib * nl + il];
        if (!Number.isFinite(v)) continue;
        const t = Math.max(0, Math.min(1, (v - v0) / (v1 - v0 || 1)));
        ctx.fillStyle = scale.css(t);
        const [X, Y] = toPx(D.HI_SGR_LAM[il], D.HI_SGR_BET[ib]);
        ctx.fillRect(X - cw / 2, Y - ch / 2, cw + 0.5, ch + 0.5);
      }
    }
    ctx.globalAlpha = 1;
  }
  // axes labels
  label(ctx, 'B [°]', map.x0 + map.w / 2, h - 2, { align: 'center', size: 9 });
  for (const bv of [-20, 0, 20]) {
    const [X] = toPx(0, bv);
    label(ctx, String(bv), X, h - 12, { align: 'center', size: 8 });
  }
  for (const lv of [-120, -60, 0, 60, 120]) {
    const [, Y] = toPx(lv, 0);
    label(ctx, String(lv), 2, Y + 3, { size: 8 });
  }
  label(ctx, 'Λ', 4, map.y0 + 10, { size: 10, color: '#93a0b6' });
  bgCache[key] = off;
  return off;
}

let starCache = null, starCacheKey = '';

function buildStarLayer(w, h) {
  const key = [w, h, state.via, state.streamsOn, state.hlStream && state.streamSel,
    state.gcOn, state.dgOn, state.viaDwarfs,
    state.hlGC && state.gcSel, state.hlDwarf && state.dwarfSel, state.himap].join('|');
  if (starCache && starCacheKey === key) return starCache;
  starCacheKey = key;
  const off = document.createElement('canvas');
  const dpr = Math.min(devicePixelRatio || 1, 2);
  off.width = w * dpr; off.height = h * dpr;
  const ctx = off.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.drawImage(buildBg(w, h), 0, 0, w, h);

  const selCode = (state.hlStream && state.streamSel) ? D.STREAM_NAMES.indexOf(state.streamSel) : -1;
  if (state.streamsOn) {
    ctx.globalAlpha = 0.6;
    for (let i = 0; i < D.N; i += 2) {
      if (state.via && !D.viaMask[i]) continue;
      const bet = D.s_bet[i];
      if (bet < BMIN || bet > BMAX) continue;
      const isSel = selCode < 0 || D.s_name_code[i] === selCode;
      const [X, Y] = toPx(D.s_lam[i], bet);
      ctx.fillStyle = isSel ? '#c8d2e2' : '#525c70';
      ctx.fillRect(X, Y, 1.5, 1.5);
    }
    if (selCode >= 0) {
      ctx.fillStyle = UI.accent;
      for (let i = 0; i < D.N; i++) {
        if (D.s_name_code[i] !== selCode) continue;
        const bet = D.s_bet[i];
        if (bet < BMIN || bet > BMAX) continue;
        const [X, Y] = toPx(D.s_lam[i], bet);
        ctx.fillRect(X, Y, 2, 2);
      }
    }
    ctx.globalAlpha = 1;
  }
  if (state.gcOn) {
    const sel = state.hlGC ? state.gcSel : null;
    for (let i = 0; i < D.GCC.lam.length; i++) {
      if (Math.abs(D.GCC.bet[i]) > 32) continue;
      const [X, Y] = toPx(D.GCC.lam[i], D.GCC.bet[i]);
      hexagram(ctx, X, Y, i === sel ? 6.5 : 3.6, i === sel ? UI.accent : UI.gc, '#00000088');
      if (i === sel) label(ctx, D.GCC.name[i], X + 8, Y + 3, { size: 8.5, color: UI.accent });
    }
  }
  if (state.dgOn) {
    const sel = state.hlDwarf ? state.dwarfSel : null;
    for (let i = 0; i < D.DWF.lam.length; i++) {
      if (Math.abs(D.DWF.bet[i]) > 32) continue;
      if (state.viaDwarfs && !(D.DWF.dist[i] < 300)) continue;
      const [X, Y] = toPx(D.DWF.lam[i], D.DWF.bet[i]);
      diamond(ctx, X, Y, i === sel ? 6.2 : 3.4, i === sel ? UI.accent : UI.dwarf, '#00000088');
      if (i === sel) label(ctx, D.DWF.name[i], X + 8, Y + 3, { size: 8.5, color: UI.accent });
    }
  }
  starCache = off;
  return off;
}

const ASPECT = 1.95;   // h/w — fixed, so the enlarged view keeps the strip's shape

function draw() {
  const availW = wrap.clientWidth;
  if (!availW) return;
  const availH = Math.max(320, window.innerHeight - 60);
  let w = Math.round(availW * 0.8);
  let h = Math.round(w * ASPECT);
  if (h > availH) { h = availH; w = Math.round(h / ASPECT); }
  const ctx = fitCanvas(cv, w, h);
  map.w = w - map.x0 - 40;      // right margin reserved for the vertical HI colorbar
  map.h = h - map.y0 - 20;
  ctx.drawImage(buildStarLayer(w, h), 0, 0, w, h);
  drawHiBarV(ctx, w, h);

  if (state.cloudsOn && D.CLOUDS) {
    const cl = D.CLOUDS;
    ctx.strokeStyle = '#6fd8e8';
    ctx.globalAlpha = 0.75;
    for (const i of (F.clouds ?? [])) {
      if (Math.abs(cl.bet[i]) > 32) continue;
      const [X, Y] = toPx(cl.lam[i], cl.bet[i]);
      const r = Math.max(1.6, cl.radDeg[i] / 60 * map.w);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(X, Y, r, 0, 2 * Math.PI);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  drawHoverStructure(ctx);

  // field circle (ellipse in this projection: Δlam stretched by 1/cos(bet)) — outline only
  const cosb = Math.max(Math.cos(state.bet0 * Math.PI / 180), 0.1);
  const rr = state.fov / 2 * 0.95;
  const [FX, FY] = toPx(state.lam0, state.bet0);
  const rx = rr / (BMAX - BMIN) * map.w;
  const ry = (rr / cosb) / (LMAX - LMIN) * map.h;
  ctx.strokeStyle = UI.accent;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.ellipse(FX, FY, Math.max(rx, 3), Math.max(ry, 3), 0, 0, 2 * Math.PI);
  ctx.stroke();
  cv.style.cursor = 'crosshair';
}

// vertical HI colorbar along the right edge of the strip
function drawHiBarV(ctx, w, h) {
  const st = hiStretchSgr[state.himap];
  if (!st) return;
  const useHvc = state.himap === 'hvc';
  const scale = useHvc ? scales.hiRed : scales.hiBlue;
  const bw = 9, bx = w - 24;
  const by = map.y0 + 16, bh = map.h - 32;
  for (let k = 0; k < bh; k++) {
    ctx.fillStyle = scale.css(1 - k / (bh - 1));    // top = max
    ctx.fillRect(bx, by + k, bw, 1.2);
  }
  label(ctx, st.v1.toFixed(1), bx + bw / 2, by - 5, { align: 'center', size: 8 });
  label(ctx, st.v0.toFixed(1), bx + bw / 2, by + bh + 10, { align: 'center', size: 8 });
  ctx.save();
  ctx.translate(w - 4, by + bh / 2);
  ctx.rotate(-Math.PI / 2);
  label(ctx, useHvc ? 'HVC log N(HI)' : 'log N(HI)', 0, 0, { align: 'center', size: 8 });
  ctx.restore();
}

// ---- whole-structure hover (enlarged view only) --------------------------------------
function hoverStructure(e) {
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  let best = null, bd = 12;
  if (state.gcOn) {
    for (let i = 0; i < D.GCC.lam.length; i++) {
      if (Math.abs(D.GCC.bet[i]) > 32) continue;
      const [X, Y] = toPx(D.GCC.lam[i], D.GCC.bet[i]);
      const d = Math.hypot(X - x, Y - y);
      if (d < bd) { bd = d; best = { type: 'gc', id: i }; }
    }
  }
  if (state.dgOn) {
    for (let i = 0; i < D.DWF.lam.length; i++) {
      if (Math.abs(D.DWF.bet[i]) > 32) continue;
      const [X, Y] = toPx(D.DWF.lam[i], D.DWF.bet[i]);
      const d = Math.hypot(X - x, Y - y);
      if (d < bd) { bd = d; best = { type: 'dwarf', id: i }; }
    }
  }
  if (!best && state.streamsOn) {
    let sd = 9;
    for (let i = 0; i < D.N; i += 2) {
      if (state.via && !D.viaMask[i]) continue;
      if (D.s_bet[i] < BMIN || D.s_bet[i] > BMAX) continue;
      const [X, Y] = toPx(D.s_lam[i], D.s_bet[i]);
      const d = Math.hypot(X - x, Y - y);
      if (d < sd) { sd = d; best = { type: 'stream', id: D.s_name_code[i] }; }
    }
  }
  const same = (a, b) => a?.type === b?.type && a?.id === b?.id;
  if (!same(best, hoverObj)) {
    hoverObj = best;
    draw();
    if (best) {
      tipEl.innerHTML = best.type === 'stream'
        ? `<b>${D.STREAM_NAMES[best.id]}</b> · stream`
        : best.type === 'gc'
          ? `<b>${D.GCC.name[best.id]}</b> · GC<br>${D.GCC.dist[best.id].toFixed(1)} kpc`
          : `<b>${D.DWF.name[best.id]}</b> · dwarf<br>${D.DWF.dist[best.id].toFixed(1)} kpc`;
      tipEl.style.display = 'block';
      placeTooltip(tipEl, e);
    } else tipEl.style.display = 'none';
  } else if (best) placeTooltip(tipEl, e);
  cv.style.cursor = best ? 'pointer' : 'crosshair';
}

function drawHoverStructure(ctx) {
  if (!hoverObj) return;
  if (hoverObj.type === 'stream') {
    ctx.fillStyle = streamColor(hoverObj.id);
    let lx = null, ly = null;
    for (let i = 0; i < D.N; i++) {
      if (D.s_name_code[i] !== hoverObj.id) continue;
      if (D.s_bet[i] < BMIN || D.s_bet[i] > BMAX) continue;
      const [X, Y] = toPx(D.s_lam[i], D.s_bet[i]);
      ctx.fillRect(X - 1, Y - 1, 2.6, 2.6);
      lx = X; ly = Y;
    }
    if (lx !== null) label(ctx, D.STREAM_NAMES[hoverObj.id], lx + 8, ly, { size: 10, color: streamColor(hoverObj.id) });
  } else {
    const cat = hoverObj.type === 'gc' ? D.GCC : D.DWF;
    if (Math.abs(cat.bet[hoverObj.id]) > 32) return;
    const [X, Y] = toPx(cat.lam[hoverObj.id], cat.bet[hoverObj.id]);
    (hoverObj.type === 'gc' ? hexagram : diamond)(ctx, X, Y, 7, UI.accent, '#000');
    label(ctx, cat.name[hoverObj.id], X + 9, Y + 3, { size: 10, color: UI.accent });
  }
}
