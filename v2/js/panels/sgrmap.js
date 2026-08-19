// Sgr-frame (Λ–B) strip map — HI background in the Sgr grid, star scatter, objects,
// draggable field circle. Λ runs vertically (180 -> -180 top to bottom), B horizontal.
import { D } from '../data.js';
import { state, setField, on } from '../state.js';
import { F } from '../fieldmodel.js';
import * as C from '../compute.js';
import { UI, scales } from '../colors.js';
import { fitCanvas, hexagram, diamond, label } from './canvas2d.js';

let cv, wrap;
let bgCache = {};
let map = { x0: 26, y0: 8, w: 0, h: 0 };   // plot rect
let dragging = false;
const BMIN = -30, BMAX = 30, LMIN = -180, LMAX = 180;

export function initSgrmap(container) {
  wrap = container;
  cv = document.createElement('canvas');
  cv.className = 'sgrmap-canvas';
  container.appendChild(cv);
  on('fieldmodel', draw);
  new ResizeObserver(() => { bgCache = {}; starCache = null; draw(); }).observe(container);
  cv.addEventListener('pointerdown', (e) => { dragging = true; cv.setPointerCapture(e.pointerId); moveTo(e, true); });
  cv.addEventListener('pointermove', (e) => { if (dragging) moveTo(e, true); });
  cv.addEventListener('pointerup', (e) => { if (dragging) { dragging = false; moveTo(e, false); } });
}

function toPx(lam, bet) {
  return [
    map.x0 + (bet - BMIN) / (BMAX - BMIN) * map.w,
    map.y0 + (LMAX - lam) / (LMAX - LMIN) * map.h,
  ];
}
function fromPx(x, y) {
  return [
    LMAX - (y - map.y0) / map.h * (LMAX - LMIN),
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
  const key = [w, h, state.via, state.isolate, state.stream, state.gcOn, state.dgOn,
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
  ctx.globalAlpha = 0.6;
  for (let i = 0; i < D.N; i += 2) {
    if (state.via && !D.viaMask[i]) continue;
    if (state.isolate && selCode >= 0 && D.s_name_code[i] !== selCode) continue;
    const bet = D.s_bet[i];
    if (bet < BMIN || bet > BMAX) continue;
    const isSel = selCode < 0 || D.s_name_code[i] === selCode;
    const [X, Y] = toPx(D.s_lam[i], bet);
    ctx.fillStyle = isSel ? '#c8d2e2' : '#525c70';
    ctx.fillRect(X, Y, 1.5, 1.5);
  }
  ctx.globalAlpha = 1;
  if (state.gcOn) {
    for (let i = 0; i < D.GCC.lam.length; i++) {
      if (Math.abs(D.GCC.bet[i]) > 32) continue;
      const [X, Y] = toPx(D.GCC.lam[i], D.GCC.bet[i]);
      hexagram(ctx, X, Y, 3.6, UI.gc, '#00000088');
    }
  }
  if (state.dgOn) {
    for (let i = 0; i < D.DWF.lam.length; i++) {
      if (Math.abs(D.DWF.bet[i]) > 32) continue;
      const [X, Y] = toPx(D.DWF.lam[i], D.DWF.bet[i]);
      diamond(ctx, X, Y, 3.4, UI.dwarf, '#00000088');
    }
  }
  starCache = off;
  return off;
}

function draw() {
  const w = wrap.clientWidth;
  if (!w) return;
  const h = Math.round(Math.min(520, Math.max(380, w * 1.35)));
  const ctx = fitCanvas(cv, w, h);
  map.w = w - map.x0 - 6;
  map.h = h - map.y0 - 20;
  ctx.drawImage(buildStarLayer(w, h), 0, 0, w, h);

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

  // field circle (ellipse in this projection: Δlam stretched by 1/cos(bet))
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
