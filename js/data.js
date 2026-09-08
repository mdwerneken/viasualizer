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
export const DATA_VERSION = 'v3.8';
const q = `?${DATA_VERSION}`;

export async function loadCore(dataDir, onProgress = () => {}) {
  const t0 = performance.now();
  const [meta, stars, maps, gcsRaw, dwarfsRaw, members, cloudsRaw, viaRaw, sightRaw] = await Promise.all([
    fetch(`${dataDir}/meta.json${q}`).then(r => r.json()),
    loadNpz(`${dataDir}/stars.npz${q}`).then(x => { onProgress('stream stars'); return x; }),
    loadNpz(`${dataDir}/maps.npz${q}`).then(x => { onProgress('sky maps'); return x; }),
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

  // all-sky background maps: one 5' plate-carree grid (rows b from -90, cols l from -180),
  // compact encodings decoded on sample (see tools/build_maps.py + makeGrid)
  const step = maps.step.data[0], l0 = maps.l0.data[0], b0 = maps.b0.data[0];
  const u8 = (k) => makeGrid(maps[k].data, maps[k].shape, step, l0, b0, { kind: 'u8', lo: maps[`${k}_lo`].data[0], hi: maps[`${k}_hi`].data[0] });
  const i16 = (k) => makeGrid(maps[k].data, maps[k].shape, step, l0, b0, { kind: 'i16', scale: 0.1 });
  D.MAPS = { total: u8('total'), hvc: u8('hvc'), vlsr: i16('vlsr'), vgsr: i16('vgsr'), sfd: u8('sfd') };
  // cube-derived products (tools/build_hi_cube.py) when present
  for (const k of ['vmean', 'vdisp']) if (maps[k]) D.MAPS[k] = i16(k);
  for (const k of ['nlvc', 'nivc', 'nhvc']) if (maps[k]) D.MAPS[k] = u8(k);
  D.MAPS_NOTE = maps.note ? maps.note.data[0] : '';
  D.DUST = { grid: D.MAPS.sfd };                 // SFD lives in maps.npz now

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
  // literature sightline sets (each becomes a standing custom field collection)
  D.SIGHT = sightRaw ?? null;
  if (D.SIGHT) for (const s of Object.values(D.SIGHT)) {
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
    // which members belong to a globular cluster (vs a dwarf): matched by normalised name
    const norm = x => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
    const gcSet = new Set(D.GCC.name.map(norm));
    D.MEM2.isGC = Uint8Array.from(D.MEM2.name, nm => gcSet.has(norm(nm)) ? 1 : 0);
    return D.MEM2.lam.length;
  } catch (e) { console.warn('[viasual] no members_geha.npz:', e.message); D.MEM2 = null; return 0; }
}

// SFD98 E(B-V) on the HI grids
// ---- background-map grids -----------------------------------------------------------
// A grid = { data, ny, nx, step, l0, b0, kind, lo, hi, scale }; values decode on read:
//   u8  : 0 = NaN, 1..255 -> lo..hi (linear)      i16 : -32768 = NaN, else value*scale
//   f32 : raw floats (NaN allowed)
export function makeGrid(data, shape, step, l0, b0, dec) {
  return { data, ny: shape[0], nx: shape[1], step, l0, b0, kind: 'f32', lo: 0, hi: 1, scale: 1, ...dec,
    _q: new Map() };
}
export function gridAt(G, k) {
  const v = G.data[k];
  if (G.kind === 'u8') return v === 0 ? NaN : G.lo + (v - 1) * (G.hi - G.lo) / 254;
  if (G.kind === 'i16') return v === -32768 ? NaN : v * G.scale;
  return v;
}
function gridIdx(G, l, b) {
  let li = Math.round((((l - G.l0) % 360) + 360) % 360 / G.step);
  let bi = Math.round((b - G.b0) / G.step);
  if (li > G.nx - 1) li = G.nx - 1; if (li < 0) li = 0;
  if (bi > G.ny - 1) bi = G.ny - 1; if (bi < 0) bi = 0;
  return bi * G.nx + li;
}
export function gridSample(G, l, b) { return gridAt(G, gridIdx(G, l, b)); }
// bilinear, NaN-aware (a NaN corner drops out of the weighted mean)
export function gridSampleBL(G, l, b) {
  const x = (((l - G.l0) % 360) + 360) % 360 / G.step, y = (b - G.b0) / G.step;
  let x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  if (y0 < 0) y0 = 0; if (y0 > G.ny - 2) y0 = G.ny - 2;
  if (x0 < 0) x0 = 0; if (x0 > G.nx - 2) x0 = G.nx - 2;
  let sum = 0, wsum = 0;
  const acc = (yy, xx, w) => { if (w <= 0) return; const v = gridAt(G, yy * G.nx + xx); if (Number.isFinite(v)) { sum += v * w; wsum += w; } };
  acc(y0, x0, (1 - fx) * (1 - fy)); acc(y0, x0 + 1, fx * (1 - fy)); acc(y0 + 1, x0, (1 - fx) * fy); acc(y0 + 1, x0 + 1, fx * fy);
  return wsum > 0 ? sum / wsum : NaN;
}
// global quantiles of a grid (strided sample, cached per grid + stride)
export function gridQuantiles(G, q0, q1, stride = 23) {
  const key = `${stride}`;
  let sorted = G._q.get(key);
  if (!sorted) {
    const vals = [];
    for (let k = 0; k < G.data.length; k += stride) { const v = gridAt(G, k); if (Number.isFinite(v)) vals.push(v); }
    vals.sort((a, b) => a - b);
    sorted = Float64Array.from(vals);
    G._q.set(key, sorted);
  }
  const at = q => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))] : NaN;
  return [at(q0), at(q1)];
}
// the display stretch for a background: quantiles, symmetric about 0 for velocity maps
export function gridStretch(G, sym = false, q0 = 0.05, q1 = 0.99) {
  let [v0, v1] = gridQuantiles(G, q0, q1);
  if (sym) { const a = Math.max(Math.abs(v0), Math.abs(v1)) || 1; v0 = -a; v1 = a; }
  return { v0, v1 };
}
// mean / peak inside a spherical cap. log=true averages 10**v and reports log10 of the
// mean and peak (column densities, E(B-V)); log=false averages the values (velocities)
export function gridStats(G, l0, b0, radius, log = true) {
  const D2R = Math.PI / 180;
  const lr0 = l0 * D2R, br0 = b0 * D2R;
  const ux = Math.cos(br0) * Math.cos(lr0), uy = Math.cos(br0) * Math.sin(lr0), uz = Math.sin(br0);
  const cosr = Math.cos(radius * D2R);
  const bLo = Math.max(0, Math.floor((b0 - radius - G.b0) / G.step));
  const bHi = Math.min(G.ny - 1, Math.ceil((b0 + radius - G.b0) / G.step));
  // longitude window (widened by 1/cos b; full circle near the poles)
  const cb0 = Math.cos(br0);
  const dl = cb0 > 1e-3 ? Math.min(180, radius / cb0 + G.step) : 180;
  let sum = 0, cnt = 0, peak = -Infinity;
  for (let bi = bLo; bi <= bHi; bi++) {
    const bb = G.b0 + bi * G.step, br = bb * D2R, cb = Math.cos(br), sb = Math.sin(br);
    let lStart = l0 - dl, lEnd = l0 + dl;
    for (let ll = lStart; ll <= lEnd; ll += G.step) {
      const lw = (((ll - G.l0) % 360) + 360) % 360;
      const li = Math.min(G.nx - 1, Math.round(lw / G.step));
      const lr = (G.l0 + li * G.step) * D2R;
      if (cb * Math.cos(lr) * ux + cb * Math.sin(lr) * uy + sb * uz < cosr) continue;
      let v = gridAt(G, bi * G.nx + li);
      if (!Number.isFinite(v)) continue;
      if (log) v = 10 ** v;
      sum += v; cnt++;
      if (v > peak) peak = v;
    }
  }
  if (!cnt) return null;
  const mean = sum / cnt;
  return log ? { mean, peak, logMean: Math.log10(mean), logPeak: Math.log10(peak), n: cnt } : { mean, peak, n: cnt };
}

