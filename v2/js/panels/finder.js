// Finder chart — a clean circular cutout of the field (gnomonic projection, arcmin).
// HI background clipped to the circle, star glyphs, GC/dwarf/member/QSO markers,
// hover readout, click-to-recenter, tiled 1-degree pointings when FOV > 1.
import { D } from '../data.js';
import { state, setField, on } from '../state.js';
import { F } from '../fieldmodel.js';
import * as C from '../compute.js';
import { UI, scales } from '../colors.js';
import { fitCanvas, starGlyph, hexagram, diamond, dot, circleOutline, label } from './canvas2d.js';

let cv, wrap, tipEl;
let px = { R: 0, cx: 0, cy: 0, scale: 1 };   // arcmin -> px mapping
let hitList = [];                             // for hover/click

let liveMove = false;
export function initFinder(container) {
  wrap = container;
  cv = document.createElement('canvas');
  cv.className = 'finder-canvas';
  container.appendChild(cv);
  tipEl = document.getElementById('tooltip2d');
  on('fieldmodel', (opts) => { liveMove = !!opts?.live; draw(); });
  new ResizeObserver(draw).observe(container);
  cv.addEventListener('pointermove', hover);
  cv.addEventListener('pointerleave', () => { tipEl.style.display = 'none'; });
  cv.addEventListener('click', click);
}

function toPx(xiAm, etaAm) {
  return [px.cx + xiAm * px.scale, px.cy - etaAm * px.scale];
}
function fromPx(x, y) {
  return [(x - px.cx) / px.scale, -(y - px.cy) / px.scale];
}

function colorFor(kindArrs, i) {
  // colour stars by active mode (dist / mag), fall back to accent
  if (state.mode === 'mag') {
    const t = (kindArrs.G[i] - state.glo) / Math.max(1e-9, state.ghi - state.glo);
    return scales.mag.css(Math.max(0, Math.min(1, t)));
  }
  const t = (kindArrs.d[i] - D.DIST_MIN) / (D.DIST_MAX - D.DIST_MIN);
  return scales.dist.css(Math.max(0, Math.min(1, t)));
}

