// Central state + pub/sub + shareable URL hash + saved fields (shared with v1/v2 via
// the same localStorage key and JSON format) + field history + animated field slides.
import { D } from './data.js';
import { convPoint, unitVector1, lonlatOf, matTVec } from './compute.js';

export const LS_KEY = 'viasual_saved_fields';
export const LS_PREFS = 'viasual3_prefs';

export const state = {
  lam0: 0, bet0: 0,            // field center, Sgr frame (set from meta on boot)
  fov: 1.0,                    // field DIAMETER [deg] — continuous 1..5 (snaps 1/2/3/5)
  mode: 'dist',                // dist | mag | hemi | stream
  glo: 11.0, ghi: 20.0,        // mag limit window
  hide: true,                  // hide sources outside mag limit
  streamSel: null,             // selected stream name or null
  gcSel: null,                 // selected GC index or null
  dwarfSel: null,              // selected dwarf index or null
  hlStream: true,              // highlight the selected stream (greys other streams)
  hlDwarf: true,               // highlight the selected dwarf (+ its members)
  hlGC: true,                  // highlight the selected GC
  via: false,                  // show only Via streams
  viaDwarfs: false,            // dwarfs: only those < 300 kpc (placeholder Via list)
  himap: 'total',              // background: total | hvc | overlay | dust
  hiSphere: false,             // HI shell in 3D
  coneKepler: false, coneM31: false, coneM82: false, // survey cones (independent; all off by default since 9-7-26)
  hemiCones: false,            // MMT/Magellan visibility cones (no UI since 9-7-26)
  theme: 'dark',               // whole-app theme (light mode retired 9-7-26)
  boxOn: false,                // 100 kpc reference box (no UI since 9-7-26)
  diskOn: true,                // galactic disk
  streamsOn: true, qsoOn: true, gcOn: true, dgOn: true, memOn: true, haloOn: false,
  kgOn: false, bhbOn: false, kepOn: false, mem2On: false,   // v3 catalogs (default off)
  cloudsOn: false, cloudFilter: 'all',   // all | compact | vhvc
  cloudHipass: true, cloudAlfalfa: true, cloudGass: true,
  cloudColor: 'none',          // none | vlsr | vgsr — color clouds by velocity
  viaOn: true,                 // overlay the ACTIVE field lists on the sky maps / finder
  viaSvy: { sps: false, dgs: false, cgs: false, krs: false, rbs: false, tfs: false }, // derived from listSrc
  via3d: false,                // active field lists as a shell of dots in 3D (15 kpc)
  sightOn: false,              // Bish+19 sightlines — derived from listSrc ('bish19')
  dust3dOn: false,             // Edenhofer+24 local 3D dust cloud in the 3D view
  connect: false,              // NN match lines on finder
  tab: 'field',                // dossier tab: field | sky
  lock: null,                  // {kind:'stream'|'gc'|'dwarf'|'cone', id, name, dist} go-to lock
  sidebar: true,               // left control sidebar open
  listsOpen: false,            // Field lists group open → player bar shown
  // field lists (v3)
  listSrc: [],                 // active field lists, e.g. ['via:sps','via:dgs'] or ['top'] or ['saved','bish19']
  listSort: 'order',           // order | rungs | targets | qso | nhi | dec
  listPos: -1,                 // index into the active list, -1 = none
  listOnlyVisible: false,      // filter: visible from at least one site
};

// the app's built-in defaults, captured before prefs/hash touch anything: share links encode
// flags relative to THESE, so a link reproduces the same view on any machine
const APP_DEFAULTS = JSON.parse(JSON.stringify(state));

const subs = new Map();   // topic -> Set<fn>
export function on(topics, fn) {
  for (const t of topics.split(' ')) {
    if (!subs.has(t)) subs.set(t, new Set());
    subs.get(t).add(fn);
  }
}
export function emit(topic, payload) {
  for (const fn of subs.get(topic) ?? []) fn(payload);
  for (const fn of subs.get('*') ?? []) fn(topic, payload);
}

// mutate state + notify. `set({fov: 3}, 'field')`
export function set(patch, topic) {
  Object.assign(state, patch);
  if ('listSrc' in patch) syncListFlags();
  emit(topic ?? 'ui');
  scheduleHash();
  savePrefs();
}

// the per-survey Via flags and the Bish+19 sightline flag are views of the active field
// lists (one control drives the player, the maps and the 3D shell — Matt 9-7-26)
export function syncListFlags() {
  for (const k of Object.keys(state.viaSvy)) state.viaSvy[k] = state.listSrc.includes(`via:${k}`);
  state.sightOn = state.listSrc.includes('bish19');
}

