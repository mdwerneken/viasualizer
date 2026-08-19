// Data layer — loads the same viasual/data/ files v1 uses and derives geometry.
import { loadNpz } from './npz.js';
import { unitVectors, matVec } from './compute.js';

export const D = {};   // global data store

function catGeom(cat, SUN_GC, RG) {
  cat.UG = unitVectors(cat.lam, cat.bet);
  if (cat.dist) {
    const n = cat.lam.length;
    cat.X = new Float64Array(n); cat.Y = new Float64Array(n); cat.Z = new Float64Array(n);
    const ug = unitVectors(cat.l, cat.b);
    for (let i = 0; i < n; i++) {
      const d = matVec(RG, [ug[3 * i], ug[3 * i + 1], ug[3 * i + 2]]);
      cat.X[i] = SUN_GC[0] + d[0] * cat.dist[i];
      cat.Y[i] = SUN_GC[1] + d[1] * cat.dist[i];
      cat.Z[i] = SUN_GC[2] + d[2] * cat.dist[i];
    }
  }
  return cat;
}

function catFromJson(raw) {
  const cat = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v[0] === 'string') cat[k] = v.map(x => x ?? '');
    else cat[k] = Float64Array.from(v, x => (x === null ? NaN : x));
  }
  return cat;
}

export async function loadCore(dataDir, onProgress = () => {}) {
  const t0 = performance.now();
  const [meta, stars, hi, gcsRaw, dwarfsRaw, members] = await Promise.all([
    fetch(`${dataDir}/meta.json`).then(r => r.json()),
    loadNpz(`${dataDir}/stars.npz`).then(x => { onProgress('stars'); return x; }),
    loadNpz(`${dataDir}/hi.npz`).then(x => { onProgress('HI map'); return x; }),
    fetch(`${dataDir}/gcs.json`).then(r => r.json()),
    fetch(`${dataDir}/dwarfs.json`).then(r => r.json()),
    loadNpz(`${dataDir}/members.npz`).then(x => { onProgress('dwarf members'); return x; }),
  ]);

  Object.assign(D, meta);           // M_GAL, M_SGR, R_ICRS2GC, RG_GAL2GC, SUN_GC, constants...

  // stars
  for (const [k, v] of Object.entries(stars)) D['s_' + k] = v.data;
  D.N = D.s_X.length;
  D.UG_SGR = unitVectors(D.s_lam, D.s_bet);
  D.streamName = i => D.STREAM_NAMES[D.s_name_code[i]];
  D.VIA_SET = new Set(D.VIA_STREAMS);
  D.viaMask = new Uint8Array(D.N);
  for (let i = 0; i < D.N; i++) D.viaMask[i] = D.VIA_SET.has(D.STREAM_NAMES[D.s_name_code[i]]) ? 1 : 0;

  // HI grids (plate carree, rows b from -90, cols l from -180)
  D.HI_STEP = hi.hi_step.data[0];
  D.HI_LOG_TOTAL = hi.log_total.data;
  [D.HI_NY, D.HI_NX] = hi.log_total.shape;
  D.HI_LOG_HVC = hi.log_hvc ? hi.log_hvc.data : null;
  D.HI_LIN_TOTAL = Float32Array.from(D.HI_LOG_TOTAL, v => 10 ** v);
  D.HI_LIN_HVC = D.HI_LOG_HVC ? Float32Array.from(D.HI_LOG_HVC, v => 10 ** v) : null;
  D.HI_GRID_L = Float64Array.from({ length: D.HI_NX }, (_, i) => -180 + D.HI_STEP * i);
  D.HI_GRID_B = Float64Array.from({ length: D.HI_NY }, (_, i) => -90 + D.HI_STEP * i);
  D.HI_SGR_TOTAL = hi.sgr_total.data;           // shape (61, 361): [bet, lam]
  D.HI_SGR_SHAPE = hi.sgr_total.shape;
  D.HI_SGR_HVC = hi.sgr_hvc ? hi.sgr_hvc.data : null;
  D.HI_SGR_LAM = hi.sgr_lam.data;
  D.HI_SGR_BET = hi.sgr_bet.data;

  // object catalogs
  D.GCC = catGeom(catFromJson(gcsRaw), D.SUN_GC, D.RG_GAL2GC);
  D.DWF = catGeom(catFromJson(dwarfsRaw), D.SUN_GC, D.RG_GAL2GC);
  const gal_names = members.gal_names.data;
  const mn = members.lam.data.length;
  D.MEM = catGeom({
    name: Array.from(members.gal_code.data, c => gal_names[c]),
    lam: members.lam.data, bet: members.bet.data,
    l: members.l.data, b: members.b.data,
    dist: members.dist.data, G: members.G.data, pmem: members.pmem.data,
  }, D.SUN_GC, D.RG_GAL2GC);
  D.QSO = null;   // lazy

  // survey cones: sky regions the survey will tile (Kepler from meta; M31/M82 added
  // 8-18-26 per Matt — likely tiled Via targets). Radii are placeholders, easy to edit.
  D.CONES = [
    { name: 'Kepler', l: D.KEPLER_LB[0], b: D.KEPLER_LB[1], r: D.KEPLER_R, color: '#4caf50', len: 15 },
    { name: 'M31', l: 121.17, b: -21.57, r: 10.0, color: '#5a8fd4', len: 15 },
    { name: 'M82', l: 141.41, b: 40.57, r: 5.0, color: '#c77bd8', len: 15 },
  ];

  D.loadMs = performance.now() - t0;
  return D;
}

