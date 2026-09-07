// Finder chart — a clean circular cutout of the field (gnomonic projection, arcmin).
// Gas/dust background clipped to the circle (own colorbar top-left + stats top-right),
// importance-scaled glyphs (Via-stream stars largest; sizes shrink in crowded fields),
// GC/dwarf/member/tracer/QSO markers, Via planned-pointing circles, literature
// sightlines, hover readout, dblclick-to-recenter, drag-to-pan, two-finger pan + pinch
// zoom when enlarged, tiled 1-degree pointings when FOV > 1, and rung pop-outs.
import { D, bgGridFor } from '../data.js';
import { state, set, setField, slideField, replaceLock, emit, on } from '../state.js';
import { F, KIND } from '../fieldmodel.js';
import { skey } from '../rungs.js';
import * as C from '../compute.js';
import { UI, scales, streamColor, dwarfColorByName, SVY_COL, SVY_SHORT, bgScale, bgLabel } from '../colors.js';
import { placeTooltip } from '../scene3d.js';
import { makeExpandable } from './expand.js';
import { fitCanvas, starGlyph, hexagram, diamond, dot, circleOutline, label } from './canvas2d.js';

let cv, wrap, tipEl, expander;
let px = { R: 0, cx: 0, cy: 0, scale: 1 };
let hitList = [];
let hiStretch = null;
let hilite = null;
let liveMove = false;

export function initFinder(container) {
  wrap = container;
  cv = document.createElement('canvas');
  cv.className = 'finder-canvas';
  container.appendChild(cv);
  tipEl = document.getElementById('tooltip2d');
  expander = makeExpandable(container, {
    onToggle: () => draw(),
    hint: 'two-finger scroll pans · pinch (or ⌥ + scroll) changes the FOV · double-click recenters · Esc closes',
  });
  on('fieldmodel', (opts) => { liveMove = !!opts?.live; draw(); });
  on('hilite', h => { hilite = h; draw(); });
  on('theme', draw);
  new ResizeObserver(draw).observe(container);
  cv.addEventListener('pointerleave', () => { tipEl.style.display = 'none'; });
  wirePointer();
}

function toPx(xiAm, etaAm) { return [px.cx + xiAm * px.scale, px.cy - etaAm * px.scale]; }
function fromPx(x, y) { return [(x - px.cx) / px.scale, -(y - px.cy) / px.scale]; }

// does a source belong to the active pop-out highlight?
function inHilite(kind, structKey, dist, rawName = null) {
  if (!hilite) return true;
  if (hilite.type === 'stream') return kind === KIND.STAR && rawName === hilite.name;
  if (hilite.type === 'kind') {
    if (hilite.kind === 'dwarf') return kind === 'dwarf' || kind === KIND.MEM || kind === KIND.MEM2;
    return kind === hilite.kind;
  }
  const r = hilite.rung;
  if (r.kind === 'halo') return kind === KIND.HALO && Math.abs(dist - r.dist) <= 1.5;
  if (r.kind === 'kg') return kind === KIND.KG && Math.abs(dist - r.dist) <= 1.5;
  if (r.kind === 'bhb') return kind === KIND.BHB && Math.abs(dist - r.dist) <= 1.5;
  if (kind === KIND.QSO) return false;
  return structKey === r.key;
}
const dimA = 0.12;