// ---- persisted preferences (sidebar, layer toggles) ---------------------------------
const PREF_KEYS = ['sidebar', 'listsOpen', 'viaOn', 'via3d', 'mem2On', 'kgOn', 'bhbOn', 'kepOn', 'haloOn',
  'cloudsOn', 'cloudHipass', 'cloudAlfalfa', 'cloudGass', 'cloudColor', 'diskOn', 'listSort'];
let prefTimer = null;
function savePrefs() {
  clearTimeout(prefTimer);
  prefTimer = setTimeout(() => {
    try {
      const p = {};
      for (const k of PREF_KEYS) p[k] = state[k];
      localStorage.setItem(LS_PREFS, JSON.stringify(p));
    } catch {}
  }, 300);
}
export function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(LS_PREFS) || '{}');
    for (const k of PREF_KEYS) if (k in p) state[k] = p[k];
  } catch {}
}

// ---- field history (back/forward through fields we actually stopped at) -----------
const hist = { list: [], pos: -1, navigating: false };
function pushHistory() {
  if (hist.navigating) return;
  const cur = { lam: state.lam0, bet: state.bet0, fov: state.fov, lock: state.lock };
  const last = hist.list[hist.pos];
  if (last && Math.abs(last.lam - cur.lam) < 1e-6 && Math.abs(last.bet - cur.bet) < 1e-6
      && Math.abs(last.fov - cur.fov) < 1e-3) return;
  hist.list.splice(hist.pos + 1);
  hist.list.push(cur);
  if (hist.list.length > 200) hist.list.shift();
  hist.pos = hist.list.length - 1;
  emit('history');
}
export function histState() { return { back: hist.pos > 0, fwd: hist.pos < hist.list.length - 1, list: hist.list, pos: hist.pos }; }
export function histSeed() { pushHistory(); }   // record the boot field so "back" works
export function histGo(step) {
  const p = hist.pos + step;
  if (p < 0 || p >= hist.list.length) return false;
  hist.pos = p;
  const f = hist.list[p];
  hist.navigating = true;
  state.fov = f.fov;
  state.lock = f.lock ?? null;
  slideField(f.lam, f.bet, { keepLock: true, fromHistory: true });
  hist.navigating = false;
  emit('history');
  return true;
}

// swap the go-to lock; if the outgoing lock changed the FOV (survey cones), restore it
// first so a 15° Kepler field can never leak into ordinary browsing
export function replaceLock(newLock) {
  const old = state.lock;
  if (old && Number.isFinite(old.restoreFov) && (!newLock || newLock.id !== old.id)) {
    state.fov = old.restoreFov;
  }
  state.lock = newLock;
  emit('lock');
}

export function setField(lam, bet, opts = {}) {
  state.lam0 = lam; state.bet0 = bet;
  // any field move not produced by the lock action itself clears the go-to lock;
  // a cone lock that changed the FOV restores the FOV that was in use before it
  if (!opts.keepLock && state.lock) {
    if (Number.isFinite(state.lock.restoreFov)) state.fov = state.lock.restoreFov;
    state.lock = null;
    emit('lock');
  }
  emit('field', opts);
  scheduleHash();
  if (!opts.live) {
    if (opts.fromHistory) { hist.navigating = true; }
    pushHistory();
    hist.navigating = false;
  }
}

// ---- animated field slide (damped ease-in-out along the great circle) -------------
let slideRaf = null, slideWatch = null;
export function slideField(lam, bet, opts = {}) {
  if (slideRaf) { cancelAnimationFrame(slideRaf); slideRaf = null; }
  if (slideWatch) { clearInterval(slideWatch); slideWatch = null; }
  const a = unitVector1(state.lam0, state.bet0);
  const b = unitVector1(lam, bet);
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  dot = Math.max(-1, Math.min(1, dot));
  const ang = Math.acos(dot);
  if (ang < 1e-4) { setField(lam, bet, opts); return; }
  // duration scales with distance but stays snappy (250 ms .. 900 ms)
  const dur = Math.min(900, 250 + (ang * 180 / Math.PI) * 6);
  const t0 = performance.now();
  const ease = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;  // easeInOutQuad
  const sinAng = Math.sin(ang);
  let lastTick = performance.now();
  const finish = () => {
    if (slideRaf) { cancelAnimationFrame(slideRaf); slideRaf = null; }
    if (slideWatch) { clearInterval(slideWatch); slideWatch = null; }
    setField(lam, bet, opts);
  };
  const step = now => {
    lastTick = performance.now();
    const u = Math.min(1, (now - t0) / dur);
    const t = ease(u);
    const w1 = Math.sin((1 - t) * ang) / sinAng, w2 = Math.sin(t * ang) / sinAng;
    const v = [a[0] * w1 + b[0] * w2, a[1] * w1 + b[1] * w2, a[2] * w1 + b[2] * w2];
    const [lm, bt] = lonlatOf(v);
    if (u < 1) {
      state.lam0 = lm; state.bet0 = bt;
      emit('field', { live: true, sliding: true });
      slideRaf = requestAnimationFrame(step);
    } else finish();
  };
  slideRaf = requestAnimationFrame(step);
  // rAF is throttled to zero in occluded/hidden windows — never leave a slide hanging
  slideWatch = setInterval(() => { if (performance.now() - lastTick > 350) finish(); }, 200);
}

