// All-sky Mollweide (Galactic) — HI background (offscreen-cached), star scatter,
// object markers, Kepler circle, and a field circle you can DRAG (or click anywhere).
import { D } from '../data.js';
import { state, setField, on } from '../state.js';
import { F } from '../fieldmodel.js';
import { activeClouds } from '../fieldmodel.js';
import * as C from '../compute.js';
import { UI, scales } from '../colors.js';
import { fitCanvas, hexagram, diamond, dot, label } from './canvas2d.js';

let cv, wrap;
let bgCache = {};        // himap key -> offscreen canvas (HI + stars + equator)
let map = { w: 0, h: 0, sx: 1, sy: 1, cx: 0, cy: 0 };
let dragging = false;

const MX = 2 * C.SQ2 * 1.02, MY = C.SQ2 * 1.05;

export function initAllsky(container) {
  wrap = container;
  cv = document.createElement('canvas');
  cv.className = 'allsky-canvas';
  container.appendChild(cv);
  on('fieldmodel', draw);
  new ResizeObserver(() => { bgCache = {}; starCache = null; draw(); }).observe(container);
  cv.addEventListener('pointerdown', (e) => {
    dragging = true;
    cv.setPointerCapture(e.pointerId);
    moveTo(e, true);
  });
  cv.addEventListener('pointermove', (e) => { if (dragging) moveTo(e, true); });
  cv.addEventListener('pointerup', (e) => {
    if (dragging) { dragging = false; moveTo(e, false); }
  });
}

function toPx(mx, my) { return [map.cx + mx * map.sx, map.cy - my * map.sy]; }
function fromPx(x, y) { return [(x - map.cx) / map.sx, -(y - map.cy) / map.sy]; }

function moveTo(e, live) {
  const r = cv.getBoundingClientRect();
  const [mx, my] = fromPx(e.clientX - r.left, e.clientY - r.top);
  const lb = C.mollInvert(mx, my);
  if (!lb) return;
  const [lam, bet] = C.convPoint(D.M_GAL, D.M_SGR, lb[0], lb[1]);
  setField(lam, bet, live ? { live: true } : {});
}

function buildBg(w, h) {
  const key = state.himap + '|' + w;
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
      const my = -( (y + 0.5) / dpr - map.cy ) / map.sy;
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
  const key = [w, state.via, state.isolate, state.stream, state.memOn, state.gcOn, state.dgOn,
    state.himap].join('|');
  if (starCache && starCacheKey === key) return starCache;
  starCacheKey = key;
  const off = document.createElement('canvas');
  const dpr = Math.min(devicePixelRatio || 1, 2);
  off.width = w * dpr; off.height = h * dpr;
  const ctx = off.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.drawImage(buildBg(w, h), 0, 0, w, h);

  const selCode = state.stream ? D.STREAM_NAMES.indexOf(state.stream) : -1;
  ctx.globalAlpha = 0.55;
  for (let i = 0; i < D.N; i += 3) {
    if (state.via && !D.viaMask[i]) continue;
    if (state.isolate && selCode >= 0 && D.s_name_code[i] !== selCode) continue;
    const isSel = selCode < 0 || D.s_name_code[i] === selCode;
    const [mx, my] = C.mollXY(D.s_l[i], D.s_b[i]);
    const [X, Y] = toPx(mx, my);
    ctx.fillStyle = isSel ? '#c8d2e2' : '#525c70';
    ctx.fillRect(X, Y, isSel ? 1.6 : 1.2, isSel ? 1.6 : 1.2);
  }
  ctx.globalAlpha = 1;
  if (state.memOn) {
    ctx.fillStyle = UI.member;
    ctx.globalAlpha = 0.7;
    for (let i = 0; i < D.MEM.lam.length; i += 2) {
      const [mx, my] = C.mollXY(D.MEM.l[i], D.MEM.b[i]);
      const [X, Y] = toPx(mx, my);
      ctx.fillRect(X, Y, 1.6, 1.6);
    }
    ctx.globalAlpha = 1;
  }
  if (state.gcOn) {
    for (let i = 0; i < D.GCC.lam.length; i++) {
      const [mx, my] = C.mollXY(D.GCC.l[i], D.GCC.b[i]);
      const [X, Y] = toPx(mx, my);
      hexagram(ctx, X, Y, 3.4, UI.gc, '#00000088');
    }
  }
  if (state.dgOn) {
    for (let i = 0; i < D.DWF.lam.length; i++) {
      const [mx, my] = C.mollXY(D.DWF.l[i], D.DWF.b[i]);
      const [X, Y] = toPx(mx, my);
      diamond(ctx, X, Y, 3.2, UI.dwarf, '#00000088');
    }
  }
  starCache = off;
  return off;
}

function draw() {
  const w = wrap.clientWidth;
  if (!w) return;
  const h = Math.round(w * 0.52);
  const ctx = fitCanvas(cv, w, h);
  map.cx = w / 2; map.cy = h / 2;
  map.sx = (w / 2 - 4) / MX; map.sy = (h / 2 - 4) / MY;

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
  if (state.kepler) {
    for (const cone of D.CONES) {
      drawSkyCircle(ctx, cone.l, cone.b, cone.r, cone.color, 1.2);
      const [cmx, cmy] = C.mollXY(cone.l, cone.b);
      const [CX, CY] = toPx(cmx, cmy);
      label(ctx, cone.name, CX, CY - cone.r * map.sy * 0.045 - 4,
        { align: 'center', size: 8, color: cone.color });
    }
  }
  drawSkyCircle(ctx, F.l0, F.b0, Math.max(state.fov / 2, 1.2), UI.accent, 1.8);
  // center pip so a 1-degree field is always visible
  const [fmx, fmy] = C.mollXY(F.l0, F.b0);
  const [FX, FY] = toPx(fmx, fmy);
  dot(ctx, FX, FY, 2.2, UI.accent, 0.9);
  cv.style.cursor = 'crosshair';
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
