// All-sky Mollweide (Galactic) — HI background (offscreen-cached), star scatter,
// object markers, survey-cone circles (dblclick to open that field), selected-object
// highlighting, LMC/SMC disks, a draggable field circle, and full-screen enlarge
// (with whole-structure hover when enlarged).
import { D } from '../data.js';
import { state, setField, on } from '../state.js';
import { F } from '../fieldmodel.js';
import * as C from '../compute.js';
import { UI, scales, streamColor } from '../colors.js';
import { fitCanvas, hexagram, diamond, dot, label } from './canvas2d.js';
import { makeExpandable } from './expand.js';
import { placeTooltip } from '../scene3d.js';

let cv, wrap, tipEl, expander;
let bgCache = {};        // himap key -> offscreen canvas (HI + stars + equator)
let map = { w: 0, h: 0, sx: 1, sy: 1, cx: 0, cy: 0 };
let dragging = false;
let hoverObj = null;     // {type:'stream'|'gc'|'dwarf', id} while enlarged

const MX = 2 * C.SQ2 * 1.02, MY = C.SQ2 * 1.05;
const MAGELLANIC = [{ name: 'LMC', rDeg: 5.4 }, { name: 'SMC', rDeg: 2.6 }];

export function initAllsky(container) {
  wrap = container;
  cv = document.createElement('canvas');
  cv.className = 'allsky-canvas';
  container.appendChild(cv);
  tipEl = document.getElementById('tooltip2d');
  expander = makeExpandable(container, { onToggle: () => { bgCache = {}; starCache = null; hoverObj = null; draw(); } });
  on('fieldmodel', draw);
  new ResizeObserver(() => { bgCache = {}; starCache = null; draw(); }).observe(container);
  cv.addEventListener('pointerdown', (e) => {
    dragging = true;
    try { cv.setPointerCapture(e.pointerId); } catch {}
    moveTo(e, true);
  });
  cv.addEventListener('pointermove', (e) => {
    if (dragging) { moveTo(e, true); return; }
    if (expander.isExpanded()) hoverStructure(e);
  });
  cv.addEventListener('pointerup', (e) => {
    if (dragging) { dragging = false; moveTo(e, false); }
  });
  cv.addEventListener('pointerleave', () => {
    if (hoverObj) { hoverObj = null; draw(); }
    tipEl.style.display = 'none';
  });
  cv.addEventListener('dblclick', (e) => {
    const lb = eventLB(e);
    if (!lb) return;
    for (const cone of D.CONES) {
      if (!state[cone.key]) continue;
      if (C.angSepAm(lb[0], lb[1], cone.l, cone.b) / 60 <= cone.r) {
        window.dispatchEvent(new CustomEvent('v2-goto-cone', { detail: cone.key }));
        return;
      }
    }
  });
}

function toPx(mx, my) { return [map.cx + mx * map.sx, map.cy - my * map.sy]; }
function fromPx(x, y) { return [(x - map.cx) / map.sx, -(y - map.cy) / map.sy]; }

function eventLB(e) {
  const r = cv.getBoundingClientRect();
  const [mx, my] = fromPx(e.clientX - r.left, e.clientY - r.top);
  return C.mollInvert(mx, my);
}

function moveTo(e, live) {
  const lb = eventLB(e);
  if (!lb) return;
  const [lam, bet] = C.convPoint(D.M_GAL, D.M_SGR, lb[0], lb[1]);
  setField(lam, bet, live ? { live: true } : {});
}