export function galField() { return convPoint(D.M_SGR, D.M_GAL, state.lam0, state.bet0); }
export function icrsField() {
  const [ra, dec] = lonlatOf(matTVec(D.M_SGR, unitVector1(state.lam0, state.bet0)));
  return [(ra + 360) % 360, dec];
}

// ---- URL hash (shareable field links) -------------------------------------------
const HASH_KEYS = ['fov', 'mode', 'ghi', 'himap', 'tab'];
const FLAG_KEYS = ['streamsOn', 'qsoOn', 'gcOn', 'dgOn', 'memOn', 'haloOn', 'cloudsOn',
  'hide', 'via', 'viaDwarfs', 'hiSphere', 'coneKepler', 'coneM31', 'coneM82',
  'diskOn', 'kgOn', 'bhbOn', 'kepOn', 'mem2On', 'viaOn', 'dust3dOn', 'via3d'];
let hashTimer = null, applyingHash = false;

function scheduleHash() {
  if (applyingHash) return;
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const p = new URLSearchParams();
    // share links carry GALACTIC coordinates (Matt 8-20-26); lam/bet still parse
    const [gl, gb] = galField();
    p.set('l', gl.toFixed(3)); p.set('b', gb.toFixed(3));
    for (const k of HASH_KEYS) p.set(k, String(state[k]));
    const flags = FLAG_KEYS.filter(k => state[k] !== defaultsFlags[k]);
    if (flags.length) p.set('flip', flags.join(','));
    if (state.streamSel) p.set('stream', state.streamSel);
    if (state.listSrc.length) p.set('list', state.listSrc.join(','));
    history.replaceState(null, '', '#' + p.toString());
  }, 250);
}

const defaultsFlags = {};
export function initHash() {
  for (const k of FLAG_KEYS) defaultsFlags[k] = APP_DEFAULTS[k];
  if (!location.hash || location.hash.length < 2) return false;
  try {
    applyingHash = true;
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.has('l') && p.has('b')) {
      const [lam, bet] = convPoint(D.M_GAL, D.M_SGR, parseFloat(p.get('l')), parseFloat(p.get('b')));
      state.lam0 = lam; state.bet0 = bet;
    }
    if (p.has('lam')) state.lam0 = parseFloat(p.get('lam'));   // legacy links
    if (p.has('bet')) state.bet0 = parseFloat(p.get('bet'));
    if (p.has('fov')) state.fov = parseFloat(p.get('fov'));
    if (p.has('ghi')) state.ghi = parseFloat(p.get('ghi'));
    if (p.has('mode')) state.mode = p.get('mode');
    if (p.has('himap')) state.himap = p.get('himap');
    if (p.has('tab')) state.tab = p.get('tab');
    if (p.has('stream')) state.streamSel = p.get('stream');
    if (p.has('list')) state.listSrc = p.get('list').split(',').filter(Boolean);
    // a shared link fully specifies the flags: start from the app defaults, then flip
    if (p.has('flip') || (p.has('l') && p.has('b'))) for (const k of FLAG_KEYS) state[k] = defaultsFlags[k];
    for (const k of (p.get('flip') ?? '').split(',').filter(Boolean)) {
      if (k in defaultsFlags) state[k] = !defaultsFlags[k];
    }
    syncListFlags();
    return p.has('lam') || (p.has('l') && p.has('b'));
  } finally { applyingHash = false; }
}

// ---- saved fields (v1/v2-compatible) --------------------------------------------
export function loadSaved() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch { return []; }
}
export function storeSaved(list) { localStorage.setItem(LS_KEY, JSON.stringify(list)); emit('saved'); }
export function saveCurrentField(label = '') {
  const list = loadSaved();
  const [l, b] = galField();
  const entry = { lam: state.lam0, bet: state.bet0, l, b, fov: state.fov, ghi: state.ghi, label };
  if (state.lock) entry.obj = state.lock.name;   // saved while locked on an object
  list.unshift(entry);
  storeSaved(list);
  return list;
}
