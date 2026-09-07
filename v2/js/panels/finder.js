// Finder chart — a clean circular cutout of the field (gnomonic projection, arcmin).
// HI background clipped to the circle (with its own colorbar top-left + stats top-right),
// star glyphs, GC/dwarf/member/QSO markers, hover readout, dblclick-to-recenter,
// drag-to-pan, tiled 1-degree pointings over ALL sources when FOV > 1, and rung
// pop-out highlighting driven by the ladder / stats panels.
import { D } from '../data.js';
import { state, setField, slideField, replaceLock, emit, on } from '../state.js';
import { F } from '../fieldmodel.js';
import { skey } from '../rungs.js';
import * as C from '../compute.js';
import { UI, scales, streamColor, dwarfColorByName } from '../colors.js';
import { placeTooltip } from '../scene3d.js';
import { makeExpandable } from './expand.js';
import { fitCanvas, starGlyph, hexagram, diamond, dot, circleOutline, label } from './canvas2d.js';

let cv, wrap, tipEl, expander;
let px = { R: 0, cx: 0, cy: 0, scale: 1 };   // arcmin -> px mapping
let hitList = [];                             // for hover/click
let hiStretch = null;                         // {v0, v1} of the current HI render
let hilite = null;                            // {type:'rung', rung}|{type:'kind', kind}|null

let liveMove = false;
export function initFinder(container) {
  wrap = container;
  cv = document.createElement('canvas');
  cv.className = 'finder-canvas';
  container.appendChild(cv);
  tipEl = document.getElementById('tooltip2d');
  expander = makeExpandable(container, { onToggle: () => draw() });
  on('fieldmodel', (opts) => { liveMove = !!opts?.live; draw(); });
  on('hilite', h => { hilite = h; draw(); });
  new ResizeObserver(draw).observe(container);
  cv.addEventListener('pointerleave', () => { tipEl.style.display = 'none'; });
  wirePointer();
}

function toPx(xiAm, etaAm) {
  return [px.cx + xiAm * px.scale, px.cy - etaAm * px.scale];
}
function fromPx(x, y) {
  return [(x - px.cx) / px.scale, -(y - px.cy) / px.scale];
}

// does a source belong to the active pop-out highlight?
function inHilite(kind, structKey, dist, rawName = null) {
  if (!hilite) return true;
  if (hilite.type === 'stream') return kind === 0 && rawName === hilite.name;
  if (hilite.type === 'kind') {
    if (hilite.kind === 'dwarf') return kind === 'dwarf' || kind === 2;  // dwarfs + members
    return kind === hilite.kind;
  }
  const r = hilite.rung;
  if (r.kind === 'halo') return kind === 3 && Math.abs(dist - r.dist) <= 1.5;
  if (kind === 1) return false;                       // quasars never in a structure rung
  return structKey === r.key;
}
const dimA = 0.12;   // alpha for non-highlighted sources while popping a rung out

