// Field lists (v3): one registry for every browsable set of fields — Via survey plans
// (per survey), the precomputed promising-field shortlists, saved fields and the visit
// history — plus background SCORING of a list with the live field rules (visibility,
// G limit, FOV) so lists can be sorted by rungs / targets / quasars / HI / dec.
import { D } from './data.js';
import { state, set, on, emit, loadSaved, histState, slideField, replaceLock } from './state.js';
import { computeField } from './fieldmodel.js';
import * as C from './compute.js';
import { SVY_COL, SVY_SHORT } from './colors.js';

// ---- sources -----------------------------------------------------------------------
// a source = { id, title, group, color, items: () => [{lam, bet, l, b, fov, label, sub, meta}] }
// groups (sidebar order): via = planned Via fields · top = scan-grid shortlists ·
// custom = saved / visited / literature lists added from the "add a list" dropdown
export const SOURCES = [];
export const GROUPS = { via: 'Planned Via fields', top: 'Promising cold-gas fields', custom: 'Custom' };
export const CUSTOM_COL = '#ffffff';
export const TOP_COL = '#d8a35a';
// literature field lists offered by the custom "add a list" dropdown (Bish+19 by default)
export const EXTRA_LISTS = [
  { id: 'bish19', title: 'Bish+19 BHBs (Keck/HIRES Na I / Ca II sightlines)', short: 'Bish+19 BHBs', color: CUSTOM_COL },
  { id: 'bish21', title: 'Bish+21 QuaStar (BHB–quasar pairs, HST/COS)', short: 'Bish+21 QuaStar', color: CUSTOM_COL },
];

function viaItems(svy) {
  const V = D.VIA, out = [];
  if (!V) return out;
  for (let i = 0; i < V.svy.length; i++) {
    if (V.svy[i] !== svy) continue;
    const nm = V.name[i] || `${svy.toUpperCase()} tile ${V.tile[i]}`;
    out.push({
      lam: V.lam[i], bet: V.bet[i], l: V.l[i], b: V.b[i], fov: 1,
      label: nm, sub: V.sub[i], svy, ref: i,
      meta: `${V.surveys[svy]} · ${V.sub[i] ? V.sub[i] + ' · ' : ''}${V.nvis[i]} visit${V.nvis[i] === 1 ? '' : 's'}` +
        (Number.isFinite(V.pri[i]) && V.pri[i] > 0 ? ` · priority ${V.pri[i]}` : ''),
    });
  }
  return out;
}

