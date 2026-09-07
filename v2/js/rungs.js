// Live distance-ladder ("rungs") scoring for one field — the ranking rules from
// field-exploration/tools/scan_fields.py, applied to the current field on the fly.
//   * a rung = one distinct physical structure at one distance
//   * streams need >= NMIN_SRC sources in the field; GCs/dwarfs always pass
//   * halo RR Lyrae form rungs via the PAIR RULE (Matt, 8-19-26): >=2 stars within
//     1 kpc of each other in distance AND within 1 deg on-sky
//   * structures within DTOL (10%) in distance collapse to one rung
//   * quasars are a single rung at infinity (>=1 quasar)
//   * physically-single systems are merged (Sgr stream+dSph+M54+clusters, wCen, Pal 5)
//   * everything FOLLOWS VISIBILITY: hidden catalogs contribute nothing
import { D } from './data.js';
import { median } from './compute.js';

export const NMIN_SRC = 2;
export const DTOL = 0.20;                 // 20% (restored 8-20-26 after a brief 10% trial)
export const HALO_PAIR_DKPC = 1.0;        // halo pair rule: <= 1 kpc apart in distance
export const HALO_PAIR_DEG = 1.0;         //                 <= 1 deg apart on-sky
const GC_NOMINAL = 10;

const MERGE = {
  'sagittarius': 'Sgr system', 'sagittarius dsph': 'Sgr system', 'ngc 6715': 'Sgr system',
  'terzan 7': 'Sgr system', 'terzan 8': 'Sgr system', 'ter 7': 'Sgr system',
  'ter 8': 'Sgr system', 'arp 2': 'Sgr system', 'pal 12': 'Sgr system',
  'palomar 12': 'Sgr system', 'whiting 1': 'Sgr system',
  'omega centauri': 'omega Cen', 'ngc 5139': 'omega Cen', 'fimbulthul': 'omega Cen',
  'pal 5': 'Pal 5', 'palomar 5': 'Pal 5',
};
const skey = nm => MERGE[String(nm).trim().toLowerCase()] ?? String(nm).trim();
export { skey };

// halo pair rule: cluster halo stars (union-find) linking pairs that satisfy both
// the 1 kpc and 1 deg conditions; clusters with >=2 stars become rung candidates.
function haloRungs(hh) {
  const n = hh.length;
  if (n < 2) return [];
  const H = D.HALO;
  const par = new Int32Array(n);
  for (let i = 0; i < n; i++) par[i] = i;
  const find = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  const D2R = Math.PI / 180;
  const cosLim = Math.cos(HALO_PAIR_DEG * D2R);
  const ux = new Float64Array(n), uy = new Float64Array(n), uz = new Float64Array(n);
  const dd = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const i = hh[k];
    const lr = H.lam[i] * D2R, br = H.bet[i] * D2R, cb = Math.cos(br);
    ux[k] = cb * Math.cos(lr); uy[k] = cb * Math.sin(lr); uz[k] = Math.sin(br);
    dd[k] = H.dist[i];
  }
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      if (Math.abs(dd[a] - dd[b]) > HALO_PAIR_DKPC) continue;
      if (ux[a] * ux[b] + uy[a] * uy[b] + uz[a] * uz[b] < cosLim) continue;
      const ra = find(a), rb = find(b);
      if (ra !== rb) par[ra] = rb;
    }
  }
  const clusters = new Map();
  for (let k = 0; k < n; k++) {
    const r = find(k);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r).push(dd[k]);
  }
  const out = [];
  let ci = 0;
  for (const ds of clusters.values()) {
    if (ds.length < 2) continue;
    out.push({ key: `halo-${ci++}`, dist: median(ds), kind: 'halo', n: ds.length, label: 'halo RRL' });
  }
  return out;
}