function draw() {
  // expanded: the wrap's clientWidth includes its padding — shrink the canvas so the
  // right-edge texts stay on screen
  const w = wrap.clientWidth - (expander?.isExpanded() ? 34 : 0);
  if (w <= 0) return;
  const h = Math.min(w, Math.max(240, window.innerHeight - 40));  // circle inscribed
  const ctx = fitCanvas(cv, w, h);
  ctx.clearRect(0, 0, w, h);
  const Ram = state.fov / 2 * 60;                 // field radius in arcmin
  px.R = Math.min(w, h) / 2 - 8; px.cx = w / 2; px.cy = h / 2;
  px.scale = px.R / Ram;
  hitList = [];

  // circular clip
  ctx.save();
  ctx.beginPath();
  ctx.arc(px.cx, px.cy, px.R, 0, 2 * Math.PI);
  ctx.clip();
  ctx.fillStyle = '#0e1420';
  ctx.fillRect(0, 0, w, h);

  drawHi(ctx, Ram);
  drawMagellanicDisks(ctx);

  // tiled 1-degree pointings over ALL sources when FOV > 1
  if (state.fov > 1.001 && !liveMove) {
    const pts = allSourceXiEta();
    if (pts) {
      const cov = coverPointings(pts.xi, pts.eta);
      for (const [cxc, cyc] of cov) {
        const [X, Y] = toPx(cxc, cyc);
        circleOutline(ctx, X, Y, 30 * px.scale, 'rgba(255,255,255,0.55)', 1.1);
      }
    }
  }
  if (F.idx.length) {
    const [xi, eta] = C.gnomonic(
      Float64Array.from(F.idx, i => D.s_lam[i]),
      Float64Array.from(F.idx, i => D.s_bet[i]), state.lam0, state.bet0);
    drawSources(ctx, xi, eta);
  } else {
    drawSources(ctx, new Float64Array(0), new Float64Array(0));
  }
  ctx.restore();

  // field rim
  circleOutline(ctx, px.cx, px.cy, px.R, UI.accent, 2.2);
  // scale reference: 15 arcmin bar in the bottom-left corner, clear of the circle
  const isBig = expander?.isExpanded();
  const sx0 = isBig ? 22 : 8;
  const bar = 15 * px.scale;
  ctx.fillStyle = UI.textDim;
  ctx.fillRect(sx0, h - 8, bar, 1.5);
  label(ctx, "15′", sx0 + bar / 2, h - 12, { align: 'center', size: isBig ? 12 : 10.5 });

  // selected object / survey-field name in the bottom-right corner
  if (state.lock?.name) {
    label(ctx, state.lock.name, w - 8, h - 8,
      { align: 'right', size: isBig ? 15 : 12.5, color: UI.text, weight: 'italic 700' });
  }

  // HI colorbar (top-left) + HI stats (top-right) — the star colorbar lives on the 3D view now
  drawHiLegend(ctx, w);
}

function drawHiLegend(ctx, w) {
  const useHvc = state.himap === 'hvc';
  const scale = useHvc ? scales.hiRed : scales.hiBlue;
  const big = expander?.isExpanded();            // larger colorbar in the enlarged view
  const lw = big ? 130 : 56, lh = big ? 13 : 7, lx = big ? 22 : 6, ly = big ? 20 : 14;
  const fs = big ? 11 : 8;
  for (let k = 0; k < lw; k++) {
    ctx.fillStyle = scale.css(k / (lw - 1));
    ctx.fillRect(lx + k, ly, 1.2, lh);
  }
  label(ctx, useHvc ? 'HVC log N(HI)' : 'log N(HI)', lx, ly - 5, { size: fs });
  if (hiStretch) {
    label(ctx, hiStretch.v0.toFixed(1), lx, ly + lh + fs + 2, { size: fs });
    label(ctx, hiStretch.v1.toFixed(1), lx + lw, ly + lh + fs + 2, { align: 'right', size: fs });
  }
  // cleanly right-justified; the enlarge button sits below this text (CSS), and the
  // expanded view keeps clear of the fixed ✕ button
  const rx = big ? w - 46 : w - 6;
  if (F.hi) {
    label(ctx, `HI mean ${Math.log10(F.hi.mean).toFixed(2)}`, rx, 11, { align: 'right', size: big ? 11 : 8.5 });
    label(ctx, `HI peak ${Math.log10(F.hi.peak).toFixed(2)}`, rx, big ? 25 : 21, { align: 'right', size: big ? 11 : 8.5 });
  } else if (state.himap === 'hvc') {
    label(ctx, 'no HVC signal', rx, 11, { align: 'right', size: big ? 11 : 8.5 });
  }
}

function drawHi(ctx, Ram) {
  const useHvc = state.himap === 'hvc';
  const overlay = state.himap === 'overlay' && D.HI_LOG_HVC;
  const n = 64;
  const grids = [[useHvc && D.HI_LOG_HVC ? D.HI_LOG_HVC : D.HI_LOG_TOTAL,
    useHvc ? scales.hiRed : scales.hiBlue, 1.0]];
  if (overlay) grids.push([D.HI_LOG_HVC, scales.hiRed, 0.55]);
  // allocation-free sampling: gnomonic tangent-plane basis in the Sgr frame,
  // rotated straight to Galactic via M = M_GAL · M_SGRᵀ
  const D2R = Math.PI / 180, R2Dg = 180 / Math.PI;
  const lr = state.lam0 * D2R, br = state.bet0 * D2R;
  const cb = Math.cos(br), sb = Math.sin(br), cl = Math.cos(lr), sl = Math.sin(lr);
  const c = [cb * cl, cb * sl, sb];
  const eXi = [-sl, cl, 0];                          // east
  const eEta = [-sb * cl, -sb * sl, cb];             // north
  const A = D.M_GAL, B = D.M_SGR;
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];       // A · Bᵀ
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
    ctx.globalAlpha = alpha * 0.55;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(off, px.cx - px.R, px.cy - px.R, 2 * px.R, 2 * px.R);
    ctx.globalAlpha = 1;
  }
}

