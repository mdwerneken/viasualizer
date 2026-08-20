// Field model — one computation per field/state change; every panel reads this.
// All collections FOLLOW VISIBILITY (Matt, 8-19-26): a hidden catalog contributes
// nothing to the ladder, fiber budget, histograms or stats.
import { D, quaiaInField, sortedCatInField } from './data.js';
import { state, on, emit, galField } from './state.js';
import * as C from './compute.js';
import { ladder } from './rungs.js';

export const F = {};        // current field results

export function fieldStars() {
  if (!state.streamsOn) return [];
  const r = state.fov / 2;
  let idx = C.fieldIndices(state.lam0, state.bet0, D.UG_SGR, r);
  if (state.via) idx = idx.filter(i => D.viaMask[i]);
  if (state.hide) idx = idx.filter(i => D.s_G[i] >= state.glo && D.s_G[i] <= state.ghi);
  return idx;
}

export function qsoInField() {
  if (!D.QSO || !state.qsoOn) return [];
  let q = quaiaInField(state.lam0, state.bet0, state.fov / 2);
  if (state.hide) q = q.filter(i => D.QSO.G[i] >= state.glo && D.QSO.G[i] <= state.ghi);
  return q;
}

export function haloInField() {
  if (!D.HALO || !state.haloOn) return [];
  let h = sortedCatInField(D.HALO, state.lam0, state.bet0, state.fov / 2);
  if (state.hide) h = h.filter(i => D.HALO.G[i] >= state.glo && D.HALO.G[i] <= state.ghi);
  return h;
}

// dwarf: whether a dwarf passes the "Via only" placeholder cut (< 300 kpc)
export function dwarfViaOk(i) {
  return !state.viaDwarfs || (Number.isFinite(D.DWF.dist[i]) && D.DWF.dist[i] < 300);
}

// active cloud indices under the current filter (VHVC = |vLSR| >= 200 km/s)
export function activeClouds() {
  if (!D.CLOUDS || !state.cloudsOn) return [];
  const cl = D.CLOUDS, out = [];
  for (let i = 0; i < cl.name.length; i++) {
    if (state.cloudFilter === 'compact' && cl.type[i] !== 'CHVC' && cl.type[i] !== 'UCHVC') continue;
    if (state.cloudFilter === 'vhvc' && !(Math.abs(cl.vlsr[i]) >= 200)) continue;
    out.push(i);
  }
  return out;
}

export function memInField() {
  // members ride on the dwarfs checkbox AND their own sub-checkbox
  if (!D.MEM || !state.dgOn || !state.memOn) return [];
  let m = C.fieldIndices(state.lam0, state.bet0, D.MEM.UG, state.fov / 2);
  if (state.viaDwarfs) m = m.filter(i => Number.isFinite(D.MEM.dist[i]) && D.MEM.dist[i] < 300);
  if (state.hide) {
    m = m.filter(i => !Number.isFinite(D.MEM.G[i]) ||
      (D.MEM.G[i] >= state.glo && D.MEM.G[i] <= state.ghi));
  }
  return m;
}

// combined source table (stars + members + halo RRL + quasars)
function buildSources(idx, mm, hh, qq) {
  const n = idx.length + mm.length + hh.length + qq.length;
  const lam = new Float64Array(n), bet = new Float64Array(n), dist = new Float64Array(n);
  const G = new Float64Array(n), Vr = new Float64Array(n);
  const kind = new Uint8Array(n);    // 0 star, 1 qso, 2 member, 3 halo
  let k = 0;
  for (const i of idx) {
    lam[k] = D.s_lam[i]; bet[k] = D.s_bet[i]; dist[k] = D.s_dist_use[i];
    G[k] = D.s_G[i]; Vr[k] = D.s_Vr[i]; kind[k] = 0; k++;
  }
  for (const i of mm) {
    lam[k] = D.MEM.lam[i]; bet[k] = D.MEM.bet[i]; dist[k] = D.MEM.dist[i];
    G[k] = D.MEM.G[i]; Vr[k] = NaN; kind[k] = 2; k++;
  }
  for (const i of hh) {
    lam[k] = D.HALO.lam[i]; bet[k] = D.HALO.bet[i]; dist[k] = D.HALO.dist[i];
    G[k] = D.HALO.G[i]; Vr[k] = NaN; kind[k] = 3; k++;
  }
  for (const i of qq) {
    lam[k] = D.QSO.lam[i]; bet[k] = D.QSO.bet[i]; dist[k] = Infinity;
    G[k] = D.QSO.G[i]; Vr[k] = NaN; kind[k] = 1; k++;
  }
  return { lam, bet, dist, G, Vr, kind, n };
}