// HI4PI coarse spectral cube (tools/build_hi_cube.py): Nside-128 HEALPix pixels x 10 km/s bins,
// mean T_B as uint8 log; used for the "HI velocity distribution in this field" plot
export async function loadHicube(dataDir) {
  try {
    const c = await loadNpz(`${dataDir}/hicube.npz${q}`);
    const nb = c.v_edges.data.length - 1, npix = c.l.data.length;
    D.HICUBE = { T: c.T.data, nb, npix, tlo: c.t_lo.data[0], thi: c.t_hi.data[0], vEdges: c.v_edges.data,
      l: c.l.data, b: c.b.data, UG: unitVectors(c.l.data, c.b.data) };
    return npix;
  } catch (e) { console.warn('[viasual] no hicube.npz:', e.message); D.HICUBE = null; return 0; }
}
// mean HI spectrum (K per 10 km/s bin) over cube pixels within `radius` deg of (l0, b0)
export function hiSpectrumInField(l0, b0, radius) {
  const C = D.HICUBE; if (!C) return null;
  const D2R = Math.PI / 180, lr = l0 * D2R, br = b0 * D2R;
  const ux = Math.cos(br) * Math.cos(lr), uy = Math.cos(br) * Math.sin(lr), uz = Math.sin(br);
  const cosr = Math.cos((radius + 0.23) * D2R);          // + half an Nside-128 pixel
  const sum = new Float64Array(C.nb), cnt = new Int32Array(C.nb);
  let n = 0;
  for (let p = 0; p < C.npix; p++) {
    if (C.UG[3 * p] * ux + C.UG[3 * p + 1] * uy + C.UG[3 * p + 2] * uz < cosr) continue;
    n++;
    for (let k = 0; k < C.nb; k++) {
      const v = C.T[p * C.nb + k];
      if (v === 0) continue;
      sum[k] += 10 ** (C.tlo + (v - 1) * (C.thi - C.tlo) / 254); cnt[k]++;
    }
  }
  if (!n) return null;
  return { T: Float64Array.from(sum, (s, k) => cnt[k] ? s / cnt[k] : 0), vEdges: C.vEdges, npix: n };
}