// LMC / SMC: rough on-sky disks in place of members, when members are shown
const MAGELLANIC = [{ name: 'LMC', rDeg: 5.4 }, { name: 'SMC', rDeg: 2.6 }];
function drawMagellanicDisks(ctx) {
  if (!state.dgOn || !state.memOn) return;
  for (const mc of MAGELLANIC) {
    const i = D.DWF.name.indexOf(mc.name);
    if (i < 0) continue;
    const sepDeg = C.angSepAm(state.lam0, state.bet0, D.DWF.lam[i], D.DWF.bet[i]) / 60;
    if (sepDeg > state.fov / 2 + mc.rDeg) continue;
    const [x, y] = C.gnomonic(
      Float64Array.of(D.DWF.lam[i]), Float64Array.of(D.DWF.bet[i]), state.lam0, state.bet0);
    const [X, Y] = toPx(x[0], y[0]);
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = UI.dwarf;
    ctx.beginPath();
    ctx.arc(X, Y, mc.rDeg * 60 * px.scale, 0, 2 * Math.PI);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

// gnomonic positions of every rung-relevant source (stars, members, halo, GCs, dwarfs)
function allSourceXiEta() {
  const lam = [], bet = [];
  for (const i of F.idx) { lam.push(D.s_lam[i]); bet.push(D.s_bet[i]); }
  for (const i of F.mm) { lam.push(D.MEM.lam[i]); bet.push(D.MEM.bet[i]); }
  for (const i of F.hh ?? []) { lam.push(D.HALO.lam[i]); bet.push(D.HALO.bet[i]); }
  for (const i of F.gc) { lam.push(D.GCC.lam[i]); bet.push(D.GCC.bet[i]); }
  for (const i of F.dw) { lam.push(D.DWF.lam[i]); bet.push(D.DWF.bet[i]); }
  if (lam.length < 2) return null;
  const [xi, eta] = C.gnomonic(Float64Array.from(lam), Float64Array.from(bet),
    state.lam0, state.bet0);
  return { xi, eta };
}

function coverPointings(xi, eta, r = 30, minCov = 2, cap = 300) {
  const n = xi.length;
  if (n < minCov) return [];
  // greedy set-cover with precomputed candidate->covered lists (binned, so O(n·k))
  const nCand = Math.min(n, 400);
  const stride = Math.max(1, Math.floor(n / nCand));
  const cand = [];
  for (let i = 0; i < n; i += stride) cand.push(i);
  const covered = cand.map(c => {
    const list = [];
    for (let j = 0; j < n; j++) {
      if (Math.hypot(xi[c] - xi[j], eta[c] - eta[j]) <= r) list.push(j);
    }
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
    for (const j of covered[best]) {
      if (uncov[j]) { uncov[j] = 0; left--; }
    }
    chosen.push([xi[cand[best]], eta[cand[best]]]);
    active.delete(best);
  }
  return chosen;
}

function drawSources(ctx, xi, eta) {
  const big = F.idx.length < 100;
  const rStar = big ? 7 : 4;

  // NN match lines
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

  // quasars
  if (F.qq.length) {
    const qa = (!hilite || (hilite.type === 'kind' && hilite.kind === 1)) ? 0.9 : dimA;
    const [qx, qy] = C.gnomonic(
      Float64Array.from(F.qq, i => D.QSO.lam[i]),
      Float64Array.from(F.qq, i => D.QSO.bet[i]), state.lam0, state.bet0);
    for (let k = 0; k < F.qq.length; k++) {
      const [X, Y] = toPx(qx[k], qy[k]);
      dot(ctx, X, Y, 4, UI.accent2, qa);
      ctx.strokeStyle = '#00000088'; ctx.lineWidth = 0.8;
      ctx.stroke();
      hitList.push({
        x: X, y: Y, r: 6, pri: 0, qso: F.qq[k], lam: D.QSO.lam[F.qq[k]], bet: D.QSO.bet[F.qq[k]],
        lockInfo: { kind: 'star', id: F.qq[k], name: 'QSO' },
      });
    }
  }

  // HVC clouds intersecting the field (outline at catalog angular size)
  if (state.cloudsOn && F.cloudsInField?.length) {
    const cl = D.CLOUDS;
    const [cx2, cy2] = C.gnomonic(
      Float64Array.from(F.cloudsInField, i => cl.lam[i]),
      Float64Array.from(F.cloudsInField, i => cl.bet[i]), state.lam0, state.bet0);
    for (let k = 0; k < F.cloudsInField.length; k++) {
      const i = F.cloudsInField[k];
      const [X, Y] = toPx(cx2[k], cy2[k]);
      const r = Math.max(5, cl.radDeg[i] * 60 * px.scale);
      circleOutline(ctx, X, Y, r, UI.cloud, 1.4, [5, 4]);
      hitList.push({
        x: X, y: Y, r: Math.min(r, 30), pri: 0,
        html: `<b>${cl.name[i]}</b> · ${cl.type[i]}<br>v_LSR ${cl.vlsr[i].toFixed(0)} · v_GSR ${cl.vgsr[i].toFixed(0)} km/s<br>size ~${(cl.radDeg[i] * 2).toFixed(1)}°`,
        lam: cl.lam[i], bet: cl.bet[i],
      });
    }
  }

  // halo RR Lyrae (survey backlights; pair-rule rungs)
  if (F.hh?.length) {
    const [hx, hy] = C.gnomonic(
      Float64Array.from(F.hh, i => D.HALO.lam[i]),
      Float64Array.from(F.hh, i => D.HALO.bet[i]), state.lam0, state.bet0);
    for (let k = 0; k < F.hh.length; k++) {
      const i = F.hh[k];
      const [X, Y] = toPx(hx[k], hy[k]);
      const a = inHilite(3, null, D.HALO.dist[i]) ? 0.9 : dimA;
      dot(ctx, X, Y, 4.2, UI.halo, a);
      ctx.strokeStyle = '#00000066'; ctx.lineWidth = 0.8; ctx.stroke();
      hitList.push({
        x: X, y: Y, r: 6, pri: 0,
        html: `<b>halo ${D.HALO.clsNames[D.HALO.cls[i]] || 'RRL'}</b><br>${D.HALO.dist[i].toFixed(1)} kpc (±10%)<br>G = ${D.HALO.G[i].toFixed(2)}`,
        lam: D.HALO.lam[i], bet: D.HALO.bet[i],
        lockInfo: { kind: 'star', id: i, name: 'halo RRL', dist: D.HALO.dist[i] },
      });
    }
  }

  // dwarf members (same color as the dwarfs)
  if (F.mm.length) {
    const [mxA, myA] = C.gnomonic(
      Float64Array.from(F.mm, i => D.MEM.lam[i]),
      Float64Array.from(F.mm, i => D.MEM.bet[i]), state.lam0, state.bet0);
    for (let k = 0; k < F.mm.length; k++) {
      const i = F.mm[k];
      const [X, Y] = toPx(mxA[k], myA[k]);
      const a = inHilite(2, skey(D.MEM.name[i]), D.MEM.dist[i]);
      ctx.globalAlpha = a ? 1 : dimA;
      starGlyph(ctx, X, Y, 4.5, dwarfColorByName(D.MEM.name[i]), '#00000066');
      ctx.globalAlpha = 1;
      hitList.push({
        x: X, y: Y, r: 6, pri: 0,
        html: `<b>${D.MEM.name[i]}</b> member<br>${D.MEM.dist[i].toFixed(0)} kpc (galaxy)<br>G = ${D.MEM.G[i].toFixed(2)} · P=${D.MEM.pmem[i].toFixed(2)}`,
        lam: D.MEM.lam[i], bet: D.MEM.bet[i],
        lockInfo: { kind: 'star', id: i, name: D.MEM.name[i], dist: D.MEM.dist[i] },
      });
    }
  }

  // stream stars — one identity color per stream (matches the rung icons);
  // glyphs when sparse, fast dots when dense
  const selCode = (state.hlStream && state.streamSel) ? D.STREAM_NAMES.indexOf(state.streamSel) : -1;
  const dense = F.idx.length > 1200;
  for (let k = 0; k < F.idx.length; k++) {
    const i = F.idx[k];
    const [X, Y] = toPx(xi[k], eta[k]);
    const isSel = selCode < 0 || D.s_name_code[i] === selCode;
    const fill = isSel ? streamColor(D.s_name_code[i]) : UI.greyStar;
    const hl = inHilite(0, skey(D.streamName(i)), D.s_dist_use[i], D.streamName(i));
    ctx.globalAlpha = hl ? 1 : dimA;
    if (dense) {
      ctx.fillStyle = fill;
      ctx.fillRect(X - 1.4, Y - 1.4, 2.8, 2.8);
    } else {
      starGlyph(ctx, X, Y, rStar, fill, '#00000055');
    }
    ctx.globalAlpha = 1;
    hitList.push({
      x: X, y: Y, r: dense ? 3.5 : rStar + 2, pri: 0, star: i,
      lam: D.s_lam[i], bet: D.s_bet[i],
      lockInfo: { kind: 'star', id: i, name: D.streamName(i), dist: D.s_dist_use[i] },
    });
  }

  // GCs / dwarfs (with r_h circles) — high hover priority so crowded members don't mask them
  for (const [cat, ii, glyph, col, kk] of [[D.GCC, F.gc, hexagram, UI.gc, 'gc'], [D.DWF, F.dw, diamond, UI.dwarf, 'dwarf']]) {
    if (!ii.length) continue;
    const [ox, oy] = C.gnomonic(
      Float64Array.from(ii, i => cat.lam[i]), Float64Array.from(ii, i => cat.bet[i]),
      state.lam0, state.bet0);
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
      glyph(ctx, X, Y, s, oc, '#000000aa');
      ctx.globalAlpha = 1;
      let html = `<b>${cat.name[i]}</b><br>${cat.dist[i].toFixed(1)} kpc`;
      if (cat.mass && Number.isFinite(cat.mass[i])) html += `<br>${cat.mass[i].toExponential(1)} M☉`;
      if (cat.rh_am && Number.isFinite(cat.rh_am[i])) html += `<br>r_h = ${cat.rh_am[i].toFixed(1)}′`;
      hitList.push({
        x: X, y: Y, r: s + 5, pri: 1, html, lam: cat.lam[i], bet: cat.bet[i],
        lockInfo: { kind: kk, id: i, name: cat.name[i], dist: cat.dist[i] },
      });
    }
  }
}

function findHit(e) {
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  let best = null, bd = 1e9, bp = -1;
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
    return `<b>${D.streamName(i)}</b><br>${D.s_dist_use[i].toFixed(1)} kpc${D.s_dist_known[i] ? '' : ' (geom.)'}<br>G = ${D.s_G[i].toFixed(2)}`;
  }
  if (h.qso !== undefined) return `QSO z=${D.QSO.z[h.qso].toFixed(2)} G=${D.QSO.G[h.qso].toFixed(1)}`;
  return '';
}

// ---- pointer wiring: hover, dblclick-to-recenter, drag-to-pan -------------------------
function wirePointer() {
  let panning = false, panStart = null;

  cv.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const r = cv.getBoundingClientRect();
    panStart = {
      x: e.clientX - r.left, y: e.clientY - r.top,
      lam: state.lam0, bet: state.bet0,
    };
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
        // grab-the-sky: content follows the cursor, so the center moves opposite
        const dXi = -dx / px.scale, dEta = dy / px.scale;
        const [lo, la] = C.gnomonicInv(dXi, dEta, panStart.lam, panStart.bet);
        setField(C.wrap180(lo), la, { live: true });
        return;
      }
    }
    hover(e);
  });
  cv.addEventListener('pointerup', e => {
    if (panning) {
      panning = false; panStart = null;
      setField(state.lam0, state.bet0);
      return;
    }
    panStart = null;
  });
  cv.addEventListener('dblclick', e => {
    // dblclick on a source selects it (lock, labeled with the parent name);
    // empty space recenters — both with the damped slide
    const h = findHit(e);
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
}

function hover(e) {
  const h = findHit(e);
  if (!h) { tipEl.style.display = 'none'; cv.style.cursor = 'crosshair'; return; }
  tipEl.innerHTML = hitHtml(h);
  tipEl.style.display = 'block';
  placeTooltip(tipEl, e);
  cv.style.cursor = 'pointer';
}