function draw() {
  const big = expander?.isExpanded();
  const w = wrap.clientWidth - (big ? 34 : 0);
  if (w <= 0) return;
  const h = big ? Math.max(240, window.innerHeight - 40) : Math.min(w, Math.max(240, window.innerHeight - 40));
  const ctx = fitCanvas(cv, w, h);
  ctx.clearRect(0, 0, w, h);
  const Ram = state.fov / 2 * 60;
  px.R = Math.min(w, h) / 2 - 8; px.cx = w / 2; px.cy = h / 2;
  px.scale = px.R / Ram;
  hitList = [];

  ctx.save();
  ctx.beginPath();
  ctx.arc(px.cx, px.cy, px.R, 0, 2 * Math.PI);
  ctx.clip();
  ctx.fillStyle = UI.finderBg;
  ctx.fillRect(0, 0, w, h);

  drawBackground(ctx, Ram);
  drawMagellanicDisks(ctx);
  drawViaPointings(ctx);

  if (state.fov > 1.001 && !liveMove) {
    const pts = allSourceXiEta();
    if (pts) {
      const cov = coverPointings(pts.xi, pts.eta);
      for (const [cxc, cyc] of cov) {
        const [X, Y] = toPx(cxc, cyc);
        circleOutline(ctx, X, Y, 30 * px.scale, UI.themeName === 'light' ? 'rgba(40,40,40,0.5)' : 'rgba(255,255,255,0.55)', 1.1);
      }
    }
  }
  drawSources(ctx);
  ctx.restore();

  // field rim
  circleOutline(ctx, px.cx, px.cy, px.R, UI.accent, 2.2);
  const sx0 = big ? 22 : 8;
  const bar = 15 * px.scale;
  ctx.fillStyle = UI.textDim;
  ctx.fillRect(sx0, h - 8, bar, 1.5);
  label(ctx, "15′", sx0 + bar / 2, h - 12, { align: 'center', size: big ? 12 : 10.5, color: UI.textDim });
  if (state.lock?.name) {
    label(ctx, state.lock.name, w - 8, h - 8,
      { align: 'right', size: big ? 15 : 12.5, color: UI.text, weight: 'italic 700' });
  }
  drawLegend(ctx, w, h);
}

function drawLegend(ctx, w, h) {
  const scale = bgScale();
  const big = expander?.isExpanded();
  const lw = big ? 130 : 56, lh = big ? 13 : 7, lx = big ? 22 : 6, ly = big ? 20 : 14;
  const fs = big ? 11 : 8;
  for (let k = 0; k < lw; k++) {
    ctx.fillStyle = scale.css(k / (lw - 1));
    ctx.fillRect(lx + k, ly, 1.2, lh);
  }
  label(ctx, bgLabel(), lx, ly - 5, { size: fs, color: UI.textDim });
  if (hiStretch) {
    label(ctx, hiStretch.v0.toFixed(1), lx, ly + lh + fs + 2, { size: fs, color: UI.textDim });
    label(ctx, hiStretch.v1.toFixed(1), lx + lw, ly + lh + fs + 2, { align: 'right', size: fs, color: UI.textDim });
  }
  const rx = big ? w - 46 : w - 6;
  const fs2 = big ? 11 : 8.5;
  let yy = 11;
  if (F.hiTotal) {
    label(ctx, `HI mean ${Math.log10(F.hiTotal.mean).toFixed(2)}`, rx, yy, { align: 'right', size: fs2, color: UI.textDim }); yy += big ? 14 : 10;
    label(ctx, `HI peak ${Math.log10(F.hiTotal.peak).toFixed(2)}`, rx, yy, { align: 'right', size: fs2, color: UI.textDim }); yy += big ? 14 : 10;
  }
  if (state.himap === 'hvc' && !F.hi) { label(ctx, 'no HVC gas', rx, yy, { align: 'right', size: fs2, color: UI.textDim }); yy += big ? 14 : 10; }
  if (F.ebv) label(ctx, `E(B−V) ${(10 ** F.ebv.mean).toFixed(3)}`, rx, yy, { align: 'right', size: fs2, color: UI.textDim });
}