export async function loadQuaia(dataDir) {
  const q = await loadNpz(`${dataDir}/quaia.npz`);
  D.QSO = { lam: q.lam.data, bet: q.bet.data, G: q.G.data, z: q.z.data };
  D.QSO.UG = unitVectors(D.QSO.lam, D.QSO.bet);
  // bet-sorted index so field queries only dot-test a latitude band
  const n = D.QSO.lam.length;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const bet = D.QSO.bet;
  D.QSO.order = order.sort((a, b) => bet[a] - bet[b]);
  D.QSO.sortedBet = Float32Array.from(D.QSO.order, i => bet[i]);
  return n;
}

export async function loadHalo(dataDir) {
  try {
    const h = await loadNpz(`${dataDir}/halo.npz`);
    const clsNames = h.cls_names.data;
    D.HALO = {
      lam: h.lam.data, bet: h.bet.data, l: h.l.data, b: h.b.data,
      dist: h.dist.data, G: h.G.data,
      cls: h.cls_code.data, clsNames,
    };
    D.HALO.UG = unitVectors(D.HALO.lam, D.HALO.bet);
    const n = D.HALO.lam.length;
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    const bet = D.HALO.bet;
    D.HALO.order = order.sort((a, b) => bet[a] - bet[b]);
    D.HALO.sortedBet = Float32Array.from(D.HALO.order, i => bet[i]);
    return n;
  } catch (e) {
    console.warn('[viasual2] no halo.npz:', e.message);
    D.HALO = null;
    return 0;
  }
}

// band-limited spherical-cap query over a bet-sorted catalog
export function sortedCatInField(cat, lam0, bet0, radius) {
  const sb = cat.sortedBet, ord = cat.order;
  let lo = 0, hi = sb.length;
  const b0 = bet0 - radius, b1 = bet0 + radius;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sb[m] < b0) lo = m + 1; else hi = m; }
  let hi2 = sb.length, lo2 = lo;
  while (lo2 < hi2) { const m = (lo2 + hi2) >> 1; if (sb[m] <= b1) lo2 = m + 1; else hi2 = m; }
  const lr = lam0 * Math.PI / 180, br = bet0 * Math.PI / 180;
  const ux = Math.cos(br) * Math.cos(lr), uy = Math.cos(br) * Math.sin(lr), uz = Math.sin(br);
  const out = [];
  const UG = cat.UG, R2D = 180 / Math.PI;
  for (let k = lo; k < lo2; k++) {
    const i = ord[k];
    const dot = UG[3 * i] * ux + UG[3 * i + 1] * uy + UG[3 * i + 2] * uz;
    const sep = Math.acos(Math.max(-1, Math.min(1, dot))) * R2D;
    if (sep <= radius) out.push(i);
  }
  return out;
}

// indices of quasars within `radius` deg of (lam0, bet0) — band-limited search
export function quaiaInField(lam0, bet0, radius) {
  const Q = D.QSO;
  if (!Q) return [];
  const sb = Q.sortedBet, ord = Q.order;
  let lo = 0, hi = sb.length;
  const b0 = bet0 - radius, b1 = bet0 + radius;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sb[m] < b0) lo = m + 1; else hi = m; }
  let hi2 = sb.length; let lo2 = lo;
  while (lo2 < hi2) { const m = (lo2 + hi2) >> 1; if (sb[m] <= b1) lo2 = m + 1; else hi2 = m; }
  const lr = lam0 * Math.PI / 180, br = bet0 * Math.PI / 180;
  const ux = Math.cos(br) * Math.cos(lr), uy = Math.cos(br) * Math.sin(lr), uz = Math.sin(br);
  const out = [];
  const UG = Q.UG, R2D = 180 / Math.PI;
  for (let k = lo; k < lo2; k++) {
    const i = ord[k];
    const dot = UG[3 * i] * ux + UG[3 * i + 1] * uy + UG[3 * i + 2] * uz;
    const sep = Math.acos(Math.max(-1, Math.min(1, dot))) * R2D;
    if (sep <= radius) out.push(i);
  }
  return out;
}