// All inputs are the fieldmodel's already-visibility-filtered collections:
//   idx: stream-star indices; mm: dwarf-member indices; hh: halo indices;
//   gc/dw: GC / dwarf catalog indices; nQso: quasar count.
// Returns { nRungs, groups, qsoRung, nQso, tie, structures }
export function ladder({ idx, mm, hh, gc, dw, nQso, gLim }) {
  const rung = new Map();   // key -> {dist, kind, n, label}
  const add = (key, d0, kind, n, label) => {
    const r = rung.get(key);
    if (r) {
      r.n += n;
      if (kind === 'GC' || kind === 'dwarf') { r.dist = d0; r.kind = kind; }
    } else rung.set(key, { key, dist: d0, kind, n, label });
  };

  // stream stars, per stream: median catalog distance
  const byStream = new Map();
  for (const i of idx) {
    const nm = D.streamName(i);
    if (!byStream.has(nm)) byStream.set(nm, []);
    byStream.get(nm).push(D.s_dist_use[i]);
  }
  for (const [nm, dd] of byStream) {
    const v = median(dd);
    if (Number.isFinite(v)) add(skey(nm), v, 'stream', dd.length, nm);
  }
  // GCs / dwarfs in field (already visibility-filtered)
  for (const j of gc) {
    if (Number.isFinite(D.GCC.dist[j])) add(skey(D.GCC.name[j]), D.GCC.dist[j], 'GC', GC_NOMINAL, D.GCC.name[j]);
  }
  for (const j of dw) {
    if (Number.isFinite(D.DWF.dist[j])) add(skey(D.DWF.name[j]), D.DWF.dist[j], 'dwarf', GC_NOMINAL, D.DWF.name[j]);
  }
  // dwarf member stars (respect mag limit like scan_fields' G<=GLIM pool)
  const memByGal = new Map();
  for (const j of mm) {
    const g = D.MEM.G[j];
    if (Number.isFinite(g) && g <= gLim) {
      const nm = D.MEM.name[j];
      if (!memByGal.has(nm)) memByGal.set(nm, []);
      memByGal.get(nm).push(D.MEM.dist[j]);
    }
  }
  for (const [nm, dd] of memByGal) add(skey(nm), median(dd), 'dwarf', dd.length, nm);

  // gate: streams need NMIN_SRC sources; GCs/dwarfs always pass
  const kept = [...rung.values()].filter(r => r.n >= NMIN_SRC || r.kind === 'GC' || r.kind === 'dwarf');
  // collapse structures at the same distance (DTOL fractional tolerance, sorted)
  kept.sort((a, b) => a.dist - b.dist);
  const groups = [];
  for (const r of kept) {
    const last = groups.length ? groups[groups.length - 1] : null;
    if (last && Math.abs(r.dist - last[last.length - 1].dist)
        <= DTOL * Math.max(r.dist, last[last.length - 1].dist)) last.push(r);
    else groups.push([r]);
  }
  // halo pair-rule clusters come LAST (Matt 8-20-26): they only add rungs when they
  // sit outside the DTOL margin of every structure rung AND every accepted halo rung —
  // no stacking on existing lines; each accepted cluster gets its own row
  const acceptedHalo = [];
  const clash = d => {
    for (const grp of groups) for (const r of grp) {
      if (Math.abs(d - r.dist) <= DTOL * Math.max(d, r.dist)) return true;
    }
    for (const r of acceptedHalo) {
      if (Math.abs(d - r.dist) <= DTOL * Math.max(d, r.dist)) return true;
    }
    return false;
  };
  for (const hc of haloRungs(hh ?? []).sort((a, b) => b.n - a.n)) {
    if (!clash(hc.dist)) acceptedHalo.push(hc);
  }
  for (const hc of acceptedHalo) groups.push([hc]);
  groups.sort((a, b) => a[0].dist - b[0].dist);
  const qsoRung = nQso > 0;
  const nRungs = groups.length + (qsoRung ? 1 : 0);
  const all = kept.concat(acceptedHalo);
  let tie = all.reduce((s, r) => s + Math.log10(1 + r.n), 0);
  if (nQso) tie += Math.log10(1 + nQso);
  return { nRungs, groups, qsoRung, nQso, tie, structures: all };
}
