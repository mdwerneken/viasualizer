// Field model — one computation per field/state change; every panel reads this.
// All collections FOLLOW VISIBILITY (Matt, 8-19-26): a hidden catalog contributes
// nothing to the ladder, fiber budget, histograms or stats.
// v3: computeField() is a pure function of (lam, bet, fov) + the visibility state, so
// field LISTS can be scored in the background with exactly the live rules.
import { D, quaiaInField, sortedCatInField, bgGridFor, gridStats, hiSpectrumInField } from './data.js';
import { state, on, emit, galField } from './state.js';
import * as C from './compute.js';
import { ladder } from './rungs.js';

export const F = {};        // current field results

// source kinds (finder glyphs, histograms, fiber budget)
export const KIND = { STAR: 0, QSO: 1, MEM: 2, HALO: 3, KG: 4, BHB: 5, KEP: 6, MEM2: 7 };

const magOk = (g) => !state.hide || !Number.isFinite(g) || (g >= state.glo && g <= state.ghi);

export function fieldStars(lam0, bet0, r) {
  if (!state.streamsOn) return [];
  let idx = C.fieldIndices(lam0, bet0, D.UG_SGR, r);
  if (state.via) idx = idx.filter(i => D.viaMask[i]);
  if (state.hide) idx = idx.filter(i => D.s_G[i] >= state.glo && D.s_G[i] <= state.ghi);
  return idx;
}

function bigCatInField(cat, onFlag, lam0, bet0, r) {
  if (!cat || !onFlag) return [];
  let h = sortedCatInField(cat, lam0, bet0, r);
  if (state.hide) h = h.filter(i => cat.G[i] >= state.glo && cat.G[i] <= state.ghi);
  return h;
}

// dwarf: whether a dwarf passes the "Via only" placeholder cut (< 300 kpc)
export function dwarfViaOk(i) {
  return !state.viaDwarfs || (Number.isFinite(D.DWF.dist[i]) && D.DWF.dist[i] < 300);
}

// active cloud indices under the current filters
export function activeClouds() {
  if (!D.CLOUDS || !state.cloudsOn) return [];
  const cl = D.CLOUDS, out = [];
  const srcOn = [state.cloudHipass, state.cloudAlfalfa, state.cloudGass];
  for (let i = 0; i < cl.name.length; i++) {
    if (!srcOn[cl.src[i]]) continue;
    if (state.cloudFilter === 'compact' && cl.type[i] !== 'CHVC' && cl.type[i] !== 'UCHVC') continue;
    if (state.cloudFilter === 'vhvc' && !(Math.abs(cl.vlsr[i]) >= 200)) continue;
    out.push(i);
  }
  return out;
}

export function memInField(lam0, bet0, r) {
  // members ride on the dwarfs checkbox AND their own sub-checkbox
  if (!D.MEM || !state.dgOn || !state.memOn) return [];
  let m = C.fieldIndices(lam0, bet0, D.MEM.UG, r);
  if (state.viaDwarfs) m = m.filter(i => Number.isFinite(D.MEM.dist[i]) && D.MEM.dist[i] < 300);
  if (state.hide) m = m.filter(i => magOk(D.MEM.G[i]));
  return m;
}

export function mem2InField(lam0, bet0, r) {
  if (!D.MEM2 || !state.dgOn || !state.mem2On) return [];
  let m = sortedCatInField(D.MEM2, lam0, bet0, r);
  if (state.viaDwarfs) m = m.filter(i => Number.isFinite(D.MEM2.dist[i]) && D.MEM2.dist[i] < 300);
  if (state.hide) m = m.filter(i => magOk(D.MEM2.G[i]));
  return m;
}

// combined source table (all backlight kinds)
function buildSources(parts) {
  let n = 0;
  for (const p of parts) n += p.idx.length;
  const lam = new Float64Array(n), bet = new Float64Array(n), dist = new Float64Array(n);
  const G = new Float64Array(n), Vr = new Float64Array(n);
  const kind = new Uint8Array(n), ref = new Int32Array(n);
  let k = 0;
  for (const p of parts) {
    const c = p.cat;
    for (const i of p.idx) {
      lam[k] = c.lam[i]; bet[k] = c.bet[i];
      dist[k] = p.kind === KIND.QSO ? Infinity : (p.dist ? p.dist[i] : c.dist[i]);
      G[k] = c.G[i]; Vr[k] = p.vr ? p.vr[i] : NaN; kind[k] = p.kind; ref[k] = i; k++;
    }
  }
  return { lam, bet, dist, G, Vr, kind, ref, n };
}