// Edenhofer+24 3D dust: integrated slices (to 300 / 600 / 1250 pc) + a local point cloud
export async function loadDust3d(dataDir) {
  try {
    const d = await loadNpz(`${dataDir}/dust3d.npz${q}`);
    const [ns, ny, nx] = d.ebv_slices.shape;
    const step = 360 / (nx - 1);                 // the slices keep their own (0.25 deg) grid
    const slices = [];
    for (let k = 0; k < ns; k++) slices.push(makeGrid(d.ebv_slices.data.subarray(k * ny * nx, (k + 1) * ny * nx), [ny, nx], step, -180, -90, { kind: 'f32' }));
    D.DUST3D = {
      slices, pc: Array.from(d.slice_pc.data),
      xyz: d.cloud_xyz.data, val: d.cloud_val.data, w: d.cloud_w.data, n: d.cloud_w.data.length,
    };
    return D.DUST3D.n;
  } catch (e) { console.warn('[viasual] no dust3d.npz:', e.message); D.DUST3D = null; return 0; }
}

// the background map for a `himap` key: { gal: grid, overlay?: grid, sym: symmetric stretch }
// keys: total | hvc | overlay | vlsr | vgsr | dust (SFD) | e300 | e600 | e1250 (Edenhofer integrated)
export function bgAvailable(himap) {
  if (himap === 'total' || himap === 'overlay') return true;
  if (himap?.startsWith('e')) return !!D.DUST3D;
  if (himap === 'dust') return !!D.MAPS.sfd;
  return !!D.MAPS[himap];
}
export function bgGridFor(himap) {
  const M = D.MAPS;
  if (himap === 'hvc') return { gal: M.hvc, overlay: null, sym: false };
  if (himap === 'vlsr' || himap === 'vgsr') return { gal: M[himap], overlay: null, sym: true };
  if (himap === 'vmean' && M.vmean) return { gal: M.vmean, overlay: null, sym: true };
  if (himap === 'vdisp' && M.vdisp) return { gal: M.vdisp, overlay: null, sym: false };
  if (['nlvc', 'nivc', 'nhvc'].includes(himap) && M[himap]) return { gal: M[himap], overlay: null, sym: false };
  if (himap === 'dust') return { gal: M.sfd, overlay: null, sym: false };
  if (himap?.startsWith('e') && D.DUST3D) {
    const k = { e300: 0, e600: 1, e1250: 2 }[himap] ?? 2;
    return { gal: D.DUST3D.slices[k], overlay: null, sym: false };
  }
  return { gal: M.total, overlay: himap === 'overlay' ? M.hvc : null, sym: false };
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