export function recompute(opts = {}) {
  const t0 = performance.now();
  const [l0, b0] = galField();
  F.l0 = l0; F.b0 = b0;
  const vIcrs = C.matTVec(D.M_SGR, C.unitVector1(state.lam0, state.bet0));
  const [ra, dec] = C.lonlatOf(vIcrs);
  F.ra = (ra + 360) % 360; F.dec = dec;
  F.vMMT = C.visibleFrom(D.SITES['MMT (Arizona)'], dec, D.ALT_MIN);
  F.vMag = C.visibleFrom(D.SITES['Magellan (Chile)'], dec, D.ALT_MIN);

  F.idx = fieldStars();
  F.mm = memInField();
  F.hh = haloInField();
  F.qq = qsoInField();
  F.gc = state.gcOn ? C.fieldIndices(state.lam0, state.bet0, D.GCC.UG, state.fov / 2) : [];
  F.clouds = activeClouds();
  // clouds intersecting the field: center within (field radius + cloud radius)
  F.cloudsInField = !F.clouds.length ? [] : (() => {
    const cl = D.CLOUDS, out = [];
    for (const i of F.clouds) {
      const sep = C.angSepAm(state.lam0, state.bet0, cl.lam[i], cl.bet[i]) / 60;
      if (sep <= state.fov / 2 + cl.radDeg[i]) out.push(i);
    }
    return out;
  })();
  F.dw = state.dgOn
    ? C.fieldIndices(state.lam0, state.bet0, D.DWF.UG, state.fov / 2).filter(dwarfViaOk)
    : [];
  F.src = buildSources(F.idx, F.mm, F.hh, F.qq);

  // NN over all sources: exact brute force up to 3000 (matches v1 star-for-star),
  // gnomonic grid NN beyond that (large 3-5 degree fields)
  if (F.src.n >= 2) {
    if (F.src.n <= 3000) {
      const uv = C.unitVectors(F.src.lam, F.src.bet);
      F.nn = C.nearestNeighbors(uv);
    } else {
      const [xi, eta] = C.gnomonic(F.src.lam, F.src.bet, state.lam0, state.bet0);
      F.nn = C.nearestNeighborsGrid(xi, eta);
    }
  } else F.nn = null;

  // HI stats (linear grid by active map)
  const lin = state.himap === 'hvc' && D.HI_LIN_HVC ? D.HI_LIN_HVC : D.HI_LIN_TOTAL;
  F.hi = C.hiStatsInField(lin, D.HI_GRID_L, D.HI_GRID_B, D.HI_NY, D.HI_NX, l0, b0, state.fov / 2);

  // ladder + fiber budget (both follow visibility)
  F.ladder = ladder({
    idx: F.idx, mm: F.mm, hh: F.hh, gc: F.gc, dw: F.dw,
    nQso: F.qq.length, gLim: state.ghi,
  });
  const nTargets = F.idx.length + F.mm.length + F.hh.length + F.qq.length;
  F.fibers = {
    targets: nTargets,
    stars: F.idx.length, members: F.mm.length, halo: F.hh.length, qsos: F.qq.length,
    positioners: 576, science: 540, boombox: 36,
    spare: Math.max(0, 540 - nTargets),
    over: Math.max(0, nTargets - 540),
  };
  // per-stream composition
  const comp = new Map();
  for (const i of F.idx) {
    const nm = D.streamName(i);
    comp.set(nm, (comp.get(nm) ?? 0) + 1);
  }
  F.comp = [...comp.entries()].sort((a, b) => b[1] - a[1]);
  // dwarf-member composition (per galaxy), for the collapsed dwarf summary line
  const mcomp = new Map();
  for (const i of F.mm) mcomp.set(D.MEM.name[i], (mcomp.get(D.MEM.name[i]) ?? 0) + 1);
  F.memComp = mcomp;
  F.computeMs = performance.now() - t0;
  emit('fieldmodel', opts);
}

export function initFieldModel() {
  on('field', (opts) => recompute(opts ?? {}));
  on('ui', () => recompute({}));
  on('quaia', () => recompute({}));
  on('halo', () => recompute({}));
  recompute({});
}
