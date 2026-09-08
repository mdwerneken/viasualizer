// All-sky Mollweide (Galactic) — gas/dust background (offscreen-cached), star scatter,
// object markers, Via planned pointings + other field lists, HVC clouds, literature
// sightlines, survey-cone circles (dblclick to open that field), selected-object
// highlighting, a draggable field circle, and full-screen enlarge: structure hover, scroll
// wheel zoom about the cursor (right-drag or ⇧-drag pans the zoomed view), the field view
// docked top-left, Map layers bottom-left and the legend under the colorbar bottom-right.
import { D, bgGridFor, gridSample, gridStretch } from '../data.js';
import { state, setField, on } from '../state.js';
import { F } from '../fieldmodel.js';
import * as C from '../compute.js';
import { UI, scales, streamColor, SVY_COL, SVY_SHORT, bgScale, bgLabel } from '../colors.js';
import { fitCanvas, hexagram, diamond, dot, label, circleOutline } from './canvas2d.js';
import { makeExpandable } from './expand.js';
import { placeTooltip } from '../scene3d.js';
import { cloudColor } from './finder.js';
import { LIST, sourceById } from '../lists.js';
import { dockSkyPanels } from './skylayers.js';

let cv, wrap, tipEl, expander;
let bgCache = {};
let hiStretchSky = {};
let map = { w: 0, h: 0, sx: 1, sy: 1, cx: 0, cy: 0 };
let dragging = false, panning = null;
let hoverObj = null;
let zoom = 1, zx = 0, zy = 0;          // full-screen view zoom (about the cursor) + pan offset [css px]

const MX = 2 * C.SQ2 * 1.02, MY = C.SQ2 * 1.05;

export function initAllsky(container) {
  wrap = container;
  cv = document.createElement('canvas');
  cv.className = 'allsky-canvas';
  container.appendChild(cv);
  tipEl = document.getElementById('tooltip2d');
  const reset = (open) => {
    bgCache = {}; starCache = null; hoverObj = null; zoom = 1; zx = zy = 0;
    if (open !== undefined) dockSkyPanels(wrap, open);
    draw();
  };
  expander = makeExpandable(container, { onToggle: reset, hint: 'click or drag to move the field · scroll to zoom, right-drag / ⇧-drag to pan · hover structures and pointings · double-click a survey circle or Via pointing to open it · Esc closes' });
  on('fieldmodel', draw);
  on('theme', () => { bgCache = {}; starCache = null; hiStretchSky = {}; draw(); });
  new ResizeObserver(() => { bgCache = {}; starCache = null; draw(); }).observe(container);
  cv.addEventListener('pointerdown', (e) => {
    if ((e.button === 2 || (e.button === 0 && e.shiftKey)) && zoom > 1) {
      panning = { x: e.clientX, y: e.clientY, zx, zy };
      try { cv.setPointerCapture(e.pointerId); } catch {}
      return;
    }
    if (e.button !== 0) return;
    dragging = true;
    try { cv.setPointerCapture(e.pointerId); } catch {}
    moveTo(e, true);
  });
  cv.addEventListener('contextmenu', e => { if (zoom > 1) e.preventDefault(); });
  cv.addEventListener('pointermove', (e) => {
    if (panning) { zx = panning.zx + (e.clientX - panning.x); zy = panning.zy + (e.clientY - panning.y); starCache = null; draw(); return; }
    if (dragging) { moveTo(e, true); return; }
    if (expander.isExpanded()) hoverStructure(e);
  });
  cv.addEventListener('pointerup', (e) => {
    if (panning) { panning = null; return; }
    if (dragging) { dragging = false; moveTo(e, false); }
  });
  // full-screen: scroll wheel zooms about the cursor (1× … 12×)
  cv.addEventListener('wheel', (e) => {
    if (!expander.isExpanded()) return;
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const z1 = Math.min(12, Math.max(1, zoom * Math.exp(-e.deltaY * 0.0025)));
    if (z1 === zoom) return;
    const mx = (x - map.cx - zx) / (map.sx * zoom), my = -(y - map.cy - zy) / (map.sy * zoom);
    zoom = z1;
    if (zoom <= 1.001) { zoom = 1; zx = 0; zy = 0; }
    else { zx = x - map.cx - mx * map.sx * zoom; zy = y - map.cy + my * map.sy * zoom; }
    starCache = null;
    tipEl.style.display = 'none';
    draw();
  }, { passive: false });
  cv.addEventListener('pointerleave', () => {
    if (hoverObj) { hoverObj = null; draw(); }
    tipEl.style.display = 'none';
  });
  cv.addEventListener('dblclick', (e) => {
    const lb = eventLB(e);
    if (!lb) return;
    // a Via pointing under the cursor?
    if (D.VIA && state.viaOn) {
      const r = cv.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      let best = -1, bd = 7;
      for (let i = 0; i < D.VIA.svy.length; i++) {
        if (!state.viaSvy[D.VIA.svy[i]]) continue;
        const [mx, my] = C.mollXY(D.VIA.l[i], D.VIA.b[i]);
        const [X, Y] = toPx(mx, my);
        const d = Math.hypot(X - x, Y - y);
        if (d < bd) { bd = d; best = i; }
      }
      if (best >= 0) { window.dispatchEvent(new CustomEvent('v3-goto-via', { detail: best })); return; }
    }
    for (const cone of D.CONES) {
      if (!state[cone.key]) continue;
      if (C.angSepAm(lb[0], lb[1], cone.l, cone.b) / 60 <= cone.r) {
        window.dispatchEvent(new CustomEvent('v2-goto-cone', { detail: cone.key }));
        return;
      }
    }
  });
}

