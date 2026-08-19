// Central state + pub/sub + shareable URL hash + saved fields (shared with v1 via
// the same localStorage key and JSON format).
import { D } from './data.js';
import { convPoint } from './compute.js';

export const LS_KEY = 'viasual_saved_fields';

export const state = {
  lam0: 0, bet0: 0,            // field center, Sgr frame (set from meta on boot)
  fov: 1.0,                    // field DIAMETER [deg]
  mode: 'dist',                // dist | mag | dens | hemi | stream
  glo: 11.0, ghi: 20.0,        // mag limit window
  hide: true,                  // hide sources outside mag limit
  stream: null,                // selected stream name or null (= all)
  isolate: false,              // show only selected stream
  via: false,                  // show only Via streams
  himap: 'total',              // total | hvc | overlay
  hiSphere: false,             // HI shell in 3D
  kepler: true,
  clean: false,                // clean 3D (for slides)
  qsoOn: true, gcOn: true, dgOn: true, memOn: true,
  zoom: 61,                    // 3D half-box [kpc]
  pairKind: 'dd',              // dd | dv | nn | dnn
  rescale: false,              // rescale colours to field
  connect: false,              // NN match lines on finder
  tab: 'field',                // dossier tab: field | sky | halo
};

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
  emit(topic ?? 'ui');
  scheduleHash();
}

export function setField(lam, bet, opts = {}) {
  state.lam0 = lam; state.bet0 = bet;
  emit('field', opts);
  scheduleHash();
}

export function galField() { return convPoint(D.M_SGR, D.M_GAL, state.lam0, state.bet0); }
export function icrsField() {
  // sgr -> icrs: v_icrs = M_SGR^T v ; lon in [0,360)
  const { matTVec, unitVector1, lonlatOf } = ctx;
  const [ra, dec] = lonlatOf(matTVec(D.M_SGR, unitVector1(state.lam0, state.bet0)));
  return [(ra + 360) % 360, dec];
}
import * as ctx from './compute.js';

// ---- URL hash (shareable field links) -------------------------------------------
const HASH_KEYS = ['fov', 'mode', 'ghi', 'himap', 'tab'];
let hashTimer = null, applyingHash = false;

function scheduleHash() {
  if (applyingHash) return;
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const p = new URLSearchParams();
    p.set('lam', state.lam0.toFixed(3)); p.set('bet', state.bet0.toFixed(3));
    for (const k of HASH_KEYS) p.set(k, String(state[k]));
    const flags = ['qsoOn', 'gcOn', 'dgOn', 'memOn', 'hide', 'via', 'isolate', 'hiSphere', 'kepler', 'clean']
      .filter(k => state[k] !== defaultsFlags[k]);
    if (flags.length) p.set('flip', flags.join(','));
    if (state.stream) p.set('stream', state.stream);
    history.replaceState(null, '', '#' + p.toString());
  }, 250);
}

const defaultsFlags = {};
export function initHash() {
  for (const k of ['qsoOn', 'gcOn', 'dgOn', 'memOn', 'hide', 'via', 'isolate', 'hiSphere', 'kepler', 'clean']) {
    defaultsFlags[k] = state[k];
  }
  if (!location.hash || location.hash.length < 2) return false;
  try {
    applyingHash = true;
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.has('lam')) state.lam0 = parseFloat(p.get('lam'));
    if (p.has('bet')) state.bet0 = parseFloat(p.get('bet'));
    if (p.has('fov')) state.fov = parseFloat(p.get('fov'));
    if (p.has('ghi')) state.ghi = parseFloat(p.get('ghi'));
    if (p.has('mode')) state.mode = p.get('mode');
    if (p.has('himap')) state.himap = p.get('himap');
    if (p.has('tab')) state.tab = p.get('tab');
    if (p.has('stream')) state.stream = p.get('stream');
    for (const k of (p.get('flip') ?? '').split(',').filter(Boolean)) {
      if (k in defaultsFlags) state[k] = !defaultsFlags[k];
    }
    return p.has('lam');
  } finally { applyingHash = false; }
}

// ---- saved fields (v1-compatible) -------------------------------------------------
export function loadSaved() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch { return []; }
}
export function storeSaved(list) { localStorage.setItem(LS_KEY, JSON.stringify(list)); }
export function saveCurrentField(label = '') {
  const list = loadSaved();
  const [l, b] = galField();
  list.unshift({ lam: state.lam0, bet: state.bet0, l, b, fov: state.fov, label });
  storeSaved(list);
  return list;
}