// pure field computation: everything a panel or a list score needs.
// opts.light skips the O(n^2) nearest neighbours and cloud overlap (list scoring).
export function computeField(lam0, bet0, fov, opts = {}) {
  const r = fov / 2;
  const R = {};
  const [l0, b0] = C.convPoint(D.M_SGR, D.M_GAL, lam0, bet0);
  R.l0 = l0; R.b0 = b0;
  const vIcrs = C.matTVec(D.M_SGR, C.unitVector1(lam0, bet0));
  const [ra, dec] = C.lonlatOf(vIcrs);
  R.ra = (ra + 360) % 360; R.dec = dec;
  R.vMMT = C.visibleFrom(D.SITES['MMT (Arizona)'], dec, D.ALT_MIN);
  R.vMag = C.visibleFrom(D.SITES['Magellan (Chile)'], dec, D.ALT_MIN);

  R.idx = fieldStars(lam0, bet0, r);
  R.mm = memInField(lam0, bet0, r);
  R.mm2 = mem2InField(lam0, bet0, r);
  R.hh = bigCatInField(D.HALO, state.haloOn, lam0, bet0, r);
  R.kg = bigCatInField(D.KG, state.kgOn, lam0, bet0, r);
  R.bhb = bigCatInField(D.BHB, state.bhbOn, lam0, bet0, r);
  R.kep = bigCatInField(D.KEP, state.kepOn, lam0, bet0, r);
  R.qq = (D.QSO && state.qsoOn) ? bigCatInField(D.QSO, true, lam0, bet0, r) : [];
  R.gc = state.gcOn ? C.fieldIndices(lam0, bet0, D.GCC.UG, r) : [];
  R.dw = state.dgOn ? C.fieldIndices(lam0, bet0, D.DWF.UG, r).filter(dwarfViaOk) : [];
  // Via planned pointings whose 1-degree footprint overlaps this field
  R.via = [];
  if (D.VIA && state.viaOn) {
    const cand = C.fieldIndices(lam0, bet0, D.VIA.UG, r + 0.5);
    for (const i of cand) if (state.viaSvy[D.VIA.svy[i]]) R.via.push(i);
  }
  R.sight = {};                       // { setKey: [indices in field] }
  for (const k of state.sightKeys ?? []) if (D.SIGHT?.[k]) {
    const S = D.SIGHT[k];
    // extended objects (O'Neill+26 clouds carry an angular radius): in the field when the
    // footprint's circle-equivalent overlaps it, not only when the centroid does
    R.sight[k] = S.rad ? [...S.name.keys()].filter(i => C.angSepAm(lam0, bet0, S.lam[i], S.bet[i]) / 60 <= r + S.rad[i])
      : C.fieldIndices(lam0, bet0, S.UG, r);
  }

  R.src = buildSources([
    { cat: D, kind: KIND.STAR, idx: R.idx, dist: D.s_dist_use, vr: D.s_Vr, },
    { cat: D.MEM, kind: KIND.MEM, idx: R.mm },
    { cat: D.MEM2 ?? { lam: [], bet: [], G: [], dist: [] }, kind: KIND.MEM2, idx: R.mm2 },
    { cat: D.HALO ?? {}, kind: KIND.HALO, idx: R.hh },
    { cat: D.KG ?? {}, kind: KIND.KG, idx: R.kg },
    { cat: D.BHB ?? {}, kind: KIND.BHB, idx: R.bhb },
    { cat: D.KEP ?? {}, kind: KIND.KEP, idx: R.kep },
    { cat: D.QSO ?? {}, kind: KIND.QSO, idx: R.qq },
  ].map(p => (p.kind === KIND.STAR ? { ...p, cat: { lam: D.s_lam, bet: D.s_bet, G: D.s_G, dist: D.s_dist_use } } : p)));

  if (!opts.light) {
    R.clouds = activeClouds();
    R.cloudsInField = !R.clouds.length ? [] : (() => {
      const cl = D.CLOUDS, out = [];
      for (const i of R.clouds) {
        const sep = C.angSepAm(lam0, bet0, cl.lam[i], cl.bet[i]) / 60;
        if (sep <= r + cl.radDeg[i]) out.push(i);
      }
      return out;
    })();
    // NN over all sources: exact brute force up to 3000, gnomonic grid NN beyond
    if (R.src.n >= 2) {
      if (R.src.n <= 3000) R.nn = C.nearestNeighbors(C.unitVectors(R.src.lam, R.src.bet));
      else {
        const [xi, eta] = C.gnomonic(R.src.lam, R.src.bet, lam0, bet0);
        R.nn = C.nearestNeighborsGrid(xi, eta);
      }
    } else R.nn = null;
  } else { R.clouds = []; R.cloudsInField = []; R.nn = null; }

  // gas + dust along the sightline (5' grids; means are of the linear quantity)
  const hvcMode = state.himap === 'hvc' || state.himap === 'vlsr' || state.himap === 'vgsr' || state.himap === 'overlay';
  R.hiTotal = gridStats(D.MAPS.total, l0, b0, r, true);
  R.hi = hvcMode ? gridStats(D.MAPS.hvc, l0, b0, r, true) : R.hiTotal;
  R.vel = (['vlsr', 'vgsr', 'vmean', 'vdisp'].includes(state.himap) && D.MAPS[state.himap]) ? gridStats(D.MAPS[state.himap], l0, b0, r, false) : null;
  R.spec = D.HICUBE ? hiSpectrumInField(l0, b0, r) : null;
  R.ebv = gridStats(D.MAPS.sfd, l0, b0, r, true);
  R.e3d = (D.DUST3D && state.himap?.startsWith('e')) ? gridStats(bgGridFor(state.himap).gal, l0, b0, r, true) : null;

  // ladder + fiber budget (both follow visibility)
  const tracers = [];
  if (R.hh.length) tracers.push({ cat: D.HALO, idx: R.hh, kind: 'halo', label: 'halo RRL' });
  if (R.kg.length) tracers.push({ cat: D.KG, idx: R.kg, kind: 'kg', label: 'K giants' });
  if (R.bhb.length) tracers.push({ cat: D.BHB, idx: R.bhb, kind: 'bhb', label: 'BHB' });
  R.ladder = ladder({
    idx: R.idx, mm: R.mm, mm2: R.mm2, gc: R.gc, dw: R.dw, tracers,
    nQso: R.qq.length, gLim: state.ghi,
  });
  const nTargets = R.src.n;
  R.fibers = {
    targets: nTargets,
    stars: R.idx.length, members: R.mm.length + R.mm2.length, halo: R.hh.length,
    kg: R.kg.length, bhb: R.bhb.length, kep: R.kep.length, qsos: R.qq.length,
    positioners: 576, science: 540, boombox: 36,
    spare: Math.max(0, 540 - nTargets),
    over: Math.max(0, nTargets - 540),
  };
  // per-stream composition
  const comp = new Map();
  for (const i of R.idx) {
    const nm = D.streamName(i);
    comp.set(nm, (comp.get(nm) ?? 0) + 1);
  }
  R.comp = [...comp.entries()].sort((a, b) => b[1] - a[1]);
  // dwarf-member composition (per galaxy), both member catalogs
  const mcomp = new Map();
  for (const i of R.mm) mcomp.set(D.MEM.name[i], (mcomp.get(D.MEM.name[i]) ?? 0) + 1);
  for (const i of R.mm2) mcomp.set(D.MEM2.name[i], (mcomp.get(D.MEM2.name[i]) ?? 0) + 1);
  R.memComp = mcomp;
  return R;
}

export function recompute(opts = {}) {
  const t0 = performance.now();
  const R = computeField(state.lam0, state.bet0, state.fov, opts.live ? { } : {});
  for (const k of Object.keys(F)) delete F[k];
  Object.assign(F, R);
  F.computeMs = performance.now() - t0;
  emit('fieldmodel', opts);
}

export function initFieldModel() {
  on('field', (opts) => recompute(opts ?? {}));
  on('ui', () => recompute({}));
  on('lists', () => recompute({}));      // active field lists changed (Via pointings in field follow them)
  on('catalog', () => recompute({}));      // any lazy catalog arrived
  recompute({});
}