function toPx(mx, my) { return [map.cx + mx * map.sx * zoom + zx, map.cy - my * map.sy * zoom + zy]; }
function fromPx(x, y) { return [(x - map.cx - zx) / (map.sx * zoom), -(y - map.cy - zy) / (map.sy * zoom)]; }

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

function bgGrids() {
  const bg = bgGridFor(state.himap);
  const layers = [[bg.gal, bgScale(), 1, bg.sym]];
  if (bg.overlay) layers.push([bg.overlay, scales.hiRed, 0.55, false]);
  return layers;
}

function buildBg(w, h) {
  const key = state.himap + '|' + w + '|' + h + '|' + UI.themeName + '|' + !!D.DUST3D + '|' + !!expander?.isExpanded();
  if (bgCache[key]) return bgCache[key];
  const saved = [zoom, zx, zy]; zoom = 1; zx = zy = 0;      // build unzoomed; draw() scales it
  try { return buildBgUnzoomed(key, w, h); } finally { [zoom, zx, zy] = saved; }
}
function buildBgUnzoomed(key, w, h) {
  const off = document.createElement('canvas');
  const dpr = Math.min(devicePixelRatio || 1, 2);
  off.width = w * dpr; off.height = h * dpr;
  const ctx = off.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = UI.bg;
  ctx.fillRect(0, 0, w, h);
  const img = ctx.getImageData(0, 0, off.width, off.height);
  hiStretchSky[state.himap] = null;
  for (const [grid, scale, alphaMul, sym] of bgGrids()) {
    const { v0, v1 } = gridStretch(grid, sym);
    if (!hiStretchSky[state.himap]) hiStretchSky[state.himap] = { v0, v1 };
    for (let y = 0; y < off.height; y++) {
      const my = -((y + 0.5) / dpr - map.cy) / map.sy;
      for (let x = 0; x < off.width; x++) {
        const mx = ((x + 0.5) / dpr - map.cx) / map.sx;
        const lb = C.mollInvert(mx, my);
        if (!lb) continue;
        const v = gridSample(grid, lb[0], lb[1]);
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
  bgCache[key] = off;
  return off;
}

let starCache = null, starCacheKey = '';
function buildStarLayer(w, h) {
  const gl = expander?.isExpanded() ? 1.9 : 1;   // GC / dwarf glyph scale when enlarged
  const key = [w, h, zoom, zx, zy, state.via, state.streamsOn, state.hlStream && state.streamSel,
    state.memOn, state.mem2On, state.gcOn, state.dgOn, state.viaDwarfs,
    state.hlGC && state.gcSel, state.hlDwarf && state.dwarfSel, state.himap, UI.themeName, !!D.MEM2, !!D.DUST].join('|');
  if (starCache && starCacheKey === key) return starCache;
  starCacheKey = key;
  const off = document.createElement('canvas');
  const dpr = Math.min(devicePixelRatio || 1, 2);
  off.width = w * dpr; off.height = h * dpr;
  const ctx = off.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // celestial equator (grey dots) + longitude labels (zoom-aware, so they stay crisp)
  ctx.fillStyle = UI.textDim;
  ctx.globalAlpha = 0.6;
  for (let i = 0; i < D.s_eq_l.length; i++) {
    const [mx, my] = C.mollXY(D.s_eq_l[i], D.s_eq_b[i]);
    const [X, Y] = toPx(mx, my);
    ctx.fillRect(X, Y, 1.2, 1.2);
  }
  ctx.globalAlpha = 1;
  const big = expander?.isExpanded();
  for (let lv = -150; lv <= 150; lv += 30) {
    const [mx, my] = C.mollXY(lv, 0);
    const [X, Y] = toPx(mx, my);
    label(ctx, String(lv), X, Y - 3, { size: big ? 12 : 8, color: UI.textDim, align: 'center' });
  }
  const light = UI.themeName === 'light';
  const selCode = (state.hlStream && state.streamSel) ? D.STREAM_NAMES.indexOf(state.streamSel) : -1;
  if (state.streamsOn) {
    ctx.globalAlpha = 0.55;
    for (let i = 0; i < D.N; i += 3) {
      if (state.via && !D.viaMask[i]) continue;
      const isSel = selCode < 0 || D.s_name_code[i] === selCode;
      const [mx, my] = C.mollXY(D.s_l[i], D.s_b[i]);
      const [X, Y] = toPx(mx, my);
      ctx.fillStyle = isSel ? (light ? '#2a2620' : '#e2dcd0') : UI.greyStar;
      ctx.fillRect(X, Y, isSel ? 1.6 : 1.2, isSel ? 1.6 : 1.2);
    }
    if (selCode >= 0) {
      ctx.fillStyle = UI.accent;
      for (let i = 0; i < D.N; i++) {
        if (D.s_name_code[i] !== selCode) continue;
        const [mx, my] = C.mollXY(D.s_l[i], D.s_b[i]);
        const [X, Y] = toPx(mx, my);
        ctx.fillRect(X, Y, 2, 2);
      }
    }
    ctx.globalAlpha = 1;
  }
  if (state.dgOn && state.mem2On && D.MEM2) {
    ctx.fillStyle = UI.member2;
    ctx.globalAlpha = 0.7;
    for (let i = 0; i < D.MEM2.lam.length; i += 2) {
      const [mx, my] = C.mollXY(D.MEM2.l[i], D.MEM2.b[i]);
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
      hexagram(ctx, X, Y, (i === sel ? 6 : 3.4) * gl, i === sel ? UI.accent : UI.gc, '#00000088');
      if (i === sel) label(ctx, D.GCC.name[i], X + 7, Y + 3, { size: 8.5, color: UI.accent });
    }
  }
  if (state.dgOn) {
    const sel = state.hlDwarf ? state.dwarfSel : null;
    for (let i = 0; i < D.DWF.lam.length; i++) {
      if (state.viaDwarfs && !(D.DWF.dist[i] < 300)) continue;
      const [mx, my] = C.mollXY(D.DWF.l[i], D.DWF.b[i]);
      const [X, Y] = toPx(mx, my);
      diamond(ctx, X, Y, (i === sel ? 6 : 3.2) * gl, i === sel ? UI.accent : UI.dwarf, '#00000088');
      if (i === sel) label(ctx, D.DWF.name[i], X + 7, Y + 3, { size: 8.5, color: UI.accent });
    }
  }
  starCache = off;
  return off;
}

function draw() {
  const w = wrap.clientWidth;
  if (!w) return;
  const big = expander.isExpanded();
  const h = Math.min(Math.round(w * 0.52), Math.max(240, window.innerHeight - 90));
  const ctx = fitCanvas(cv, w, h);
  map.cx = w / 2; map.cy = h / 2;
  const s = Math.min((w / 2 - 4) / MX, (h / 2 - 4) / MY);
  map.sx = s; map.sy = s;
  ctx.fillStyle = UI.bg;
  ctx.fillRect(0, 0, w, h);
  // background (cached unzoomed, scaled about the map centre) then the zoom-aware star layer
  ctx.drawImage(buildBg(w, h), map.cx - map.cx * zoom + zx, map.cy - map.cy * zoom + zy, w * zoom, h * zoom);
  ctx.drawImage(buildStarLayer(w, h), 0, 0, w, h);

  // HVC clouds (outline at catalog size; optional velocity color)
  if (state.cloudsOn && D.CLOUDS) {
    const cl = D.CLOUDS;
    ctx.globalAlpha = 0.75;
    for (const i of (F.clouds ?? [])) {
      const [mx, my] = C.mollXY(cl.l[i], cl.b[i]);
      const [X, Y] = toPx(mx, my);
      const r = Math.max(1.4, cl.radDeg[i] * map.sx * 0.049);
      ctx.strokeStyle = cloudColor(i);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(X, Y, r, 0, 2 * Math.PI); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  // Via planned pointings: 1-degree circles (dots when small), survey colors
  if (state.viaOn && D.VIA) {
    const V = D.VIA;
    const r1 = 0.5 * map.sx * 0.049;           // 0.5 deg in map px (approx, at the equator)
    for (let i = 0; i < V.svy.length; i++) {
      if (!state.viaSvy[V.svy[i]]) continue;
      const [mx, my] = C.mollXY(V.l[i], V.b[i]);
      const [X, Y] = toPx(mx, my);
      const col = SVY_COL[V.svy[i]];
      if (big) {
        ctx.globalAlpha = 0.85;
        circleOutline(ctx, X, Y, Math.max(2.2, r1), col, 1);
        ctx.globalAlpha = 1;
      } else dot(ctx, X, Y, 1.6, col, 0.9);
    }
  }
  // other active field lists (promising / saved / visited): 1-degree circles in the list color
  if (state.viaOn) {
    const r1 = 0.5 * map.sx * 0.049;
    for (const it of LIST.items) {
      if (it.src.startsWith('via:') || it.src === 'bish19') continue;
      const col = sourceById(it.src)?.color ?? UI.text;
      const [mx, my] = C.mollXY(it.l, it.b);
      const [X, Y] = toPx(mx, my);
      if (big) { ctx.globalAlpha = 0.85; circleOutline(ctx, X, Y, Math.max(2.4, r1 * it.fov), col, 1.1); ctx.globalAlpha = 1; }
      else dot(ctx, X, Y, 1.8, col, 0.9);
    }
  }
  // literature sightlines
  if (state.sightOn && D.SIGHT?.bish19) {
    const S = D.SIGHT.bish19;
    for (let i = 0; i < S.name.length; i++) {
      const [mx, my] = C.mollXY(S.l[i], S.b[i]);
      const [X, Y] = toPx(mx, my);
      circleOutline(ctx, X, Y, big ? 6 : 4, UI.text, 1.4);
      if (big) label(ctx, S.name[i].split(' ')[0], X + 8, Y + 3, { size: 9, color: UI.text });
    }
  }
  for (const cone of D.CONES) {
    if (!state[cone.key]) continue;
    drawSkyCircle(ctx, cone.l, cone.b, cone.r, cone.color, 1.2);
    const [cmx, cmy] = C.mollXY(cone.l, cone.b);
    const [CX, CY] = toPx(cmx, cmy);
    label(ctx, cone.name, CX, CY - cone.r * map.sy * 0.045 - 4, { align: 'center', size: 8, color: cone.color });
  }
  drawHoverStructure(ctx);
  drawSkyCircle(ctx, F.l0, F.b0, Math.max(state.fov / 2, 1.2 / zoom), UI.accent, 1.8);
  drawHiBar(ctx, w, h);
  if (zoom > 1) label(ctx, `${zoom.toFixed(1)}×`, w - 10, 16, { align: 'right', size: 11, color: UI.textDim });
  cv.style.cursor = 'crosshair';
}

// colorbar: small view bottom-left (2 numbers); full screen bottom-right, larger, 5 ticks
export function drawColorbarH(ctx, st, x, y, lw, lh, fs, nTicks) {
  const scale = bgScale();
  for (let k = 0; k < lw; k++) {
    ctx.fillStyle = scale.css(k / (lw - 1));
    ctx.fillRect(x + k, y, 1.2, lh);
  }
  label(ctx, bgLabel(), x, y - 4, { size: fs, color: UI.textDim });
  for (let t = 0; t < nTicks; t++) {
    const f = t / (nTicks - 1);
    const v = st.v0 + f * (st.v1 - st.v0);
    label(ctx, v.toFixed(nTicks > 2 ? 1 : 1), x + f * lw, y + lh + fs + 2, { align: t === 0 ? 'left' : t === nTicks - 1 ? 'right' : 'center', size: fs, color: UI.textDim });
    if (t > 0 && t < nTicks - 1) { ctx.fillStyle = UI.textDim; ctx.fillRect(x + f * lw, y + lh, 1, 3); }
  }
}
function drawHiBar(ctx, w, h) {
  const st = hiStretchSky[state.himap];
  if (!st) return;
  if (expander.isExpanded()) {
    ctx.fillStyle = 'rgba(22,21,20,0.82)';          // backing so the labels read over bright sky
    ctx.beginPath(); ctx.roundRect(w - 320 - 34, h - 116, 348, 66, 8); ctx.fill();
    drawColorbarH(ctx, st, w - 320 - 20, h - 92, 320, 16, 12, 5);
  }
  else drawColorbarH(ctx, st, 6, h - 7 - 20, 56, 7, 8, 2);
}

// ---- whole-structure hover (enlarged view only) --------------------------------------
function hoverStructure(e) {
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  let best = null, bd = 12;
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
  if (!best && state.viaOn && D.VIA) {
    let vd = 7;
    for (let i = 0; i < D.VIA.svy.length; i++) {
      if (!state.viaSvy[D.VIA.svy[i]]) continue;
      const [mx, my] = C.mollXY(D.VIA.l[i], D.VIA.b[i]);
      const [X, Y] = toPx(mx, my);
      const d = Math.hypot(X - x, Y - y);
      if (d < vd) { vd = d; best = { type: 'via', id: i }; }
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

export function viaHtml(i) {
  const V = D.VIA;
  return `<b>Via ${V.surveys[V.svy[i]]}</b>${V.sub[i] ? ` · ${V.sub[i]}` : ''}<br>${V.name[i] || 'tile ' + V.tile[i]} · tile ${V.tile[i]}<br>${V.nvis[i]} planned visit${V.nvis[i] === 1 ? '' : 's'}${Number.isFinite(V.pri[i]) && V.pri[i] > 0 ? ` · priority ${V.pri[i]}` : ''}<br>ℓ ${V.l[i].toFixed(1)}, b ${V.b[i].toFixed(1)} · <span style="opacity:.7">dbl-click to open</span>`;
}
function hoverHtml(o) {
  if (o.type === 'gc') return `<b>${D.GCC.name[o.id]}</b> · GC<br>${D.GCC.dist[o.id].toFixed(1)} kpc`;
  if (o.type === 'dwarf') return `<b>${D.DWF.name[o.id]}</b> · dwarf<br>${D.DWF.dist[o.id].toFixed(1)} kpc`;
  if (o.type === 'via') return viaHtml(o.id);
  return `<b>${D.STREAM_NAMES[o.id]}</b> · stream${D.streamIsVia(o.id) ? ' (Via core)' : ''}`;
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
  } else if (hoverObj.type === 'via') {
    const V = D.VIA, i = hoverObj.id;
    const [mx, my] = C.mollXY(V.l[i], V.b[i]);
    const [X, Y] = toPx(mx, my);
    circleOutline(ctx, X, Y, 7, SVY_COL[V.svy[i]], 2);
    label(ctx, `${SVY_SHORT[V.svy[i]] ?? V.svy[i]}: ${V.name[i] || 'tile ' + V.tile[i]}`, X + 10, Y + 3, { size: 10, color: SVY_COL[V.svy[i]] });
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
    if (pen && lastX !== null && Math.abs(X - lastX) > 40) pen = false;
    if (pen) ctx.lineTo(X, Y); else { ctx.moveTo(X, Y); pen = true; }
    lastX = X;
  }
  ctx.stroke();
}