function draw() {
  const w = wrap.clientWidth;
  if (!w) return;
  const h = w;                                    // square, circle inscribed
  const ctx = fitCanvas(cv, w, h);
  ctx.clearRect(0, 0, w, h);
  const Ram = state.fov / 2 * 60;                 // field radius in arcmin
  px.R = w / 2 - 8; px.cx = w / 2; px.cy = h / 2;
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

  // tiled 1-degree pointings when FOV > 1
  if (state.fov > 1.001 && F.idx.length) {
    const [xi, eta] = C.gnomonic(
      Float64Array.from(F.idx, i => D.s_lam[i]),
      Float64Array.from(F.idx, i => D.s_bet[i]), state.lam0, state.bet0);
    if (!liveMove) {
      const cov = coverPointings(xi, eta);
      for (const [cxc, cyc] of cov) {
        const [X, Y] = toPx(cxc, cyc);
        circleOutline(ctx, X, Y, 30 * px.scale, 'rgba(150,160,180,0.35)', 1);
      }
    }
    drawSources(ctx, xi, eta);
  } else if (F.idx.length) {
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
  // scale tick: 10 arcmin bar
  const bar = 10 * px.scale;
  ctx.fillStyle = UI.textDim;
  ctx.fillRect(px.cx - bar / 2, h - 6, bar, 1.5);
  label(ctx, "10′", px.cx, h - 10, { align: 'center', size: 9 });
  // colour legend for the active star-colour scale (corner, outside the circle)
  if (state.mode === 'dist' || state.mode === 'mag') {
    const scale = state.mode === 'dist' ? scales.dist : scales.mag;
    const lo = state.mode === 'dist' ? D.DIST_MIN : state.glo;
    const hi = state.mode === 'dist' ? D.DIST_MAX : state.ghi;
    const lw = 56, lh = 7, lx = 6, ly = 14;
    for (let k = 0; k < lw; k++) {
      ctx.fillStyle = scale.css(k / (lw - 1));
      ctx.fillRect(lx + k, ly, 1.2, lh);
    }
    label(ctx, state.mode === 'dist' ? 'dist [kpc]' : 'G', lx, ly - 4, { size: 8 });
    label(ctx, lo.toFixed(0), lx, ly + lh + 9, { size: 8 });
    label(ctx, hi.toFixed(0), lx + lw, ly + lh + 9, { align: 'right', size: 8 });
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
    const uvXi = new Float64Array(F.src.n), uvEta = new Float64Array(F.src.n);
    const [sxi, seta] = C.gnomonic(F.src.lam, F.src.bet, state.lam0, state.bet0);
    ctx.strokeStyle = 'rgba(224,82,82,0.45)';
    ctx.lineWidth = 0.7;
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
    const [qx, qy] = C.gnomonic(
      Float64Array.from(F.qq, i => D.QSO.lam[i]),
      Float64Array.from(F.qq, i => D.QSO.bet[i]), state.lam0, state.bet0);
    for (let k = 0; k < F.qq.length; k++) {
      const [X, Y] = toPx(qx[k], qy[k]);
      dot(ctx, X, Y, 4, UI.accent2, 0.9);
      ctx.strokeStyle = '#00000088'; ctx.lineWidth = 0.8;
      ctx.stroke();
      hitList.push({ x: X, y: Y, r: 6, qso: F.qq[k], lam: D.QSO.lam[F.qq[k]], bet: D.QSO.bet[F.qq[k]] });
    }
  }

  // halo RR Lyrae (survey backlights; ~10% distances, excluded from rungs)
  if (F.hh?.length) {
    const [hx, hy] = C.gnomonic(
      Float64Array.from(F.hh, i => D.HALO.lam[i]),
      Float64Array.from(F.hh, i => D.HALO.bet[i]), state.lam0, state.bet0);
    for (let k = 0; k < F.hh.length; k++) {
      const i = F.hh[k];
      const [X, Y] = toPx(hx[k], hy[k]);
      dot(ctx, X, Y, 4.2, UI.halo, 0.9);
      ctx.strokeStyle = '#00000066'; ctx.lineWidth = 0.8; ctx.stroke();
      hitList.push({
        x: X, y: Y, r: 6,
        html: `<b>halo ${D.HALO.clsNames[D.HALO.cls[i]] || 'RRL'}</b><br>${D.HALO.dist[i].toFixed(1)} kpc (±10%)<br>G = ${D.HALO.G[i].toFixed(2)}`,
        lam: D.HALO.lam[i], bet: D.HALO.bet[i],
      });
    }
  }

  // dwarf members
  if (F.mm.length) {
    const [mxA, myA] = C.gnomonic(
      Float64Array.from(F.mm, i => D.MEM.lam[i]),
      Float64Array.from(F.mm, i => D.MEM.bet[i]), state.lam0, state.bet0);
    for (let k = 0; k < F.mm.length; k++) {
      const i = F.mm[k];
      const [X, Y] = toPx(mxA[k], myA[k]);
      starGlyph(ctx, X, Y, 4.5, UI.member, '#00000066');
      hitList.push({ x: X, y: Y, r: 6, html: `<b>${D.MEM.name[i]}</b> member<br>${D.MEM.dist[i].toFixed(0)} kpc (galaxy)<br>G = ${D.MEM.G[i].toFixed(2)} · P=${D.MEM.pmem[i].toFixed(2)}`, lam: D.MEM.lam[i], bet: D.MEM.bet[i] });
    }
  }

  // stream stars — glyphs when sparse, fast dots when dense
  const selCode = state.stream ? D.STREAM_NAMES.indexOf(state.stream) : -1;
  const dArr = { d: Float64Array.from(F.idx, i => D.s_dist_use[i]), G: Float64Array.from(F.idx, i => D.s_G[i]) };
  const dense = F.idx.length > 1200;
  for (let k = 0; k < F.idx.length; k++) {
    const i = F.idx[k];
    const [X, Y] = toPx(xi[k], eta[k]);
    const isSel = selCode < 0 || D.s_name_code[i] === selCode;
    const fill = isSel ? colorFor(dArr, k) : UI.greyStar;
    if (dense) {
      ctx.fillStyle = fill;
      ctx.fillRect(X - 1.4, Y - 1.4, 2.8, 2.8);
    } else {
      starGlyph(ctx, X, Y, rStar, fill, '#00000055');
    }
    hitList.push({
      x: X, y: Y, r: dense ? 3.5 : rStar + 2, star: i,
      lam: D.s_lam[i], bet: D.s_bet[i],
    });
  }

  // GCs / dwarfs (with r_h circles)
  for (const [cat, ii, glyph, col] of [[D.GCC, F.gc, hexagram, UI.gc], [D.DWF, F.dw, diamond, UI.dwarf]]) {
    if (!ii.length) continue;
    const [ox, oy] = C.gnomonic(
      Float64Array.from(ii, i => cat.lam[i]), Float64Array.from(ii, i => cat.bet[i]),
      state.lam0, state.bet0);
    for (let k = 0; k < ii.length; k++) {
      const i = ii[k];
      const [X, Y] = toPx(ox[k], oy[k]);
      if (cat.rh_am && Number.isFinite(cat.rh_am[i]) && cat.rh_am[i] > 0.3) {
        circleOutline(ctx, X, Y, cat.rh_am[i] * px.scale, col + '99', 1, [3, 3]);
      }
      let s = 9;
      if (cat.mass && Number.isFinite(cat.mass[i]) && cat.mass[i] > 0) {
        s = 8 + 6 * Math.max(0, Math.min(1, (Math.log10(Math.max(cat.mass[i], 1e2)) - 3) / 6));
      }
      glyph(ctx, X, Y, s, col, '#000000aa');
      let html = `<b>${cat.name[i]}</b><br>${cat.dist[i].toFixed(1)} kpc`;
      if (cat.mass && Number.isFinite(cat.mass[i])) html += `<br>${cat.mass[i].toExponential(1)} M☉`;
      if (cat.rh_am && Number.isFinite(cat.rh_am[i])) html += `<br>r_h = ${cat.rh_am[i].toFixed(1)}′`;
      hitList.push({ x: X, y: Y, r: s + 3, html, lam: cat.lam[i], bet: cat.bet[i] });
    }
  }
}

function findHit(e) {
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  let best = null, bd = 1e9;
  for (const h of hitList) {
    const d = Math.hypot(h.x - x, h.y - y);
    if (d <= h.r && d < bd) { best = h; bd = d; }
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

function hover(e) {
  const h = findHit(e);
  if (!h) { tipEl.style.display = 'none'; cv.style.cursor = 'crosshair'; return; }
  tipEl.innerHTML = hitHtml(h);
  tipEl.style.display = 'block';
  tipEl.style.left = (e.clientX + 12) + 'px';
  tipEl.style.top = (e.clientY + 10) + 'px';
  cv.style.cursor = 'pointer';
}

function click(e) {
  const h = findHit(e);
  if (h) { setField(h.lam, h.bet); return; }
  // click empty space in the circle -> recenter there
  const r = cv.getBoundingClientRect();
  const [xiAm, etaAm] = fromPx(e.clientX - r.left, e.clientY - r.top);
  if (Math.hypot(xiAm, etaAm) <= state.fov / 2 * 60) {
    const [lo, la] = C.gnomonicInv(xiAm, etaAm, state.lam0, state.bet0);
    setField(C.wrap180(lo), la);
  }
}
