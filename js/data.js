// Data layer — loads the viasual-app/data/ exports and derives geometry.
// v3 (9-6-26): + Via planned pointings, Chandra K giants, Xue+11 BHBs, Kepler-field stars,
// Geha+26 dwarf members, GASS HVCs, SFD dust, Bish+19 sightlines, LVDB dwarfs.
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

// bet-sorted index for band-limited field queries over big catalogs
function sortCat(cat) {
  const n = cat.lam.length;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const bet = cat.bet;
  cat.order = order.sort((a, b) => bet[a] - bet[b]);
  cat.sortedBet = Float32Array.from(cat.order, i => bet[i]);
  if (!cat.UG) cat.UG = unitVectors(cat.lam, cat.bet);
  return cat;
}

function catFromJson(raw) {
  const cat = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v[0] === 'string' || v.every(x => x === null || typeof x === 'string')) cat[k] = v.map(x => x ?? '');
    else cat[k] = Float64Array.from(v, x => (x === null ? NaN : x));
  }
  return cat;
}

// bump when files in data/ change, so deployed pages never read stale caches
export const DATA_VERSION = 'v3.0';
const q = `?${DATA_VERSION}`;

export async function loadCore(dataDir, onProgress = () => {}) {
  const t0 = performance.now();
  const [meta, stars, hi, gcsRaw, dwarfsRaw, members, cloudsRaw, viaRaw, sightRaw] = await Promise.all([
    fetch(`${dataDir}/meta.json${q}`).then(r => r.json()),
    loadNpz(`${dataDir}/stars.npz${q}`).then(x => { onProgress('stream stars'); return x; }),
    loadNpz(`${dataDir}/hi.npz${q}`).then(x => { onProgress('HI maps'); return x; }),
    fetch(`${dataDir}/gcs.json${q}`).then(r => r.json()),
    fetch(`${dataDir}/dwarfs.json${q}`).then(r => r.json()),
    loadNpz(`${dataDir}/members.npz${q}`).then(x => { onProgress('dwarf members'); return x; }),
    fetch(`${dataDir}/clouds.json${q}`).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(`${dataDir}/via_fields.json${q}`).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(`${dataDir}/sightlines.json${q}`).then(r => r.ok ? r.json() : null).catch(() => null),
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
  D.streamIsVia = code => D.VIA_SET.has(D.STREAM_NAMES[code]);

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
  D.DUST = null;                                 // lazy (dust.npz)

  // object catalogs
  D.GCC = catGeom(catFromJson(gcsRaw), D.SUN_GC, D.RG_GAL2GC);
  D.DWF = catGeom(catFromJson(dwarfsRaw), D.SUN_GC, D.RG_GAL2GC);
  if (!D.DWF.src) D.DWF.src = D.DWF.name.map(() => 'McConnachie+12');
  const gal_names = members.gal_names.data;
  D.MEM = catGeom({
    name: Array.from(members.gal_code.data, c => gal_names[c]),
    lam: members.lam.data, bet: members.bet.data,
    l: members.l.data, b: members.b.data,
    dist: members.dist.data, G: members.G.data, pmem: members.pmem.data,
  }, D.SUN_GC, D.RG_GAL2GC);
  D.QSO = null; D.HALO = null; D.KG = null; D.BHB = null; D.KEP = null; D.MEM2 = null;   // lazy

  // HVC cloud catalogs — one merged list: Putman+02 HIPASS, Adams+13 UCHVC, Moss+13 GASS
  if (cloudsRaw) {
    const H = cloudsRaw.hvc, U = cloudsRaw.uchvc, G = cloudsRaw.gass ?? { name: [] };
    const nn = x => x ?? NaN;
    const cl = {
      name: [...H.name, ...U.name, ...G.name],
      type: [...H.type, ...U.name.map(() => 'UCHVC'), ...G.name.map((_, i) => G.cat[i] === 'GAVC' ? 'GAVC' : 'GHVC')],
      src: [...H.name.map(() => 0), ...U.name.map(() => 1), ...G.name.map(() => 2)],   // 0 HIPASS 1 ALFALFA 2 GASS
      l: Float64Array.from([...H.l, ...U.l, ...G.l]),
      b: Float64Array.from([...H.b, ...U.b, ...G.b]),
      lam: Float64Array.from([...H.lam, ...U.lam, ...G.lam]),
      bet: Float64Array.from([...H.bet, ...U.bet, ...G.bet]),
      vlsr: Float64Array.from([...H.vlsr, ...U.vlsr, ...G.vlsr].map(nn)),
      vgsr: Float64Array.from([...H.vgsr, ...U.vgsr, ...G.vgsr].map(nn)),
      radDeg: Float64Array.from([
        ...H.maj_deg.map(x => (x ?? 0.3)),
        ...U.a_am.map(x => (x ?? 20) / 60),
        ...G.rad_deg.map(x => Math.max(0.1, x ?? 0.3))]),
      hipass: [...H.name.map(() => ''), ...U.name.map(() => ''), ...(G.hipass ?? [])],
    };
    cl.UG = unitVectors(cl.lam, cl.bet);
    D.CLOUDS = cl;
    D.CLOUD_SRC = ['HIPASS (Putman+02)', 'ALFALFA UCHVC (Adams+13)', 'GASS (Moss+13)'];
  } else D.CLOUDS = null;

  // Via planned pointings (unique 1-degree centres) + the approximate transient list
  if (viaRaw) {
    const V = {
      surveys: viaRaw.surveys, note: viaRaw.note,
      svy: viaRaw.svy, sub: viaRaw.sub, tile: viaRaw.tile, name: viaRaw.name,
      pri: Float64Array.from(viaRaw.pri, x => x ?? NaN), nvis: Int32Array.from(viaRaw.n),
      ra: Float64Array.from(viaRaw.ra), dec: Float64Array.from(viaRaw.dec),
      l: Float64Array.from(viaRaw.l), b: Float64Array.from(viaRaw.b),
      lam: Float64Array.from(viaRaw.lam), bet: Float64Array.from(viaRaw.bet),
    };
    V.UG = unitVectors(V.lam, V.bet);
    V.SVY_KEYS = Object.keys(V.surveys);
    D.VIA = V;
  } else D.VIA = null;

  // literature sightlines (repeatable absorption experiments)
  D.SIGHT = sightRaw ?? null;
  if (D.SIGHT?.bish19) {
    const s = D.SIGHT.bish19;
    s.lam = Float64Array.from(s.lam); s.bet = Float64Array.from(s.bet);
    s.l = Float64Array.from(s.l); s.b = Float64Array.from(s.b);
    s.UG = unitVectors(s.lam, s.bet);
  }

  // survey cones: sky regions the survey will tile (FOVs set by Matt 8-19-26)
  D.CONES = [
    { key: 'coneKepler', name: 'Kepler', l: D.KEPLER_LB[0], b: D.KEPLER_LB[1], fov: 15.0, r: 7.5, color: '#4caf50', len: 15 },
    { key: 'coneM31', name: 'M31', l: 121.17, b: -21.57, fov: 6.0, r: 3.0, color: '#5a8fd4', len: 15 },
    { key: 'coneM82', name: 'M82', l: 141.41, b: 40.57, fov: 2.0, r: 1.0, color: '#c77bd8', len: 15 },
  ];

  // 3D reference volume: box + far-object parking radius (Matt 8-19-26: both 100 kpc)
  D.BOX_R = 100;

  D.loadMs = performance.now() - t0;
  return D;
}

export async function loadQuaia(dataDir) {
  const qz = await loadNpz(`${dataDir}/quaia.npz${q}`);
  D.QSO = sortCat({ lam: qz.lam.data, bet: qz.bet.data, G: qz.G.data, z: qz.z.data });
  return D.QSO.lam.length;
}

export async function loadHalo(dataDir) {
  try {
    const h = await loadNpz(`${dataDir}/halo.npz${q}`);
    const clsNames = h.cls_names.data;
    D.HALO = sortCat({
      lam: h.lam.data, bet: h.bet.data, l: h.l.data, b: h.b.data,
      dist: h.dist.data, G: h.G.data, cls: h.cls_code.data, clsNames,
    });
    return D.HALO.lam.length;
  } catch (e) {
    console.warn('[viasual] no halo.npz:', e.message);
    D.HALO = null;
    return 0;
  }
}

// Chandra distant K giants: set 1 = > 30 kpc, set 2 = 10-30 kpc (disjoint)
export async function loadKgiants(dataDir) {
  try {
    const k = await loadNpz(`${dataDir}/kgiants.npz${q}`);
    D.KG = sortCat({
      lam: k.lam.data, bet: k.bet.data, l: k.l.data, b: k.b.data,
      dist: k.dist.data, G: k.G.data, set: k.set_code.data,
    });
    return D.KG.lam.length;
  } catch (e) { console.warn('[viasual] no kgiants.npz:', e.message); D.KG = null; return 0; }
}

// Xue+11 SDSS BHB stars (SDSS g used as the magnitude; BHB g - G ~ 0.1)
export async function loadBhb(dataDir) {
  try {
    const k = await loadNpz(`${dataDir}/bhb.npz${q}`);
    D.BHB = sortCat({
      lam: k.lam.data, bet: k.bet.data, l: k.l.data, b: k.b.data,
      dist: k.dist.data, G: k.g.data, hrv: k.hrv.data,
    });
    return D.BHB.lam.length;
  } catch (e) { console.warn('[viasual] no bhb.npz:', e.message); D.BHB = null; return 0; }
}

// Kepler-field Gaia stars (parallax distances) — Via's Kepler survey sample
export async function loadKepler(dataDir) {
  try {
    const k = await loadNpz(`${dataDir}/kepler.npz${q}`);
    D.KEP = sortCat({
      lam: k.lam.data, bet: k.bet.data, l: k.l.data, b: k.b.data, dist: k.dist.data, G: k.G.data,
    });
    return D.KEP.lam.length;
  } catch (e) { console.warn('[viasual] no kepler.npz:', e.message); D.KEP = null; return 0; }
}

// Geha+26 dwarf members (predicted Gaia G; distance = host galaxy)
export async function loadGeha(dataDir) {
  try {
    const m = await loadNpz(`${dataDir}/members_geha.npz${q}`);
    const gal_names = m.gal_names.data;
    D.MEM2 = sortCat(catGeom({
      name: Array.from(m.gal_code.data, c => gal_names[c]),
      lam: m.lam.data, bet: m.bet.data, l: m.l.data, b: m.b.data,
      dist: m.dist.data, G: m.G.data, pmem: m.pmem.data, vrad: m.vrad.data,
    }, D.SUN_GC, D.RG_GAL2GC));
    return D.MEM2.lam.length;
  } catch (e) { console.warn('[viasual] no members_geha.npz:', e.message); D.MEM2 = null; return 0; }
}

// SFD98 E(B-V) on the HI grids
export async function loadDust(dataDir) {
  try {
    const d = await loadNpz(`${dataDir}/dust.npz${q}`);
    D.DUST = {
      LOG_EBV: d.log_ebv.data, SGR_LOG_EBV: d.sgr_log_ebv.data,
      shape: d.log_ebv.shape, sgrShape: d.sgr_log_ebv.shape,
    };
    return true;
  } catch (e) { console.warn('[viasual] no dust.npz:', e.message); D.DUST = null; return false; }
}

// Edenhofer+24 3D dust: integrated slices (to 300 / 600 / 1250 pc) + a local point cloud
export async function loadDust3d(dataDir) {
  try {
    const d = await loadNpz(`${dataDir}/dust3d.npz${q}`);
    const [ns, ny, nx] = d.ebv_slices.shape;
    const slices = [];
    for (let k = 0; k < ns; k++) slices.push(d.ebv_slices.data.subarray(k * ny * nx, (k + 1) * ny * nx));
    D.DUST3D = {
      slices, pc: Array.from(d.slice_pc.data),
      xyz: d.cloud_xyz.data, val: d.cloud_val.data, w: d.cloud_w.data, n: d.cloud_w.data.length,
      sgr: {},                                    // Sgr-strip versions built lazily
    };
    return D.DUST3D.n;
  } catch (e) { console.warn('[viasual] no dust3d.npz:', e.message); D.DUST3D = null; return 0; }
}

// resample a galactic (l,b) plate-carree grid onto the Sgr Lambda/Beta strip grid
export function sgrGridFromGal(grid) {
  const nb = D.HI_SGR_BET.length, nl = D.HI_SGR_LAM.length;
  const out = new Float32Array(nb * nl);
  const M = D.M_GAL, B = D.M_SGR;
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  for (let ib = 0; ib < nb; ib++) {
    const br = D.HI_SGR_BET[ib] * D2R, cb = Math.cos(br), sb = Math.sin(br);
    for (let il = 0; il < nl; il++) {
      const lr = D.HI_SGR_LAM[il] * D2R;
      const v = [cb * Math.cos(lr), cb * Math.sin(lr), sb];
      // Sgr -> ICRS (B^T) -> Galactic (M)
      const ix = B[0][0] * v[0] + B[1][0] * v[1] + B[2][0] * v[2];
      const iy = B[0][1] * v[0] + B[1][1] * v[1] + B[2][1] * v[2];
      const iz = B[0][2] * v[0] + B[1][2] * v[1] + B[2][2] * v[2];
      const gx = M[0][0] * ix + M[0][1] * iy + M[0][2] * iz;
      const gy = M[1][0] * ix + M[1][1] * iy + M[1][2] * iz;
      const gz = M[2][0] * ix + M[2][1] * iy + M[2][2] * iz;
      const l = Math.atan2(gy, gx) * R2D, b = Math.asin(Math.max(-1, Math.min(1, gz))) * R2D;
      let li = Math.round((((l + 180) % 360 + 360) % 360) / D.HI_STEP);
      let bi = Math.round((b + 90) / D.HI_STEP);
      if (li > D.HI_NX - 1) li = D.HI_NX - 1; if (bi > D.HI_NY - 1) bi = D.HI_NY - 1;
      out[ib * nl + il] = grid[bi * D.HI_NX + li];
    }
  }
  return out;
}

// the background map for a `himap` key: { gal (l,b grid), sgr (strip grid), overlay? }
// keys: total | hvc | overlay | dust (SFD) | e300 | e600 | e1250 (Edenhofer integrated)
export function bgGridFor(himap) {
  if (himap === 'hvc' && D.HI_LOG_HVC) return { gal: D.HI_LOG_HVC, sgr: D.HI_SGR_HVC };
  if (himap === 'dust' && D.DUST) return { gal: D.DUST.LOG_EBV, sgr: D.DUST.SGR_LOG_EBV };
  if (himap?.startsWith('e') && D.DUST3D) {
    const k = { e300: 0, e600: 1, e1250: 2 }[himap] ?? 2;
    if (!D.DUST3D.sgr[k]) D.DUST3D.sgr[k] = sgrGridFromGal(D.DUST3D.slices[k]);
    return { gal: D.DUST3D.slices[k], sgr: D.DUST3D.sgr[k] };
  }
  return { gal: D.HI_LOG_TOTAL, sgr: D.HI_SGR_TOTAL, overlay: himap === 'overlay' && D.HI_LOG_HVC ? { gal: D.HI_LOG_HVC, sgr: D.HI_SGR_HVC } : null };
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

// indices of quasars within `radius` deg of (lam0, bet0)
export function quaiaInField(lam0, bet0, radius) {
  return D.QSO ? sortedCatInField(D.QSO, lam0, bet0, radius) : [];
}