function buildBg(w, h) {
  const key = state.himap + '|' + w + '|' + h;
  if (bgCache[key]) return bgCache[key];
  const off = document.createElement('canvas');
  const dpr = Math.min(devicePixelRatio || 1, 2);
  off.width = w * dpr; off.height = h * dpr;
  const ctx = off.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = UI.bg;
  ctx.fillRect(0, 0, w, h);

  const useHvc = state.himap === 'hvc';
  const overlay = state.himap === 'overlay' && D.HI_LOG_HVC;
  const layers = [[useHvc && D.HI_LOG_HVC ? D.HI_LOG_HVC : D.HI_LOG_TOTAL,
    useHvc ? scales.hiRed : scales.hiBlue, 1]];
  if (overlay) layers.push([D.HI_LOG_HVC, scales.hiRed, 0.55]);

  // rasterize Mollweide by inverse mapping each pixel block
  const img = ctx.getImageData(0, 0, off.width, off.height);
  for (const [grid, scale, alphaMul] of layers) {
    const samp = [];
    for (let i = 0; i < grid.length; i += 11) if (Number.isFinite(grid[i])) samp.push(grid[i]);
    samp.sort((a, b) => a - b);
    const v0 = C.quantileSorted(samp, 0.05), v1 = C.quantileSorted(samp, 0.99);
    for (let y = 0; y < off.height; y++) {
      const my = -((y + 0.5) / dpr - map.cy) / map.sy;
      for (let x = 0; x < off.width; x++) {
        const mx = ((x + 0.5) / dpr - map.cx) / map.sx;
        const lb = C.mollInvert(mx, my);
        if (!lb) continue;
        const v = C.hiSample(grid, D.HI_NY, D.HI_NX, D.HI_STEP, lb[0], lb[1]);
        if (!Number.isFinite(v)) continue;
        const t = Math.max(0, Math.min(1, (v - v0) / (v1 - v0 || 1)));
        const [r, g, b] = scale.rgb(t);
        const p = 4 * (y * off.width + x);
        const a = alphaMul;
        img.data[p] = Math.round(img.data[p] * (1 - a) + r * a);
        img.data[p + 1] = Math.round(img.data[p + 1] * (1 - a) + g * a);
        img.data[p + 2] = Math.round(img.data[p + 2] * (1 - a) + b * a);
        img.data[p + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);

  // celestial equator (grey dots)
  ctx.fillStyle = '#5a6376';
  for (let i = 0; i < D.s_eq_l.length; i++) {
    const [mx, my] = C.mollXY(D.s_eq_l[i], D.s_eq_b[i]);
    const [X, Y] = toPx(mx, my);
    ctx.fillRect(X, Y, 1.2, 1.2);
  }
  // longitude labels along equator
  for (let lv = -150; lv <= 150; lv += 30) {
    const [mx, my] = C.mollXY(lv, 0);
    const [X, Y] = toPx(mx, my);
    label(ctx, String(lv), X, Y - 3, { size: 8, color: '#93a0b6', align: 'center' });
  }
  bgCache[key] = off;
  return off;
}

let starCache = null, starCacheKey = '';

function buildStarLayer(w, h) {
  const key = [w, h, state.via, state.streamsOn, state.hlStream && state.streamSel,
    state.memOn, state.gcOn, state.dgOn, state.viaDwarfs,
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
    ctx.globalAlpha = 0.55;
    for (let i = 0; i < D.N; i += 3) {
      if (state.via && !D.viaMask[i]) continue;
      const isSel = selCode < 0 || D.s_name_code[i] === selCode;
      const [mx, my] = C.mollXY(D.s_l[i], D.s_b[i]);
      const [X, Y] = toPx(mx, my);
      ctx.fillStyle = isSel ? '#c8d2e2' : '#525c70';
      ctx.fillRect(X, Y, isSel ? 1.6 : 1.2, isSel ? 1.6 : 1.2);
    }
    // the selected stream drawn on top in the field accent color
    if (selCode >= 0) {
      ctx.fillStyle = UI.accent;
      for (let i = 0; i < D.N; i++) {
        if (D.s_name_code[i] !== selCode) continue;
        const [mx, my] = C.mollXY(D.s_l[i], D.s_b[i]);
        const [X, Y] = toPx(mx, my);
        ctx.fillRect(X, Y, 2, 2);
      }
      ctx.globalAlpha = 1;
    }
    ctx.globalAlpha = 1;
  }
  if (state.dgOn && state.memOn) {
    // LMC / SMC rough on-sky disks in place of members
    for (const mc of MAGELLANIC) {
      const i = D.DWF.name.indexOf(mc.name);
      if (i < 0) continue;
      const [mx, my] = C.mollXY(D.DWF.l[i], D.DWF.b[i]);
      const [X, Y] = toPx(mx, my);
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = UI.dwarf;
      ctx.beginPath();
      ctx.arc(X, Y, Math.max(3, mc.rDeg * map.sx * 0.049), 0, 2 * Math.PI);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = UI.member;
    ctx.globalAlpha = 0.7;
    for (let i = 0; i < D.MEM.lam.length; i += 2) {
      if (state.viaDwarfs && !(D.MEM.dist[i] < 300)) continue;
      const [mx, my] = C.mollXY(D.MEM.l[i], D.MEM.b[i]);
      const [X, Y] = toPx(mx, my);
      ctx.fillRect(X, Y, 1.6, 1.6);
    }
    ctx.globalAlpha = 1;
  }
  if (state.gcOn) {
    const sel = state.hlGC ? state.gcSel : null;
    for (let i = 0; i < D.GCC.lam.length; i++) {
      const [mx, my] = C.mollXY(D.GCC.l[i], D.GCC.b[i]);
      const [X, Y] = toPx(mx, my);
      hexagram(ctx, X, Y, i === sel ? 6 : 3.4, i === sel ? UI.accent : UI.gc, '#00000088');
      if (i === sel) label(ctx, D.GCC.name[i], X + 7, Y + 3, { size: 8.5, color: UI.accent });
    }
  }
  if (state.dgOn) {
    const sel = state.hlDwarf ? state.dwarfSel : null;
    for (let i = 0; i < D.DWF.lam.length; i++) {
      if (state.viaDwarfs && !(D.DWF.dist[i] < 300)) continue;
      const [mx, my] = C.mollXY(D.DWF.l[i], D.DWF.b[i]);
      const [X, Y] = toPx(mx, my);
      diamond(ctx, X, Y, i === sel ? 6 : 3.2, i === sel ? UI.accent : UI.dwarf, '#00000088');
      if (i === sel) label(ctx, D.DWF.name[i], X + 7, Y + 3, { size: 8.5, color: UI.accent });
    }
  }
  starCache = off;
  return off;
}

function draw() {
  const w = wrap.clientWidth;
  if (!w) return;
  const h = Math.min(Math.round(w * 0.52), Math.max(240, window.innerHeight - 90));
  const ctx = fitCanvas(cv, w, h);
  map.cx = w / 2; map.cy = h / 2;
  const s = Math.min((w / 2 - 4) / MX, (h / 2 - 4) / MY);
  map.sx = s; map.sy = s;

  ctx.fillStyle = UI.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(buildStarLayer(w, h), 0, 0, w, h);

  if (state.cloudsOn && D.CLOUDS) {
    const cl = D.CLOUDS;
    ctx.strokeStyle = UI.cloud;
    ctx.globalAlpha = 0.75;
    for (const i of (F.clouds ?? [])) {
      const [mx, my] = C.mollXY(cl.l[i], cl.b[i]);
      const [X, Y] = toPx(mx, my);
      const r = Math.max(1.4, cl.radDeg[i] * map.sx * 0.049);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(X, Y, r, 0, 2 * Math.PI);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  for (const cone of D.CONES) {
    if (!state[cone.key]) continue;
    drawSkyCircle(ctx, cone.l, cone.b, cone.r, cone.color, 1.2);
    const [cmx, cmy] = C.mollXY(cone.l, cone.b);
    const [CX, CY] = toPx(cmx, cmy);
    label(ctx, cone.name, CX, CY - cone.r * map.sy * 0.045 - 4,
      { align: 'center', size: 8, color: cone.color });
  }
  drawHoverStructure(ctx);
  // field circle (no center pip — the outline is the field)
  drawSkyCircle(ctx, F.l0, F.b0, Math.max(state.fov / 2, 1.2), UI.accent, 1.8);
  if (!expander.isExpanded()) {
    label(ctx, 'click or drag to move field', 8, 15, { size: 9.5 });
    label(ctx, 'or expand to explore', 8, 27, { size: 9.5 });
  }
  cv.style.cursor = 'crosshair';
}

// ---- whole-structure hover (enlarged view only) --------------------------------------
function hoverStructure(e) {
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  let best = null, bd = 12;
  // GCs / dwarfs first (small catalogs, exact)
  if (state.gcOn) {
    for (let i = 0; i < D.GCC.lam.length; i++) {
      const [mx, my] = C.mollXY(D.GCC.l[i], D.GCC.b[i]);
      const [X, Y] = toPx(mx, my);
      const d = Math.hypot(X - x, Y - y);
      if (d < bd) { bd = d; best = { type: 'gc', id: i }; }
    }
  }
  if (state.dgOn) {
    for (let i = 0; i < D.DWF.lam.length; i++) {
      const [mx, my] = C.mollXY(D.DWF.l[i], D.DWF.b[i]);
      const [X, Y] = toPx(mx, my);
      const d = Math.hypot(X - x, Y - y);
      if (d < bd) { bd = d; best = { type: 'dwarf', id: i }; }
    }
  }
  if (!best && state.streamsOn) {
    let sd = 9;
    for (let i = 0; i < D.N; i += 2) {
      if (state.via && !D.viaMask[i]) continue;
      const [mx, my] = C.mollXY(D.s_l[i], D.s_b[i]);
      const [X, Y] = toPx(mx, my);
      const d = Math.hypot(X - x, Y - y);
      if (d < sd) { sd = d; best = { type: 'stream', id: D.s_name_code[i] }; }
    }
  }
  const same = (a, b) => a?.type === b?.type && a?.id === b?.id;
  if (!same(best, hoverObj)) {
    hoverObj = best;
    draw();
    if (best) {
      tipEl.innerHTML = hoverHtml(best);
      tipEl.style.display = 'block';
      placeTooltip(tipEl, e);
    } else tipEl.style.display = 'none';
  } else if (best) placeTooltip(tipEl, e);
  cv.style.cursor = best ? 'pointer' : 'crosshair';
}

function hoverHtml(o) {
  if (o.type === 'gc') return `<b>${D.GCC.name[o.id]}</b> · GC<br>${D.GCC.dist[o.id].toFixed(1)} kpc`;
  if (o.type === 'dwarf') return `<b>${D.DWF.name[o.id]}</b> · dwarf<br>${D.DWF.dist[o.id].toFixed(1)} kpc`;
  return `<b>${D.STREAM_NAMES[o.id]}</b> · stream`;
}

function drawHoverStructure(ctx) {
  if (!hoverObj) return;
  if (hoverObj.type === 'stream') {
    ctx.fillStyle = streamColor(hoverObj.id);
    let lx = null, ly = null;
    for (let i = 0; i < D.N; i++) {
      if (D.s_name_code[i] !== hoverObj.id) continue;
      const [mx, my] = C.mollXY(D.s_l[i], D.s_b[i]);
      const [X, Y] = toPx(mx, my);
      ctx.fillRect(X - 1, Y - 1, 2.6, 2.6);
      lx = X; ly = Y;
    }
    if (lx !== null) label(ctx, D.STREAM_NAMES[hoverObj.id], lx + 8, ly, { size: 10, color: streamColor(hoverObj.id) });
  } else {
    const cat = hoverObj.type === 'gc' ? D.GCC : D.DWF;
    const [mx, my] = C.mollXY(cat.l[hoverObj.id], cat.b[hoverObj.id]);
    const [X, Y] = toPx(mx, my);
    (hoverObj.type === 'gc' ? hexagram : diamond)(ctx, X, Y, 7, UI.accent, '#000');
    label(ctx, cat.name[hoverObj.id], X + 9, Y + 3, { size: 10, color: UI.accent });
  }
}

function drawSkyCircle(ctx, l0, b0, radDeg, color, lw) {
  const [lArr, bArr] = C.skyCircleLB(l0, b0, radDeg, 140);
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.beginPath();
  let pen = false, lastX = null;
  for (let i = 0; i < lArr.length; i++) {
    const [mx, my] = C.mollXY(lArr[i], bArr[i]);
    const [X, Y] = toPx(mx, my);
    if (pen && lastX !== null && Math.abs(X - lastX) > 40) pen = false;   // seam break
    if (pen) ctx.lineTo(X, Y); else { ctx.moveTo(X, Y); pen = true; }
    lastX = X;
  }
  ctx.stroke();
}
