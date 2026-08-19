// Live distance-ladder ("rungs") scoring for one field — the ranking rules from
// field-exploration/tools/scan_fields.py, applied to the current field on the fly.
//   * a rung = one distinct physical structure at one distance
//   * streams need >= NMIN_SRC sources in the field; GCs/dwarfs always pass
//   * structures within DTOL (20%) in distance collapse to one rung
//   * quasars are a single rung at infinity (>=1 quasar)
//   * physically-single systems are merged (Sgr stream+dSph+M54+clusters, wCen, Pal 5)
import { D } from './data.js';
import { fieldIndices, median } from './compute.js';

export const NMIN_SRC = 2;
export const DTOL = 0.20;
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

// starIdx: star indices already filtered to the field+mag limit; nQso: quasar count.
// Returns { nRungs, groups: [[{key,dist,kind,n,label},...],...], qsoRung, tie }
export function ladder(starIdx, lam0, bet0, radius, gLim, nQso) {
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
  for (const i of starIdx) {
    const nm = D.streamName(i);
    if (!byStream.has(nm)) byStream.set(nm, []);
    byStream.get(nm).push(D.s_dist_use[i]);
  }
  for (const [nm, dd] of byStream) {
    const v = median(dd);
    if (Number.isFinite(v)) add(skey(nm), v, 'stream', dd.length, nm);
  }
  // GCs / dwarfs in field
  for (const j of fieldIndices(lam0, bet0, D.GCC.UG, radius)) {
    if (Number.isFinite(D.GCC.dist[j])) add(skey(D.GCC.name[j]), D.GCC.dist[j], 'GC', GC_NOMINAL, D.GCC.name[j]);
  }
  for (const j of fieldIndices(lam0, bet0, D.DWF.UG, radius)) {
    if (Number.isFinite(D.DWF.dist[j])) add(skey(D.DWF.name[j]), D.DWF.dist[j], 'dwarf', GC_NOMINAL, D.DWF.name[j]);
  }
  // dwarf member stars (respect mag limit like scan_fields' G<=GLIM pool)
  const memByGal = new Map();
  for (const j of fieldIndices(lam0, bet0, D.MEM.UG, radius)) {
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
  const qsoRung = nQso > 0;
  const nRungs = groups.length + (qsoRung ? 1 : 0);
  let tie = kept.reduce((s, r) => s + Math.log10(1 + r.n), 0);
  if (nQso) tie += Math.log10(1 + nQso);
  return { nRungs, groups, qsoRung, nQso, tie, structures: kept };
}