function candGrid(fov, ghi) {
  const pairs = new Map();
  for (const c of D.CANDIDATES) pairs.set(`${c.fov}|${c.glim ?? 20}`, { fov: c.fov, glim: c.glim ?? 20 });
  let best = null, bd = Infinity;
  for (const p of pairs.values()) {
    const d = Math.abs(p.fov - fov) * 2 + Math.abs(p.glim - ghi);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
function topItems(sec) {
  // the Kepler list is 1° only and gridded in G at 0.5 mag; the main lists follow the FOV too
  const pool = D.CANDIDATES.filter(c => (c.sec ?? 'top') === sec);
  if (!pool.length) return [];
  let best;
  if (sec === 'kepler') {
    let bd = Infinity;
    for (const c of pool) { const d = Math.abs((c.glim ?? 20) - state.ghi); if (d < bd) { bd = d; best = { fov: 1, glim: c.glim ?? 20 }; } }
  } else best = candGrid(state.fov, state.ghi);
  if (!best) return [];
  return pool.filter(c => c.fov === best.fov && (c.glim ?? 20) === best.glim)
    .map(c => ({
      lam: c.lam, bet: c.bet, l: c.l, b: c.b, fov: c.fov, ref: D.CANDIDATES.indexOf(c),
      label: c.combo, sub: `G ≤ ${best.glim}`,
      meta: `${c.n_rungs} rungs${Number.isFinite(c.n_qso) ? ` · ${c.n_qso} quasars` : ''} · log N(HI) ${c.log_nhi} · ${c.site}`,
      scan: { rungs: c.n_rungs, nhi: c.log_nhi },
    }));
}
function savedItems() {
  return loadSaved().map((f, i) => ({
    lam: f.lam, bet: f.bet, l: f.l, b: f.b, fov: f.fov ?? 1, ref: i,
    label: f.obj || f.label || `ℓ ${f.l.toFixed(1)}, b ${f.b.toFixed(1)}`, sub: `${(f.fov ?? 1)}°`,
    meta: `saved field${f.ghi ? ` · G ≤ ${f.ghi}` : ''}`,
  }));
}
function sightItems(key) {
  const S = D.SIGHT?.[key];
  if (!S) return [];
  return S.name.map((nm, i) => ({
    lam: S.lam[i], bet: S.bet[i], l: S.l[i], b: S.b[i], fov: 1, ref: i,
    label: nm.split(' ')[0], sub: `${S.dist[i]} kpc`,
    meta: key === 'bish21' ? `QuaStar pair with ${S.qso[i]} (${S.sep[i]}° away) · HST/COS` : `Bish+19 Keck/HIRES Na I + Ca II · g ${S.g[i]} · v_helio ${S.hrv[i]} km/s`,
    dist: S.dist[i],
  }));
}
function historyItems() {
  const h = histState();
  return h.list.map((f, i) => {
    const [l, b] = C.convPoint(D.M_SGR, D.M_GAL, f.lam, f.bet);
    return { lam: f.lam, bet: f.bet, l, b, fov: f.fov, ref: i,
      label: f.lock?.name || `ℓ ${l.toFixed(1)}, b ${b.toFixed(1)}`, sub: `${f.fov}°`, meta: 'visited' };
  }).reverse();
}

export function initLists() {
  SOURCES.length = 0;
  SOURCES.push({ id: 'top', group: 'top', color: TOP_COL, title: 'Best by distance coverage', short: 'Best by distance coverage', items: () => topItems('top') });
  SOURCES.push({ id: 'topvia', group: 'top', color: TOP_COL, title: 'Best including a Via stream', short: 'Best including a Via stream', items: () => topItems('via') });
  SOURCES.push({ id: 'topkep', group: 'top', color: '#4caf50', title: 'Best in the Kepler field (1°, Kepler stars as rungs)', short: 'Best in the Kepler field', items: () => topItems('kepler') });
  if (D.VIA) {
    // display order (Matt 9-7-26): streams, dwarfs, cold gas, transients, kepler; rbs (4 placeholder rows) folded into tfs
    for (const svy of ['sps', 'dgs', 'cgs', 'tfs', 'krs']) {
      if (!D.VIA.SVY_KEYS.includes(svy)) continue;
      SOURCES.push({ id: `via:${svy}`, group: 'via', svy, color: SVY_COL[svy],
        title: `${D.VIA.surveys[svy]} (${svy.toUpperCase()})`, short: SVY_SHORT[svy] ?? svy, items: () => viaItems(svy) });
    }
  }
  SOURCES.push({ id: 'saved', group: 'custom', color: CUSTOM_COL, title: 'Saved fields', short: 'Saved fields', items: savedItems });
  for (const x of EXTRA_LISTS) {
    SOURCES.push({ id: x.id, group: 'custom', color: x.color, title: x.title, short: x.short ?? x.title,
      items: () => sightItems(x.id) });
  }
  on('saved', () => { if (state.listSrc.includes('saved')) rebuild(); });
  on('ui', () => { if (state.listSrc.some(s => s.startsWith('top'))) rebuild(); invalidateScores(); });
  on('catalog', () => invalidateScores());
  rebuild();
}

// ---- the active list ------------------------------------------------------------------
export const LIST = { items: [], order: [], key: '', scoring: null, scored: 0 };
let scoreGen = 0;
let scoreCache = new Map();     // `${lam}|${bet}|${fov}` -> score

export function sourceById(id) { return SOURCES.find(s => s.id === id); }

export function rebuild(resetPos = true) {
  scoreGen++;                                  // a running pass restarts on the new item set (cache kept)
  const items = [];
  for (const id of state.listSrc) {
    const s = sourceById(id);
    if (s) for (const it of s.items()) items.push({ ...it, src: id });
  }
  LIST.items = items;
  for (const it of items) it.score = scoreCache.get(scoreKey(it)) ?? null;
  applySort();
  if (resetPos) {
    // keep the position on the same field if it still exists
    const cur = state.listPos >= 0 ? LIST.order[state.listPos] : null;
    state.listPos = cur ? Math.max(-1, LIST.order.indexOf(cur)) : -1;
  }
  emit('list');
  if (items.length && state.listSort !== 'order' && state.listSort !== 'dec') startScoring();
}

function scoreKey(it) { return `${it.lam.toFixed(4)}|${it.bet.toFixed(4)}|${it.fov}`; }

export function applySort() {
  let order = LIST.items.slice();
  if (state.listOnlyVisible) order = order.filter(it => (it.score ? (it.score.vMMT || it.score.vMag) : true));
  const sk = state.listSort;
  const val = it => {
    const s = it.score;
    if (sk === 'rungs') return s ? s.rungs + s.tie * 1e-3 : (it.scan?.rungs ?? -1);
    if (sk === 'targets') return s ? s.targets : -1;
    if (sk === 'qso') return s ? s.qso : -1;
    if (sk === 'nhi') return s ? s.nhi : (it.scan ? it.scan.nhi : -99);   // high → low (Matt 9-7-26)
    if (sk === 'dec') return -Math.abs(decOf(it));
    return 0;
  };
  if (sk !== 'order') {
    const idx = order.map((it, i) => [it, i]);
    idx.sort((a, b) => (val(b[0]) - val(a[0])) || (a[1] - b[1]));
    order = idx.map(x => x[0]);
  }
  LIST.order = order;
}

function decOf(it) {
  const [, dec] = C.lonlatOf(C.matTVec(D.M_SGR, C.unitVector1(it.lam, it.bet)));
  return dec;
}

// ---- background scoring (idle chunks; same rules as the live field) -----------------
export function invalidateScores() {
  scoreCache = new Map();
  for (const it of LIST.items) it.score = null;
  LIST.scored = 0;
  scoreGen++;                                  // a running pass restarts itself
  if (LIST.items.length && state.listSort !== 'order' && state.listSort !== 'dec') startScoring();
  else emit('list');
}

export function startScoring() {
  if (LIST.scoring) return;
  const todo = LIST.items.filter(it => !it.score);
  if (!todo.length) { LIST.scored = LIST.items.length; emit('list'); return; }
  LIST.scoring = { total: LIST.items.length };
  const gen = scoreGen;
  let k = 0;
  const step = () => {
    if (gen !== scoreGen) { LIST.scoring = null; startScoring(); return; }
    const t0 = performance.now();
    while (k < todo.length && performance.now() - t0 < 24) {
      const it = todo[k++];
      const R = computeField(it.lam, it.bet, it.fov, { light: true });
      it.score = {
        rungs: R.ladder.nRungs, tie: R.ladder.tie, targets: R.fibers.targets, qso: R.qq.length,
        nhi: R.hiTotal ? R.hiTotal.logMean : NaN, vMMT: R.vMMT, vMag: R.vMag, stars: R.idx.length,
        ladder: R.ladder.groups.map(g => g[0].dist).concat(R.ladder.qsoRung ? [Infinity] : []),
      };
      scoreCache.set(scoreKey(it), it.score);
    }
    LIST.scored = LIST.items.length - (todo.length - k);
    if (k < todo.length) { emit('list-progress'); nextTick(step); }
    else { LIST.scoring = null; applySort(); emit('list'); }
  };
  nextTick(step);
}

// Scheduling: setTimeout(0) while the tab is visible (a MessageChannel self-post starves
// every timer — tour, transitions, slides — for the whole pass; 9-7-26). In a hidden tab
// timers throttle to 1 Hz, so fall back to the MessageChannel there.
const _mc = new MessageChannel();
const _tickQueue = [];
_mc.port1.onmessage = () => { const fn = _tickQueue.shift(); if (fn) fn(); };
function nextTick(fn) {
  if (document.hidden) { _tickQueue.push(fn); _mc.port2.postMessage(0); }
  else setTimeout(fn, 0);
}

// ---- navigation ---------------------------------------------------------------------
export function currentItem() { return state.listPos >= 0 ? LIST.order[state.listPos] : null; }

export function gotoIndex(i, opts = {}) {
  if (!LIST.order.length) return;
  i = ((i % LIST.order.length) + LIST.order.length) % LIST.order.length;
  state.listPos = i;
  const it = LIST.order[i];
  if (Math.abs(state.fov - it.fov) > 1e-3) { state.fov = it.fov; emit('ui'); }
  replaceLock({ kind: 'list', id: `${it.src}:${it.ref}`, name: it.label, svy: it.svy, dist: it.dist });
  slideField(it.lam, it.bet, { keepLock: true });
  emit('list');
}
export function nearestIndex(lam, bet) {
  let best = -1, bd = -2;
  const u = C.unitVector1(lam, bet);
  LIST.order.forEach((it, i) => {
    const v = C.unitVector1(it.lam, it.bet);
    const d = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    if (d > bd) { bd = d; best = i; }
  });
  return best;
}
export function stepList(d) { if (LIST.order.length) gotoIndex((state.listPos < 0 ? (d > 0 ? -1 : 0) : state.listPos) + d); }

// ---- autoplay -----------------------------------------------------------------------
let playTimer = null;
export function isPlaying() { return !!playTimer; }
export function setPlaying(v, intervalMs = 2200) {
  if (!v) { clearInterval(playTimer); playTimer = null; emit('list'); return; }
  if (playTimer) return;
  stepList(1);
  playTimer = setInterval(() => stepList(1), intervalMs);
  emit('list');
}

// the collection position is kept when the user pans / clicks elsewhere (Matt 9-8-26):
// "next" continues from the last visited item rather than restarting at 1