function drawBackground(ctx, Ram) {
  const n = 64;
  const bg = bgGridFor(state.himap);
  const grids = [[bg.gal, bgScale(), 1.0]];
  if (bg.overlay) grids.push([bg.overlay.gal, scales.hiRed, 0.55]);
  const D2R = Math.PI / 180, R2Dg = 180 / Math.PI;
  const lr = state.lam0 * D2R, br = state.bet0 * D2R;
  const cb = Math.cos(br), sb = Math.sin(br), cl = Math.cos(lr), sl = Math.sin(lr);
  const c = [cb * cl, cb * sl, sb];
  const eXi = [-sl, cl, 0];
  const eEta = [-sb * cl, -sb * sl, cb];
  const A = D.M_GAL, B = D.M_SGR;
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) {
    M[r][q] = A[r][0] * B[q][0] + A[r][1] * B[q][1] + A[r][2] * B[q][2];
  }
  hiStretch = null;
  for (const [grid, scale, alpha] of grids) {
    const vals = new Float64Array(n * n);
    for (let iy = 0, k = 0; iy < n; iy++) {
      for (let ix = 0; ix < n; ix++, k++) {
        const xiR = (-Ram + (ix + 0.5) * (2 * Ram / n)) / 60 * D2R;
        const etaR = (Ram - (iy + 0.5) * (2 * Ram / n)) / 60 * D2R;
        const dx = c[0] + xiR * eXi[0] + etaR * eEta[0];
        const dy = c[1] + xiR * eXi[1] + etaR * eEta[1];
        const dz = c[2] + xiR * eXi[2] + etaR * eEta[2];
        const gx = M[0][0] * dx + M[0][1] * dy + M[0][2] * dz;
        const gy = M[1][0] * dx + M[1][1] * dy + M[1][2] * dz;
        const gz = M[2][0] * dx + M[2][1] * dy + M[2][2] * dz;
        const nrm = Math.hypot(gx, gy, gz);
        const lg = Math.atan2(gy, gx) * R2Dg;
        const bg = Math.asin(Math.max(-1, Math.min(1, gz / nrm))) * R2Dg;
        vals[k] = C.hiSample(grid, D.HI_NY, D.HI_NX, D.HI_STEP, lg, bg);
      }
    }
    const fin = [...vals].filter(Number.isFinite).sort((a, b) => a - b);
    if (!fin.length) continue;
    const v0 = C.quantileSorted(fin, 0.02), v1 = C.quantileSorted(fin, 0.98);
    if (!hiStretch) hiStretch = { v0, v1 };
    const off = document.createElement('canvas');
    off.width = n; off.height = n;
    const octx = off.getContext('2d');
    const img = octx.createImageData(n, n);
    for (let k = 0; k < n * n; k++) {
      const v = vals[k];
      if (!Number.isFinite(v)) continue;
      const t = Math.max(0, Math.min(1, (v - v0) / (v1 - v0 || 1)));
      const [r, g, b] = scale.rgb(t);
      img.data[4 * k] = r; img.data[4 * k + 1] = g; img.data[4 * k + 2] = b;
      img.data[4 * k + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    ctx.globalAlpha = alpha * 0.6;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(off, px.cx - px.R, px.cy - px.R, 2 * px.R, 2 * px.R);
    ctx.globalAlpha = 1;
  }
}

const MAGELLANIC = [{ name: 'LMC', rDeg: 5.4 }, { name: 'SMC', rDeg: 2.6 }];
function drawMagellanicDisks(ctx) {
  if (!state.dgOn || !state.memOn) return;
  for (const mc of MAGELLANIC) {
    const i = D.DWF.name.indexOf(mc.name);
    if (i < 0) continue;
    const sepDeg = C.angSepAm(state.lam0, state.bet0, D.DWF.lam[i], D.DWF.bet[i]) / 60;
    if (sepDeg > state.fov / 2 + mc.rDeg) continue;
    const [x, y] = C.gnomonic(Float64Array.of(D.DWF.lam[i]), Float64Array.of(D.DWF.bet[i]), state.lam0, state.bet0);
    const [X, Y] = toPx(x[0], y[0]);
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = UI.dwarf;
    ctx.beginPath();
    ctx.arc(X, Y, mc.rDeg * 60 * px.scale, 0, 2 * Math.PI);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

// Via planned 1-degree pointings overlapping the field (survey-colored dashed circles)
function drawViaPointings(ctx) {
  if (!F.via?.length || !D.VIA) return;
  const V = D.VIA;
  const [vx, vy] = C.gnomonic(Float64Array.from(F.via, i => V.lam[i]), Float64Array.from(F.via, i => V.bet[i]), state.lam0, state.bet0);
  const big = expander?.isExpanded();
  for (let k = 0; k < F.via.length; k++) {
    const i = F.via[k];
    const [X, Y] = toPx(vx[k], vy[k]);
    const r = 30 * px.scale;
    const col = SVY_COL[V.svy[i]] ?? UI.textDim;
    ctx.globalAlpha = 0.9;
    circleOutline(ctx, X, Y, r, col, big ? 1.6 : 1.2, [6, 4]);
    ctx.globalAlpha = 0.10;
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(X, Y, r, 0, 2 * Math.PI); ctx.fill();
    ctx.globalAlpha = 1;
    const nm = V.name[i] || `tile ${V.tile[i]}`;
    label(ctx, `${SVY_SHORT[V.svy[i]] ?? V.svy[i]}: ${nm}`, X, Y - r - 3, { align: 'center', size: big ? 11 : 8.5, color: col });
    hitList.push({
      x: X, y: Y, r: 9, pri: -1,
      html: `<b>Via ${V.surveys[V.svy[i]]}</b>${V.sub[i] ? ` · ${V.sub[i]}` : ''}<br>${nm} · tile ${V.tile[i]}<br>${V.nvis[i]} planned visit${V.nvis[i] === 1 ? '' : 's'}${Number.isFinite(V.pri[i]) && V.pri[i] > 0 ? ` · priority ${V.pri[i]}` : ''}<br><span style="opacity:.7">dbl-click: jump to this pointing</span>`,
      lam: V.lam[i], bet: V.bet[i], via: i,
    });
  }
}

function allSourceXiEta() {
  const lam = [], bet = [];
  for (const i of F.idx) { lam.push(D.s_lam[i]); bet.push(D.s_bet[i]); }
  for (const i of F.mm) { lam.push(D.MEM.lam[i]); bet.push(D.MEM.bet[i]); }
  for (const i of F.mm2 ?? []) { lam.push(D.MEM2.lam[i]); bet.push(D.MEM2.bet[i]); }
  for (const i of F.hh ?? []) { lam.push(D.HALO.lam[i]); bet.push(D.HALO.bet[i]); }
  for (const i of F.kg ?? []) { lam.push(D.KG.lam[i]); bet.push(D.KG.bet[i]); }
  for (const i of F.bhb ?? []) { lam.push(D.BHB.lam[i]); bet.push(D.BHB.bet[i]); }
  for (const i of F.gc) { lam.push(D.GCC.lam[i]); bet.push(D.GCC.bet[i]); }
  for (const i of F.dw) { lam.push(D.DWF.lam[i]); bet.push(D.DWF.bet[i]); }
  if (lam.length < 2) return null;
  const [xi, eta] = C.gnomonic(Float64Array.from(lam), Float64Array.from(bet), state.lam0, state.bet0);
  return { xi, eta };
}

function coverPointings(xi, eta, r = 30, minCov = 2, cap = 300) {
  const n = xi.length;
  if (n < minCov) return [];
  const nCand = Math.min(n, 400);
  const stride = Math.max(1, Math.floor(n / nCand));
  const cand = [];
  for (let i = 0; i < n; i += stride) cand.push(i);
  const covered = cand.map(c => {
    const list = [];
    for (let j = 0; j < n; j++) if (Math.hypot(xi[c] - xi[j], eta[c] - eta[j]) <= r) list.push(j);
    return list;
  });
  const uncov = new Uint8Array(n).fill(1);
  let left = n;
  const chosen = [];
  const active = new Set(cand.keys());
  while (chosen.length < cap && left >= minCov) {
    let best = -1, bestCnt = 0;
    for (const k of active) {
      let cnt = 0;
      for (const j of covered[k]) cnt += uncov[j];
      if (cnt > bestCnt) { bestCnt = cnt; best = k; }
      if (cnt === 0) active.delete(k);
    }
    if (bestCnt < minCov) break;
    for (const j of covered[best]) if (uncov[j]) { uncov[j] = 0; left--; }
    chosen.push([xi[cand[best]], eta[cand[best]]]);
    active.delete(best);
  }
  return chosen;
}

// glyph sizes scale down with crowding so dense fields (Sgr core) stay readable
function glyphSizes() {
  const n = F.src.n;
  const big = expander?.isExpanded() ? 1.35 : 1;
  const s = n < 60 ? 1.0 : n < 250 ? 0.8 : n < 800 ? 0.62 : n < 2500 ? 0.45 : 0.32;
  return {
    viaStar: Math.max(3.2, 9.5 * s) * big,     // Via core-stream stars: the critical targets
    star: Math.max(2.2, 6.5 * s) * big,
    tracer: Math.max(2.0, 4.6 * s) * big,
    member: Math.max(2.0, 4.6 * s) * big,
    qso: Math.max(2.0, 4.2 * s) * big,
    dense: n > 2500,
  };
}

function drawSources(ctx) {
  const sz = glyphSizes();
  const big = expander?.isExpanded();

  if (state.connect && F.nn && F.src.n > 1) {
    const [sxi, seta] = C.gnomonic(F.src.lam, F.src.bet, state.lam0, state.bet0);
    ctx.strokeStyle = 'rgba(224,82,82,0.45)';
    ctx.lineWidth = 2.1;
    ctx.beginPath();
    for (let i = 0; i < F.src.n; i++) {
      const j = F.nn.nn[i];
      ctx.moveTo(...toPx(sxi[i], seta[i]));
      ctx.lineTo(...toPx(sxi[j], seta[j]));
    }
    ctx.stroke();
  }

  // quasars (small, at infinity)
  if (F.qq.length) {
    const qa = inHilite(KIND.QSO) ? 0.9 : dimA;
    const [qx, qy] = C.gnomonic(Float64Array.from(F.qq, i => D.QSO.lam[i]), Float64Array.from(F.qq, i => D.QSO.bet[i]), state.lam0, state.bet0);
    for (let k = 0; k < F.qq.length; k++) {
      const [X, Y] = toPx(qx[k], qy[k]);
      dot(ctx, X, Y, sz.qso, UI.accent2, qa);
      ctx.strokeStyle = '#00000088'; ctx.lineWidth = 0.8; ctx.stroke();
      hitList.push({ x: X, y: Y, r: sz.qso + 2, pri: 0, qso: F.qq[k], lam: D.QSO.lam[F.qq[k]], bet: D.QSO.bet[F.qq[k]],
        lockInfo: { kind: 'star', id: F.qq[k], name: 'QSO' } });
    }
  }

  // HVC clouds intersecting the field (outline at catalog angular size)
  if (state.cloudsOn && F.cloudsInField?.length) {
    const cl = D.CLOUDS;
    const [cx2, cy2] = C.gnomonic(Float64Array.from(F.cloudsInField, i => cl.lam[i]), Float64Array.from(F.cloudsInField, i => cl.bet[i]), state.lam0, state.bet0);
    for (let k = 0; k < F.cloudsInField.length; k++) {
      const i = F.cloudsInField[k];
      const [X, Y] = toPx(cx2[k], cy2[k]);
      const r = Math.max(5, cl.radDeg[i] * 60 * px.scale);
      circleOutline(ctx, X, Y, r, cloudColor(i), 1.4, [5, 4]);
      hitList.push({ x: X, y: Y, r: Math.min(r, 30), pri: -1,
        html: `<b>${cl.name[i]}</b> · ${cl.type[i]} · ${D.CLOUD_SRC[cl.src[i]]}<br>v_LSR ${cl.vlsr[i].toFixed(0)} · v_GSR ${cl.vgsr[i].toFixed(0)} km/s<br>size ~${(cl.radDeg[i] * 2).toFixed(1)}°`,
        lam: cl.lam[i], bet: cl.bet[i] });
    }
  }

  // individual halo tracers: RRL, K giants, BHB, Kepler stars (small dots)
  const tracer = (arr, cat, kind, col, htmlFn, name) => {
    if (!arr?.length) return;
    const [hx, hy] = C.gnomonic(Float64Array.from(arr, i => cat.lam[i]), Float64Array.from(arr, i => cat.bet[i]), state.lam0, state.bet0);
    for (let k = 0; k < arr.length; k++) {
      const i = arr[k];
      const [X, Y] = toPx(hx[k], hy[k]);
      const a = inHilite(kind, null, cat.dist[i]) ? 0.9 : dimA;
      dot(ctx, X, Y, sz.tracer, col, a);
      ctx.strokeStyle = '#00000066'; ctx.lineWidth = 0.8; ctx.stroke();
      hitList.push({ x: X, y: Y, r: sz.tracer + 2, pri: 0, html: htmlFn(i), lam: cat.lam[i], bet: cat.bet[i],
        lockInfo: { kind: 'star', id: i, name, dist: cat.dist[i] } });
    }
  };
  tracer(F.kep, D.KEP, KIND.KEP, UI.kep, i => `<b>Kepler-field star</b><br>${D.KEP.dist[i].toFixed(2)} kpc (1/parallax)<br>G = ${D.KEP.G[i].toFixed(2)}`, 'Kepler star');
  tracer(F.hh, D.HALO, KIND.HALO, UI.halo, i => `<b>halo ${D.HALO.clsNames[D.HALO.cls[i]] || 'RRL'}</b><br>${D.HALO.dist[i].toFixed(1)} kpc (±10%)<br>G = ${D.HALO.G[i].toFixed(2)}`, 'halo RRL');
  tracer(F.kg, D.KG, KIND.KG, UI.kg, i => `<b>K giant</b> (Chandra set ${D.KG.set[i]})<br>${D.KG.dist[i].toFixed(1)} kpc (isochrone)<br>G = ${D.KG.G[i].toFixed(2)}`, 'K giant');
  tracer(F.bhb, D.BHB, KIND.BHB, UI.bhb, i => `<b>BHB star</b> (Xue+11)<br>${D.BHB.dist[i].toFixed(1)} kpc<br>g = ${D.BHB.G[i].toFixed(2)} · v_helio ${D.BHB.hrv[i].toFixed(0)} km/s`, 'BHB');

  // dwarf members (same color as the dwarfs); Geha members lighter
  const members = (arr, cat, kind, colFn, tag) => {
    if (!arr?.length) return;
    const [mxA, myA] = C.gnomonic(Float64Array.from(arr, i => cat.lam[i]), Float64Array.from(arr, i => cat.bet[i]), state.lam0, state.bet0);
    for (let k = 0; k < arr.length; k++) {
      const i = arr[k];
      const [X, Y] = toPx(mxA[k], myA[k]);
      const a = inHilite(kind, skey(cat.name[i]), cat.dist[i]);
      ctx.globalAlpha = a ? 1 : dimA;
      if (sz.dense) { ctx.fillStyle = colFn(i); ctx.fillRect(X - 1.4, Y - 1.4, 2.8, 2.8); }
      else starGlyph(ctx, X, Y, sz.member, colFn(i), '#00000066');
      ctx.globalAlpha = 1;
      const g = Number.isFinite(cat.G[i]) ? cat.G[i].toFixed(2) : '—';
      hitList.push({ x: X, y: Y, r: sz.member + 2, pri: 0,
        html: `<b>${cat.name[i]}</b> member${tag}<br>${cat.dist[i].toFixed(0)} kpc (galaxy)<br>G = ${g} · P=${cat.pmem[i].toFixed(2)}`,
        lam: cat.lam[i], bet: cat.bet[i], lockInfo: { kind: 'star', id: i, name: cat.name[i], dist: cat.dist[i] } });
    }
  };
  members(F.mm, D.MEM, KIND.MEM, i => dwarfColorByName(D.MEM.name[i]), '');
  members(F.mm2, D.MEM2, KIND.MEM2, () => UI.member2, ' (Geha+26, predicted G)');

  // stream stars — identity colors; Via-stream stars drawn LAST and larger
  const selCode = (state.hlStream && state.streamSel) ? D.STREAM_NAMES.indexOf(state.streamSel) : -1;
  if (F.idx.length) {
    const [xi, eta] = C.gnomonic(Float64Array.from(F.idx, i => D.s_lam[i]), Float64Array.from(F.idx, i => D.s_bet[i]), state.lam0, state.bet0);
    for (const pass of [0, 1]) {
      for (let k = 0; k < F.idx.length; k++) {
        const i = F.idx[k];
        const isVia = D.viaMask[i] === 1;
        if ((pass === 1) !== isVia) continue;
        const [X, Y] = toPx(xi[k], eta[k]);
        const isSel = selCode < 0 || D.s_name_code[i] === selCode;
        const fill = isSel ? streamColor(D.s_name_code[i]) : UI.greyStar;
        const hl = inHilite(KIND.STAR, skey(D.streamName(i)), D.s_dist_use[i], D.streamName(i));
        ctx.globalAlpha = hl ? 1 : dimA;
        const r = isVia ? sz.viaStar : sz.star;
        if (sz.dense && !isVia) { ctx.fillStyle = fill; ctx.fillRect(X - 1.4, Y - 1.4, 2.8, 2.8); }
        else starGlyph(ctx, X, Y, r, fill, isVia ? '#000000aa' : '#00000055');
        ctx.globalAlpha = 1;
        hitList.push({ x: X, y: Y, r: (sz.dense && !isVia) ? 3.5 : r + 2, pri: isVia ? 1 : 0, star: i,
          lam: D.s_lam[i], bet: D.s_bet[i], lockInfo: { kind: 'star', id: i, name: D.streamName(i), dist: D.s_dist_use[i] } });
      }
    }
  }

  // literature sightlines (white ring + label)
  if (F.sight?.length) {
    const S = D.SIGHT.bish19;
    const [sx, sy] = C.gnomonic(Float64Array.from(F.sight, i => S.lam[i]), Float64Array.from(F.sight, i => S.bet[i]), state.lam0, state.bet0);
    for (let k = 0; k < F.sight.length; k++) {
      const i = F.sight[k];
      const [X, Y] = toPx(sx[k], sy[k]);
      circleOutline(ctx, X, Y, 7, UI.text, 1.6);
      dot(ctx, X, Y, 2, UI.text, 1);
      label(ctx, S.name[i].split(' ')[0], X + 9, Y + 3, { size: big ? 11 : 8.5, color: UI.text });
      hitList.push({ x: X, y: Y, r: 9, pri: 2,
        html: `<b>${S.name[i]}</b><br>Bish+19 Keck/HIRES Na I + Ca II sightline<br>${S.dist[i]} kpc · g ${S.g[i]} · v_helio ${S.hrv[i]} km/s`,
        lam: S.lam[i], bet: S.bet[i], lockInfo: { kind: 'star', id: i, name: S.name[i].split(' ')[0], dist: S.dist[i] } });
    }
  }

  // GCs / dwarfs (with r_h circles) — high hover priority
  for (const [cat, ii, glyph, col, kk] of [[D.GCC, F.gc, hexagram, UI.gc, 'gc'], [D.DWF, F.dw, diamond, UI.dwarf, 'dwarf']]) {
    if (!ii.length) continue;
    const [ox, oy] = C.gnomonic(Float64Array.from(ii, i => cat.lam[i]), Float64Array.from(ii, i => cat.bet[i]), state.lam0, state.bet0);
    for (let k = 0; k < ii.length; k++) {
      const i = ii[k];
      const [X, Y] = toPx(ox[k], oy[k]);
      const hl = inHilite(kk, skey(cat.name[i]), cat.dist[i]);
      const oc = kk === 'dwarf' ? dwarfColorByName(cat.name[i]) : col;
      ctx.globalAlpha = hl ? 1 : dimA;
      if (cat.rh_am && Number.isFinite(cat.rh_am[i]) && cat.rh_am[i] > 0.3) {
        circleOutline(ctx, X, Y, cat.rh_am[i] * px.scale, oc + '99', 1, [3, 3]);
      }
      let s = 9;
      if (cat.mass && Number.isFinite(cat.mass[i]) && cat.mass[i] > 0) {
        s = 8 + 6 * Math.max(0, Math.min(1, (Math.log10(Math.max(cat.mass[i], 1e2)) - 3) / 6));
      }
      if (big) s *= 1.3;
      glyph(ctx, X, Y, s, oc, '#000000aa');
      ctx.globalAlpha = 1;
      let html = `<b>${cat.name[i]}</b><br>${cat.dist[i].toFixed(1)} kpc`;
      if (cat.mass && Number.isFinite(cat.mass[i])) html += `<br>${cat.mass[i].toExponential(1)} M☉`;
      if (cat.rh_am && Number.isFinite(cat.rh_am[i])) html += `<br>r_h = ${cat.rh_am[i].toFixed(1)}′`;
      if (cat.src) html += `<br><span style="opacity:.7">${cat.src[i]}</span>`;
      hitList.push({ x: X, y: Y, r: s + 5, pri: 2, html, lam: cat.lam[i], bet: cat.bet[i],
        lockInfo: { kind: kk, id: i, name: cat.name[i], dist: cat.dist[i] } });
    }
  }
}

export function cloudColor(i) {
  const cl = D.CLOUDS;
  if (state.cloudColor === 'none') return UI.cloud;
  const v = state.cloudColor === 'vlsr' ? cl.vlsr[i] : cl.vgsr[i];
  if (!Number.isFinite(v)) return UI.cloud;
  return scales.vel.css(Math.max(0, Math.min(1, (v + 300) / 600)));
}

function findHit(e) {
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  let best = null, bd = 1e9, bp = -9;
  for (const h of hitList) {
    const d = Math.hypot(h.x - x, h.y - y);
    if (d > h.r) continue;
    const pri = h.pri ?? 0;
    if (pri > bp || (pri === bp && d < bd)) { best = h; bd = d; bp = pri; }
  }
  return best;
}

function hitHtml(h) {
  if (h.html) return h.html;
  if (h.star !== undefined) {
    const i = h.star;
    return `<b>${D.streamName(i)}</b>${D.viaMask[i] ? ' · Via core stream' : ''}<br>${D.s_dist_use[i].toFixed(1)} kpc${D.s_dist_known[i] ? '' : ' (geom.)'}<br>G = ${D.s_G[i].toFixed(2)}`;
  }
  if (h.qso !== undefined) return `QSO z=${D.QSO.z[h.qso].toFixed(2)} G=${D.QSO.G[h.qso].toFixed(1)}`;
  return '';
}

// ---- pointer wiring: hover, dblclick-to-recenter, drag-to-pan, wheel pan / pinch zoom ----
function wirePointer() {
  let panning = false, panStart = null;
  cv.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const r = cv.getBoundingClientRect();
    panStart = { x: e.clientX - r.left, y: e.clientY - r.top, lam: state.lam0, bet: state.bet0 };
    panning = false;
  });
  cv.addEventListener('pointermove', e => {
    if (panStart) {
      const r = cv.getBoundingClientRect();
      const dx = (e.clientX - r.left) - panStart.x, dy = (e.clientY - r.top) - panStart.y;
      if (!panning && Math.hypot(dx, dy) > 4) {
        panning = true;
        try { cv.setPointerCapture(e.pointerId); } catch {}
        tipEl.style.display = 'none';
      }
      if (panning) {
        const dXi = -dx / px.scale, dEta = dy / px.scale;
        const [lo, la] = C.gnomonicInv(dXi, dEta, panStart.lam, panStart.bet);
        setField(C.wrap180(lo), la, { live: true });
        return;
      }
    }
    hover(e);
  });
  cv.addEventListener('pointerup', () => {
    if (panning) { panning = false; panStart = null; setField(state.lam0, state.bet0); return; }
    panStart = null;
  });
  cv.addEventListener('dblclick', e => {
    const h = findHit(e);
    if (h?.via !== undefined) { window.dispatchEvent(new CustomEvent('v3-goto-via', { detail: h.via })); return; }
    if (h?.lockInfo) {
      replaceLock(h.lockInfo);
      slideField(h.lam, h.bet, { keepLock: true });
      return;
    }
    const r = cv.getBoundingClientRect();
    const [xiAm, etaAm] = fromPx(e.clientX - r.left, e.clientY - r.top);
    if (Math.hypot(xiAm, etaAm) <= state.fov / 2 * 60) {
      const [lo, la] = C.gnomonicInv(xiAm, etaAm, state.lam0, state.bet0);
      slideField(C.wrap180(lo), la);
    }
  });

  // enlarged view: two-finger scroll pans the sky, pinch (ctrl+wheel on macOS) or alt+wheel
  // changes the field size. Live during the gesture, a settled (history-recorded) update after.
  let wheelTimer = null;
  cv.addEventListener('wheel', e => {
    if (!expander.isExpanded()) return;
    e.preventDefault();
    tipEl.style.display = 'none';
    if (e.ctrlKey || e.altKey || e.metaKey) {
      const f = Math.exp(e.deltaY * 0.004);
      const fov = Math.min(5, Math.max(1, state.fov * f));
      if (Math.abs(fov - state.fov) > 1e-4) set({ fov }, 'field');
    } else {
      const dXi = e.deltaX / px.scale, dEta = -e.deltaY / px.scale;
      const [lo, la] = C.gnomonicInv(dXi, dEta, state.lam0, state.bet0);
      setField(C.wrap180(lo), la, { live: true });
    }
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => setField(state.lam0, state.bet0), 220);
  }, { passive: false });
}

function hover(e) {
  const h = findHit(e);
  if (!h) { tipEl.style.display = 'none'; cv.style.cursor = 'crosshair'; return; }
  tipEl.innerHTML = hitHtml(h);
  tipEl.style.display = 'block';
  placeTooltip(tipEl, e);
  cv.style.cursor = 'pointer';
}
