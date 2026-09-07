// VIAsual v3 — app shell: boot, collapsible sidebar, tabs, field lists + player, saved
// fields + history (with ⌘Z / ⌘⇧Z), first-run tour, oracle verify.
const DATA_DIR = 'data';
export const CODE_VERSION = 'v3.1';

import { loadCore, loadQuaia, loadHalo, loadKgiants, loadBhb, loadKepler, loadGeha, loadDust, loadDust3d, D } from './data.js';
import {
  state, set, setField, slideField, replaceLock, on, emit, initHash, loadPrefs,
  loadSaved, storeSaved, saveCurrentField, galField, histState, histGo, histSeed,
} from './state.js';
import * as C from './compute.js';
import { initScales, applyTheme, bindHimap, UI, scales, SVY_COL, SVY_SHORT } from './colors.js';
import { initFieldModel, F, recompute } from './fieldmodel.js';
import { initScene, requestRender, restyle, tourCamera } from './scene3d.js';
import { initFinder } from './panels/finder.js';
import { initAllsky } from './panels/allsky.js';
import { initSgrmap } from './panels/sgrmap.js';
import { initLayers } from './panels/skylayers.js';
import { initHists } from './panels/hists.js';
import { initLadder } from './panels/ladder.js';
import { initStats } from './panels/stats.js';
import { initPlayer } from './panels/player.js';
import { initLists, SOURCES, LIST, GROUPS, EXTRA_LISTS, rebuild, gotoIndex, stepList, setPlaying, isPlaying, currentItem } from './lists.js';
import { initTour, startTour, tourDone } from './tour.js';

const $ = id => document.getElementById(id);
const FOV_SNAPS = [1, 2, 3, 5];
const DEFAULT_FIELD = { lam: -150.147, bet: 10.389 };   // GD-1 × Sagittarius overlap (Matt 8-20-26)
const LS_EXTRA = 'viasual3_extra_lists';

// ---- along-stream track (port of core.py _build_track / _track_pos) ----------------
const TRACK = { list: null, stream: null };
function buildTrack(sel, nbin = 40) {
  const idx = [];
  for (let i = 0; i < D.N; i++) if (D.streamName(i) === sel) idx.push(i);
  if (idx.length < 5) {
    let m = [0, 0, 0];
    for (const i of idx) { m[0] += D.UG_SGR[3 * i]; m[1] += D.UG_SGR[3 * i + 1]; m[2] += D.UG_SGR[3 * i + 2]; }
    const n = Math.hypot(...m) || 1;
    return [[0, [m[0] / n, m[1] / n, m[2] / n]]];
  }
  const cv = [0, 0, 0];
  for (const i of idx) { cv[0] += D.UG_SGR[3 * i]; cv[1] += D.UG_SGR[3 * i + 1]; cv[2] += D.UG_SGR[3 * i + 2]; }
  const cn = Math.hypot(...cv);
  const c = [cv[0] / cn, cv[1] / cn, cv[2] / cn];
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const tps = [];
  for (const i of idx) {
    const u = [D.UG_SGR[3 * i], D.UG_SGR[3 * i + 1], D.UG_SGR[3 * i + 2]];
    const d = u[0] * c[0] + u[1] * c[1] + u[2] * c[2];
    const t = [u[0] - d * c[0], u[1] - d * c[1], u[2] - d * c[2]];
    tps.push([t, u]);
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) S[a][b] += t[a] * t[b];
  }
  let v = [1, 0.3, 0.2];
  for (let k = 0; k < 60; k++) {
    const nv = [
      S[0][0] * v[0] + S[0][1] * v[1] + S[0][2] * v[2],
      S[1][0] * v[0] + S[1][1] * v[1] + S[1][2] * v[2],
      S[2][0] * v[0] + S[2][1] * v[1] + S[2][2] * v[2]];
    const nn = Math.hypot(...nv) || 1;
    v = [nv[0] / nn, nv[1] / nn, nv[2] / nn];
  }
  const ss = tps.map(([t]) => (t[0] * v[0] + t[1] * v[1] + t[2] * v[2]) * 180 / Math.PI);
  let sMin = Infinity, sMax = -Infinity;
  for (const s of ss) { if (s < sMin) sMin = s; if (s > sMax) sMax = s; }
  const track = [];
  for (let b = 0; b < nbin; b++) {
    const a0 = sMin + (sMax - sMin) * b / nbin, a1 = sMin + (sMax - sMin) * (b + 1) / nbin;
    let m = [0, 0, 0], cnt = 0;
    for (let k = 0; k < ss.length; k++) {
      if (ss[k] >= a0 && ss[k] <= a1) { const u = tps[k][1]; m[0] += u[0]; m[1] += u[1]; m[2] += u[2]; cnt++; }
    }
    if (cnt) {
      const nn = Math.hypot(...m);
      track.push([(a0 + a1) / 2, [m[0] / nn, m[1] / nn, m[2] / nn]]);
    }
  }
  return track;
}
function trackPos(phi) {
  const L = TRACK.list;
  if (L.length === 1) return C.lonlatOf(L[0][1]);
  let j = 1;
  while (j < L.length - 1 && L[j][0] < phi) j++;
  const [p0, v0] = L[j - 1], [p1, v1] = L[j];
  const t = Math.max(0, Math.min(1, (phi - p0) / ((p1 - p0) || 1)));
  const v = [v0[0] + (v1[0] - v0[0]) * t, v0[1] + (v1[1] - v0[1]) * t, v0[2] + (v1[2] - v0[2]) * t];
  return C.lonlatOf(v);
}

// ---- go-to actions (set the lock, slide the field) -----------------------------------
function gotoStream(sel) {
  TRACK.list = buildTrack(sel);
  TRACK.stream = sel;
  const phis = TRACK.list.map(t => t[0]);
  const mid = phis[Math.floor(phis.length / 2)];
  const sc = $('scan-stream');
  sc.min = Math.min(...phis); sc.max = Math.max(...phis);
  sc.step = (sc.max - sc.min) / 200 || 0.1;
  sc.value = mid;
  sc.disabled = false;
  replaceLock({ kind: 'stream', id: sel, name: sel });
  const [lam, bet] = trackPos(mid);
  slideField(lam, bet, { keepLock: true });
}
function gotoGC(i) {
  replaceLock({ kind: 'gc', id: i, name: D.GCC.name[i], dist: D.GCC.dist[i] });
  slideField(D.GCC.lam[i], D.GCC.bet[i], { keepLock: true });
}
function gotoDwarf(i) {
  replaceLock({ kind: 'dwarf', id: i, name: D.DWF.name[i], dist: D.DWF.dist[i] });
  slideField(D.DWF.lam[i], D.DWF.bet[i], { keepLock: true });
}
export function gotoCone(cone) {
  const sameCone = state.lock?.kind === 'cone' && state.lock.id === cone.key;
  const keepRestore = sameCone ? state.lock.restoreFov : undefined;
  replaceLock(null);
  const restoreFov = sameCone ? keepRestore
    : (Math.abs(state.fov - cone.fov) > 0.01 ? state.fov : undefined);
  state.fov = cone.fov;
  state.lock = { kind: 'cone', id: cone.key, name: cone.name, restoreFov };
  emit('lock');
  syncFov();
  const [lam, bet] = C.convPoint(D.M_GAL, D.M_SGR, cone.l, cone.b);
  slideField(lam, bet, { keepLock: true });
}
window.addEventListener('v2-goto-cone', e => {
  const cone = D.CONES.find(c => c.key === e.detail);
  if (cone) gotoCone(cone);
});
// jump to a Via pointing (from the maps / finder)
window.addEventListener('v3-goto-via', e => {
  const i = e.detail;
  const V = D.VIA;
  if (!V) return;
  if (state.fov > 1.001) { state.fov = 1; syncFov(); }
  replaceLock({ kind: 'via', id: i, name: V.name[i] || `${V.svy[i].toUpperCase()} tile ${V.tile[i]}`, svy: V.svy[i] });
  slideField(V.lam[i], V.bet[i], { keepLock: true });
});

// ---- sidebar construction ------------------------------------------------------------
function option(v, t, sel) { return `<option value="${v}"${sel ? ' selected' : ''}>${t}</option>`; }
const NONE_OPT = `<option value="">none selected</option>`;

let MEM_COUNTS = null;
function memCounts() {
  if (MEM_COUNTS) return MEM_COUNTS;
  MEM_COUNTS = new Map();
  if (D.MEM) for (const nm of D.MEM.name) MEM_COUNTS.set(nm, (MEM_COUNTS.get(nm) ?? 0) + 1);
  return MEM_COUNTS;
}
function syncNoneSel(sel) { sel.classList.toggle('nonesel', sel.value === ''); }
const sliderLeft = f => `calc(${(f * 100).toFixed(2)}% + ${(6.5 - 13 * f).toFixed(1)}px)`;   // 13 px thumb
function fovSnapDots() {
  return FOV_SNAPS.map(s => {
    const f = (s - 1) / 4;
    return `<span class="fov-dot" data-fov="${s}" style="left:${sliderLeft(f)}"></span>` +
      `<span class="fov-snap" data-fov="${s}" style="left:${sliderLeft(f)}">${s}<span class="deg">°</span></span>`;
  }).join('');
}

const fmtN = n => (n ?? 0).toLocaleString();
const CAT_SOURCES = [
  { src: 'BONACA & PW 24', url: 'https://ui.adsabs.harvard.edu/abs/2025NewAR.10001713B/abstract',
    num: () => fmtN(D.N), lab: () => `stream stars · ${D.STREAM_NAMES.length} streams (identical to Via's bonaca25 table)` },
  { src: 'BAUMGARDT+21', url: 'https://ui.adsabs.harvard.edu/abs/2021MNRAS.505.5957B/abstract',
    num: () => `${D.GCC.lam.length}`, lab: () => 'globular clusters' },
  { src: 'MCCONNACHIE+12 · PACE LVDB', url: 'https://ui.adsabs.harvard.edu/abs/2012AJ....144....4M/abstract',
    url2: 'https://github.com/apace7/local_volume_database',
    num: () => `${D.DWF.lam.length}`, lab: () => `dwarf galaxies (${D.DWF.src.filter(s => s.startsWith('LVDB')).length} post-2012 from LVDB v1.0.6)` },
  { src: 'BATTAGLIA+22', url: 'https://ui.adsabs.harvard.edu/abs/2022A%26A...657A..54B/abstract',
    num: () => fmtN(D.MEM.lam.length), lab: () => `members across ${memCounts().size} dwarfs (Gaia G)` },
  { src: 'GEHA+26', url: 'https://arxiv.org/abs/2602.10200',
    num: () => D.MEM2 ? fmtN(D.MEM2.lam.length) : '…', lab: () => 'DEIMOS dwarf members (predicted G; Via DGS input)' },
  { src: 'STOREY-FISHER+24', url: 'https://ui.adsabs.harvard.edu/abs/2024ApJ...964...69S/abstract',
    num: () => D.QSO ? fmtN(D.QSO.lam.length) : '…', lab: () => 'Quaia quasars · G < 20.5' },
  { src: 'CLEMENTINI+23', url: 'https://ui.adsabs.harvard.edu/abs/2023A%26A...674A..18C/abstract',
    num: () => D.HALO ? fmtN(D.HALO.lam.length) : '…', lab: () => 'halo RR Lyrae · |Z| > 3 kpc' },
  { src: 'CHANDRA (PRIV. COMM.)', url: 'https://github.com/via-project/viatarget/blob/main/src/viatarget/data/catalogs.toml',
    num: () => D.KG ? fmtN(D.KG.lam.length) : '…', lab: () => 'distant K giants, 10–125 kpc (Via KG class)' },
  { src: 'XUE+11', url: 'https://ui.adsabs.harvard.edu/abs/2011ApJ...738...79X/abstract',
    num: () => D.BHB ? fmtN(D.BHB.lam.length) : '…', lab: () => 'SDSS BHB stars, 2–77 kpc' },
  { src: 'KEPLER × GAIA DR3', url: 'https://github.com/via-project/viatarget/blob/main/src/viatarget/data/catalogs.toml',
    num: () => D.KEP ? fmtN(D.KEP.lam.length) : '…', lab: () => 'Kepler-field stars, parallax distances (Via KRS input)' },
  { src: 'VIA VISIT LISTS', url: 'https://via-project.org/#/survey',
    num: () => D.VIA ? fmtN(D.VIA.svy.length) : '—', lab: () => 'planned 1° pointings (cgs · dgs · krs · rbs · sps + approx. transients)' },
  { src: 'PUTMAN+02 · ADAMS+13 · MOSS+13', url: 'https://ui.adsabs.harvard.edu/abs/2002AJ....123..873P/abstract',
    url2: 'https://ui.adsabs.harvard.edu/abs/2013ApJS..209...12M/abstract',
    num: () => D.CLOUDS ? fmtN(D.CLOUDS.name.length) : '—', lab: () => 'HVC clouds (HIPASS + UCHVC + GASS)' },
  { src: 'HI4PI · WESTMEIER 18 · SFD98', url: 'https://ui.adsabs.harvard.edu/abs/2016A%26A...594A.116H/abstract',
    url2: 'https://ui.adsabs.harvard.edu/abs/1998ApJ...500..525S/abstract',
    num: () => '', lab: () => 'all-sky HI, HVC and dust maps' },
  { src: 'EDENHOFER+24', url: 'https://ui.adsabs.harvard.edu/abs/2024A%26A...685A..82E/abstract',
    num: () => D.DUST3D ? fmtN(D.DUST3D.n) : '…', lab: () => '3D dust voxels < 1.25 kpc (top 2% densest) + integrated sky slices' },
  { src: 'BISH+19', url: 'https://ui.adsabs.harvard.edu/abs/2019ApJ...882...76B/abstract',
    num: () => D.SIGHT?.bish19 ? `${D.SIGHT.bish19.name.length}` : '—', lab: () => 'Keck/HIRES Na I + Ca II BHB sightlines' },
];
function catalogsHtml() {
  return CAT_SOURCES.map(c => {
    const names = c.src.split(' · ');
    const links = c.url2
      ? `<a href="${c.url}" target="_blank" rel="noopener">${names.slice(0, -1).join(' · ')}</a> · <a href="${c.url2}" target="_blank" rel="noopener">${names[names.length - 1]}</a>`
      : `<a href="${c.url}" target="_blank" rel="noopener">${c.src}</a>`;
    return `<div class="cat-entry"><div class="sec-lab cat-src">${links}</div>` +
      `<div class="cat-num">${c.num() ? c.num() + ' ' : ''}<span class="tiny">${c.lab()}</span></div></div>`;
  }).join('');
}

// literature lists the user has added to "Custom" from the dropdown (remembered locally)
const EXTRA_ADDED = new Set();
function loadExtras() {
  try { for (const id of JSON.parse(localStorage.getItem(LS_EXTRA) || '[]')) EXTRA_ADDED.add(id); } catch {}
  for (const id of state.listSrc) if (EXTRA_LISTS.some(x => x.id === id)) EXTRA_ADDED.add(id);
}
function storeExtras() { try { localStorage.setItem(LS_EXTRA, JSON.stringify([...EXTRA_ADDED])); } catch {} }

function chipHtml(s) {
  const n = s.items().length;
  const x = s.extra ? `<span class="x" data-drop="${s.id}" title="remove this list">×</span>` : '';
  return `<button class="chip-btn ${state.listSrc.includes(s.id) ? 'on' : ''}" data-src="${s.id}" style="--svy:${s.color}" title="${s.title}">${s.short}<span class="n">${n}</span>${x}</button>`;
}
function chipsHtml(group) {
  return SOURCES.filter(s => s.group === group && (!s.extra || EXTRA_ADDED.has(s.id))).map(chipHtml).join('');
}
function addListOptions() {
  const left = EXTRA_LISTS.filter(x => !EXTRA_ADDED.has(x.id));
  return `<option value="">add a list from a survey / paper…</option>` +
    left.map(x => option(x.id, `${x.title} (${SOURCES.find(s => s.id === x.id)?.items().length ?? 0})`)).join('');
}

function buildSidebar() {
  const sortedStreams = (() => {
    const counts = new Map();
    for (let i = 0; i < D.N; i++) counts.set(D.streamName(i), (counts.get(D.streamName(i)) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([nm]) => nm);
  })();
  const gcOpts = [...D.GCC.name.keys()]
    .sort((a, b) => D.GCC.dist[a] - D.GCC.dist[b])
    .map(i => option(i, `${D.GCC.name[i]} · ${D.GCC.dist[i].toFixed(1)} kpc`, state.gcSel === i));
  const mc = memCounts();
  const dgIdx = [...D.DWF.name.keys()];
  const withMem = dgIdx.filter(i => mc.has(D.DWF.name[i])).sort((a, b) => D.DWF.dist[a] - D.DWF.dist[b]);
  const noMem = dgIdx.filter(i => !mc.has(D.DWF.name[i])).sort((a, b) => D.DWF.dist[a] - D.DWF.dist[b]);
  const dgOpt = i => {
    const n = mc.get(D.DWF.name[i]);
    return option(i, `${D.DWF.name[i]}${n ? ` (${n}★)` : ''} · ${D.DWF.dist[i].toFixed(1)} kpc`, state.dwarfSel === i);
  };
  const dgOpts = [...withMem.map(dgOpt), ...noMem.map(dgOpt)];
  const streamHead = scales.dist.css((10 - D.DIST_MIN) / (D.DIST_MAX - D.DIST_MIN));
  const chk = (id, key, label, sw, title = '') =>
    `<label title="${title}"><input type="checkbox" id="${id}" ${state[key] ? 'checked' : ''}> ${sw ? `<i class="sw ${sw}"></i>` : ''}${label}</label>`;

  $('fov-box').innerHTML = `
    <div class="row"><label><span>Field of view <b id="fov-v">${state.fov.toFixed(1)}</b>°</span><span class="tiny" id="fov-note"></span></label>
      <div class="fov-wrap">
        <input type="range" id="fov" min="1" max="5" step="0.1" value="${state.fov}">
        ${fovSnapDots()}
      </div>
    </div>`;

  $('sidebar-body').innerHTML = `
  <div id="core-controls">
    <div class="row"><label>color stars by</label>
      <select id="mode-sel">
        ${option('dist', 'Distance (kpc)', state.mode === 'dist')}
        ${option('mag', 'Magnitude (Gaia G)', state.mode === 'mag')}
        ${option('hemi', 'Visibility / site', state.mode === 'hemi')}
        ${option('stream', 'Stream identity', state.mode === 'stream')}
      </select>
    </div>
    <div class="row"><label>mag limit G ≤ <b id="ghi-v">${state.ghi.toFixed(1)}</b>
      <span class="inline-chk"><input type="checkbox" id="hide-chk" ${state.hide ? 'checked' : ''}> hide fainter</span></label>
      <input type="range" id="ghi" min="${D.GMIN.toFixed(2)}" max="${D.GMAX.toFixed(2)}" step="0.1" value="${state.ghi}">
    </div>
  </div>

  <details class="group" open>
    <summary>Catalogs <span class="sum-cap">— what counts as a target</span></summary>
    <div class="row checks catalogs"><label class="tiny sec-lab">structures with distances</label>
      ${chk('streams-chk', 'streamsOn', 'streams', 'str')}
      ${chk('dg-chk', 'dgOn', 'dwarfs', 'dg')}
      ${chk('gc-chk', 'gcOn', 'GCs', 'gc')}
    </div>
    <div class="row checks"><label class="tiny sec-lab">individual halo tracers (pair-rule rungs)</label>
      ${chk('halo-chk', 'haloOn', 'halo RRL', 'halo', 'Gaia DR3 RR Lyrae, |Z|>3 kpc, ~10% distances')}
      ${chk('kg-chk', 'kgOn', 'K giants', 'kg', 'Chandra distant K giants, isochrone distances 10-125 kpc')}
      ${chk('bhb-chk', 'bhbOn', 'BHB', 'bhb', 'Xue+11 SDSS blue horizontal branch stars, 2-77 kpc')}
      ${chk('kep-chk', 'kepOn', 'Kepler stars', 'kep', 'Gaia stars in the Kepler field, parallax distances (< 5 kpc)')}
    </div>
    <div class="row checks"><label class="tiny sec-lab">backlights at infinity</label>
      ${chk('qso-chk', 'qsoOn', 'quasars', 'qso')}
    </div>
    <div class="row checks"><label class="tiny sec-lab">stream / dwarf filters</label>
      ${chk('via-chk', 'via', 'Via streams only', '')}
      ${chk('via-dg-chk', 'viaDwarfs', 'dwarfs ≤ 300 kpc', '')}
    </div>
    <div class="row checks"><label class="tiny sec-lab">dwarf member stars</label>
      ${chk('mem-chk', 'memOn', 'Battaglia+22 (Gaia G)', 'mem')}
      ${chk('mem2-chk', 'mem2On', 'Geha+26 (predicted G)', 'mem2')}
    </div>
    <div class="row combo">
      <button id="disk-btn" class="cone-btn ${state.diskOn ? 'on' : ''}" style="--cone:#8a7ae0">show disk <span class="tiny">(R 10 · z 1 kpc, 3D)</span></button>
    </div>
  </details>

  <details class="group">
    <summary>Go to <span class="sum-cap">— streams · dwarfs · clusters · survey regions</span>
      <span class="sum-btns"><button id="reset-sel" class="micro-btn" title="clear all selections">reset</button></span>
    </summary>
    <div class="subhead" style="color:${streamHead}">Streams</div>
    <div class="row checks">
      <label><input type="checkbox" id="hl-stream" ${state.hlStream ? 'checked' : ''}> highlight selected</label>
    </div>
    <div class="row combo">
      <select id="stream-sel">${NONE_OPT}${sortedStreams.map(s => option(s, `${s}${D.VIA_SET.has(s) ? ' · Via' : ''}`, state.streamSel === s)).join('')}</select>
      <button id="stream-go" class="mini-btn" title="go to this stream">GO</button>
    </div>
    <div class="row"><label>scan along stream</label>
      <input type="range" id="scan-stream" disabled>
    </div>
    <div class="subdiv"></div>
    <div class="subhead" style="color:${UI.dwarf}">Dwarf galaxies</div>
    <div class="row checks">
      <label><input type="checkbox" id="hl-dwarf" ${state.hlDwarf ? 'checked' : ''}> highlight selected</label>
    </div>
    <div class="row combo">
      <select id="dg-sel">${NONE_OPT}${dgOpts.join('')}</select>
      <button id="dg-go" class="mini-btn" title="go to this dwarf">GO</button>
    </div>
    <div class="subdiv"></div>
    <div class="subhead" style="color:${UI.gc}">Globular clusters</div>
    <div class="row checks">
      <label><input type="checkbox" id="hl-gc" ${state.hlGC ? 'checked' : ''}> highlight selected</label>
    </div>
    <div class="row combo">
      <select id="gc-sel">${NONE_OPT}${gcOpts.join('')}</select>
      <button id="gc-go" class="mini-btn" title="go to this cluster">GO</button>
    </div>
    <div class="subdiv"></div>
    <div class="subhead">Survey regions <span class="tiny">(cones in 3D · circles on the maps)</span></div>
    ${D.CONES.map(c => `
    <div class="row combo cone-row">
      <button class="cone-btn" data-cone="${c.key}" style="--cone:${c.color}">${c.name} <span class="tiny">(${c.fov}°)</span></button>
      <button class="mini-btn cone-go" data-cone="${c.key}">GO</button>
    </div>`).join('')}
  </details>

  <details class="group" open>
    <summary>Field lists <span class="sum-cap">— step through fields</span>
      <span class="sum-btns">
        <button id="hist-back" class="micro-btn" title="previous field (⌘Z)">◀</button>
        <button id="hist-fwd" class="micro-btn" title="next field (⌘⇧Z)">▶</button>
      </span>
    </summary>
    <div class="list-top">
      <button id="ovl-sky" class="cone-btn ${state.viaOn ? 'on' : ''}" style="--cone:#d8a35a" title="draw the active lists' fields on the sky maps and the field view">Sky-map overlay</button>
      <button id="ovl-3d" class="cone-btn ${state.via3d ? 'on' : ''}" style="--cone:#d8a35a" title="active lists' pointing directions on a 15 kpc shell in the 3D view">3D overlay <span class="tiny">(15 kpc)</span></button>
    </div>
    <div class="row checks"><label class="tiny sec-lab">${GROUPS.via}</label></div>
    <div class="svy-chips" id="chips-via">${chipsHtml('via')}</div>
    <div class="row checks"><label class="tiny sec-lab">${GROUPS.top}</label></div>
    <div class="svy-chips" id="chips-top">${chipsHtml('top')}</div>
    <div class="row checks"><label class="tiny sec-lab">${GROUPS.custom}</label></div>
    <div class="svy-chips" id="chips-custom">${chipsHtml('custom')}</div>
    <div class="list-add"><select id="add-list">${addListOptions()}</select></div>
    <div class="row"><label class="sec-lab" id="cand-lab">FIELD IN ACTIVE LIST</label>
      <select id="cand-sel">${NONE_OPT}</select>
    </div>
    <div class="help">Toggle one or more lists to open the player under the 3D view. ← → step, space plays, sort by rungs / targets / HI. Via lists are the unique 1° pointings from the visit lists (Cold Gas subsurveys: PLANE 576 · HI_ABS 100 · HVC 100 · EXGAL 98 · SGR 30 · KEPLER 1); "Transients≈" is a seeded random approximation of where Rubin transients will appear.</div>
    <div class="row"><label class="sec-lab">SAVED FIELDS</label>
      <div class="save-row">
        <button id="save-field" class="mini-btn">save current field</button>
        <span class="save-col">
          <button id="export-saved" class="micro-btn">copy list</button>
          <button id="import-saved" class="micro-btn">paste list</button>
        </span>
      </div>
    </div>
    <div id="saved-list"></div>
  </details>

  <details class="group">
    <summary>Input catalogs</summary>
    <div id="catalog-list">${catalogsHtml()}</div>
  </details>`;

  wireSidebar();
  renderSaved();
  syncFov();
  syncHistory();
  syncLockButtons();
  refreshCandidates();
  for (const id of ['stream-sel', 'dg-sel', 'gc-sel']) syncNoneSel($(id));
}

function wireSidebar() {
  const fovEl = $('fov');
  fovEl.addEventListener('input', e => {
    let v = parseFloat(e.target.value);
    for (const s of FOV_SNAPS) if (Math.abs(v - s) < 0.15) { v = s; break; }
    e.target.value = v;
    set({ fov: v }, 'field');
    syncFov();
  });
  document.querySelectorAll('.fov-snap, .fov-dot').forEach(el => {
    el.addEventListener('click', () => {
      const v = parseFloat(el.dataset.fov);
      fovEl.value = v;
      set({ fov: v }, 'field');
      syncFov();
    });
  });

  // field lists: chips toggle a list (player + map overlay + 3D shell all follow)
  const toggleList = (id, on) => {
    const srcs = state.listSrc.filter(s => s !== id);
    if (on) srcs.push(id);
    setPlaying(false);
    set({ listSrc: srcs, listPos: -1 }, 'lists');
    rebuild();
  };
  for (const box of ['chips-via', 'chips-top', 'chips-custom']) {
    $(box).addEventListener('click', e => {
      const drop = e.target.closest?.('[data-drop]')?.dataset?.drop;
      if (drop) {
        e.stopPropagation();
        EXTRA_ADDED.delete(drop); storeExtras();
        if (state.listSrc.includes(drop)) toggleList(drop, false);
        refreshChips();
        return;
      }
      const id = e.target.closest?.('.chip-btn')?.dataset?.src;
      if (id) toggleList(id, !state.listSrc.includes(id));
    });
  }
  $('add-list').addEventListener('change', e => {
    const id = e.target.value;
    if (!id) return;
    EXTRA_ADDED.add(id); storeExtras();
    toggleList(id, true);
    refreshChips();
  });
  $('ovl-sky').addEventListener('click', e => { const v = !state.viaOn; e.currentTarget.classList.toggle('on', v); set({ viaOn: v }); });
  $('ovl-3d').addEventListener('click', e => { const v = !state.via3d; e.currentTarget.classList.toggle('on', v); set({ via3d: v }); });
  $('cand-sel').addEventListener('change', e => {
    syncNoneSel(e.target);
    if (e.target.value === '') return;
    gotoIndex(+e.target.value);
  });

  const dropLock = kind => { if (state.lock?.kind === kind) replaceLock(null); };
  $('stream-sel').addEventListener('change', e => {
    syncNoneSel(e.target); dropLock('stream'); set({ streamSel: e.target.value || null });
  });
  $('stream-go').addEventListener('click', () => { if (state.streamSel) gotoStream(state.streamSel); });
  $('scan-stream').addEventListener('input', e => {
    if (!TRACK.list) return;
    const [lam, bet] = trackPos(parseFloat(e.target.value));
    setField(lam, bet, { live: true, keepLock: true });
  });
  $('scan-stream').addEventListener('change', () => setField(state.lam0, state.bet0, { keepLock: true }));

  $('mode-sel').addEventListener('change', e => set({ mode: e.target.value }));
  const paintGhi = () => {
    const f = (state.ghi - D.GMIN) / (D.GMAX - D.GMIN) * 100;
    $('ghi').style.setProperty('--fill', f.toFixed(1) + '%');
  };
  $('ghi').addEventListener('input', e => {
    $('ghi-v').textContent = (+e.target.value).toFixed(1);
    set({ ghi: +e.target.value });
    paintGhi();
  });
  paintGhi();
  $('hide-chk').addEventListener('change', e => set({ hide: e.target.checked }));
  $('disk-btn').addEventListener('click', e => {
    const v = !state.diskOn;
    e.currentTarget.classList.toggle('on', v);
    set({ diskOn: v });
  });
  document.querySelectorAll('.cone-btn[data-cone]').forEach(b => {
    b.classList.toggle('on', !!state[b.dataset.cone]);
    b.addEventListener('click', () => {
      const key = b.dataset.cone;
      const v = !state[key];
      b.classList.toggle('on', v);
      set({ [key]: v });
    });
  });
  document.querySelectorAll('.cone-go').forEach(b => {
    b.addEventListener('click', () => {
      const cone = D.CONES.find(c => c.key === b.dataset.cone);
      if (cone) gotoCone(cone);
    });
  });

  const simple = [
    ['via-chk', 'via'], ['hl-stream', 'hlStream'], ['via-dg-chk', 'viaDwarfs'], ['hl-dwarf', 'hlDwarf'], ['hl-gc', 'hlGC'],
    ['streams-chk', 'streamsOn'], ['qso-chk', 'qsoOn'], ['gc-chk', 'gcOn'], ['dg-chk', 'dgOn'], ['mem-chk', 'memOn'],
    ['mem2-chk', 'mem2On'], ['halo-chk', 'haloOn'], ['kg-chk', 'kgOn'], ['bhb-chk', 'bhbOn'], ['kep-chk', 'kepOn'],
  ];
  for (const [id, key] of simple) $(id).addEventListener('change', e => set({ [key]: e.target.checked }));
  $('gc-sel').addEventListener('change', e => {
    syncNoneSel(e.target); dropLock('gc'); set({ gcSel: e.target.value === '' ? null : +e.target.value });
  });
  $('gc-go').addEventListener('click', () => { if (state.gcSel !== null) gotoGC(state.gcSel); });
  $('dg-sel').addEventListener('change', e => {
    syncNoneSel(e.target); dropLock('dwarf'); set({ dwarfSel: e.target.value === '' ? null : +e.target.value });
  });
  $('dg-go').addEventListener('click', () => { if (state.dwarfSel !== null) gotoDwarf(state.dwarfSel); });

  $('hist-back').addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); histGo(-1); });
  $('hist-fwd').addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); histGo(1); });
  $('reset-sel').addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation();
    for (const id of ['stream-sel', 'dg-sel', 'gc-sel']) { const el = $(id); el.value = ''; syncNoneSel(el); }
    if (['stream', 'gc', 'dwarf'].includes(state.lock?.kind)) replaceLock(null);
    set({ streamSel: null, gcSel: null, dwarfSel: null });
  });
  $('save-field').addEventListener('click', () => { saveCurrentField(); renderSaved(); });
  $('export-saved').addEventListener('click', async e => {
    const txt = JSON.stringify(loadSaved(), null, 1);
    try { await navigator.clipboard.writeText(txt); e.target.textContent = 'copied ✓'; }
    catch { window.prompt('copy this:', txt); }
    setTimeout(() => { e.target.textContent = 'copy list'; }, 1400);
  });
  $('import-saved').addEventListener('click', () => {
    const txt = window.prompt('paste a saved-fields JSON list:');
    if (!txt) return;
    try {
      const inc = JSON.parse(txt);
      if (Array.isArray(inc)) { storeSaved(inc.concat(loadSaved())); renderSaved(); }
    } catch { alert('could not parse that JSON'); }
  });

  window.addEventListener('v2-goto-stream', e => {
    $('stream-sel').value = e.detail;
    syncNoneSel($('stream-sel'));
    set({ streamSel: e.detail });
    gotoStream(e.detail);
    showTab('field');
  });
  window.addEventListener('v2-show-field-tab', () => showTab('field'));

  on('history', syncHistory);
  on('lock', syncLockButtons);
  on('field', syncLockButtons);
  on('field', syncFov);
  on('ui', syncFov);
  on('list', refreshCandidates);
  on('list', refreshChips);
  on('lists', refreshChips);
  on('catalog', refreshChips);
  on('saved', renderSaved);
  on('catalog', refreshCatalogs);
  document.getElementById('dossier').addEventListener('scroll', () => {
    document.getElementById('tooltip2d').style.display = 'none';
  }, { passive: true });
}

function refreshCatalogs() {
  const el = $('catalog-list');
  if (el) el.innerHTML = catalogsHtml();
}
function refreshChips() {
  if (!$('chips-via')) return;
  for (const id of state.listSrc) if (EXTRA_LISTS.some(x => x.id === id)) EXTRA_ADDED.add(id);
  for (const [box, g] of [['chips-via', 'via'], ['chips-top', 'top'], ['chips-custom', 'custom']]) $(box).innerHTML = chipsHtml(g);
  $('add-list').innerHTML = addListOptions();
  $('ovl-sky')?.classList.toggle('on', state.viaOn);
  $('ovl-3d')?.classList.toggle('on', state.via3d);
}

function syncFov() {
  const el = $('fov-v');
  if (!el) return;
  el.textContent = state.fov.toFixed(1);
  const fovEl = $('fov');
  if (fovEl && Math.abs(parseFloat(fovEl.value) - state.fov) > 0.01) {
    fovEl.value = Math.min(5, Math.max(1, state.fov));
  }
  $('fov-note').textContent = state.fov <= 1.001 ? 'one Via pointing' : `≈ ${Math.round(state.fov ** 2)} pointings`;
  for (const s of document.querySelectorAll('.fov-snap, .fov-dot')) {
    s.classList.toggle('active', Math.abs(parseFloat(s.dataset.fov) - state.fov) < 0.01);
  }
}

function syncHistory() {
  const h = histState();
  const b = $('hist-back'), f = $('hist-fwd');
  if (!b) return;
  b.disabled = !h.back;
  f.disabled = !h.fwd;
}

function syncLockButtons() {
  const L = state.lock;
  $('stream-go')?.classList.toggle('locked', L?.kind === 'stream');
  $('gc-go')?.classList.toggle('locked', L?.kind === 'gc');
  $('dg-go')?.classList.toggle('locked', L?.kind === 'dwarf');
  document.querySelectorAll('.cone-go').forEach(b =>
    b.classList.toggle('locked', L?.kind === 'cone' && L.id === b.dataset.cone));
  const sc = $('scan-stream');
  if (sc && L?.kind !== 'stream') sc.disabled = true;
}

// the "field in active list" dropdown mirrors the player's order + position
function refreshCandidates() {
  const sel = $('cand-sel');
  if (!sel) return;
  const opts = LIST.order.map((it, i) => {
    const sc = it.score ? ` · ${it.score.rungs}R` : '';
    return option(i, `${i + 1}. ${it.label}${it.sub ? ` · ${it.sub}` : ''}${sc}`, state.listPos === i);
  });
  sel.innerHTML = `${NONE_OPT}${opts.join('')}`;
  if (state.listPos >= 0) sel.value = String(state.listPos);
  syncNoneSel(sel);
  $('cand-lab').textContent = LIST.order.length ? `FIELD IN ACTIVE LIST (${LIST.order.length})` : 'FIELD IN ACTIVE LIST — none open';
}

export function fieldLabelHtml(f) {
  const fov = f.fov ? `${(+f.fov).toFixed(f.fov % 1 ? 1 : 0)}°` : '1°';
  const mid = f.obj ? f.obj : `<i>ℓ</i> ${f.l.toFixed(1)}, <i>b</i> ${f.b.toFixed(1)}`;
  const g = f.ghi ? ` • G ≤ ${(+f.ghi).toFixed(f.ghi % 1 ? 1 : 0)}` : '';
  return `${fov} • ${mid}${g}`;
}

function renderSaved() {
  const box = $('saved-list');
  if (!box) return;
  box.innerHTML = '';
  const list = loadSaved();
  if (!list.length) {
    box.innerHTML = `<span class="tiny">none yet — save the current field, or ☆ in the player</span>`;
    return;
  }
  list.forEach((f, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.innerHTML = fieldLabelHtml(f);
    lbl.title = `Λ=${f.lam.toFixed(2)} B=${f.bet.toFixed(2)}${f.fov ? ` · ${f.fov}°` : ''}`;
    const del = document.createElement('span');
    del.className = 'del';
    del.textContent = '×';
    del.addEventListener('click', e => {
      e.stopPropagation();
      const l2 = loadSaved(); l2.splice(i, 1); storeSaved(l2); renderSaved();
    });
    chip.append(lbl, del);
    chip.addEventListener('click', () => {
      if (f.fov) { state.fov = f.fov; syncFov(); }
      slideField(f.lam, f.bet);
    });
    box.appendChild(chip);
  });
}

// ---- tabs / sidebar / theme ---------------------------------------------------------------
function showTab(name) {
  state.tab = name;
  for (const t of document.querySelectorAll('.tab-btn')) t.classList.toggle('active', t.dataset.tab === name);
  for (const p of document.querySelectorAll('.tab-page')) p.style.display = p.dataset.tab === name ? '' : 'none';
  emit('fieldmodel', {});           // panels in the newly shown tab need a redraw
}
function setSidebar(open) {
  state.sidebar = open;
  $('layout').classList.toggle('sb-open', open);
  $('layout').classList.toggle('sb-closed', !open);
  set({ sidebar: open }, 'layout');
}

// ---- keyboard ---------------------------------------------------------------------------
function wireKeys() {
  window.addEventListener('keydown', e => {
    const tag = document.activeElement?.tagName;
    const typing = tag === 'INPUT' && document.activeElement.type !== 'checkbox' && document.activeElement.type !== 'range';
    if (typing || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (!document.getElementById('tour').hidden) return;
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      histGo(e.shiftKey ? 1 : -1);
      return;
    }
    if (meta) return;
    switch (e.key) {
      case 'ArrowLeft': if (state.listSrc.length) { e.preventDefault(); stepList(-1); } break;
      case 'ArrowRight': if (state.listSrc.length) { e.preventDefault(); stepList(1); } break;
      case ' ': if (state.listSrc.length) { e.preventDefault(); setPlaying(!isPlaying()); } break;
      case 'c': case 'C': setSidebar(!state.sidebar); break;
      case '?': startTour(); break;
      case 's': case 'S': if (!e.shiftKey) { saveCurrentField(); renderSaved(); } break;
    }
  });
}

// ---- oracle cross-check (numbers comparable to v1 / v2 / the notebook) --------------------
window.viasualVerify = function () {
  const [l0, b0] = galField();
  return {
    field: { lam: state.lam0, bet: state.bet0, l: l0, b: b0, ra: F.ra, dec: F.dec, fov: state.fov },
    nStars: F.idx.length,
    streams: Object.fromEntries(F.comp),
    gcs: F.gc.map(i => D.GCC.name[i]),
    dwarfs: F.dw.map(i => D.DWF.name[i]),
    nMembers: F.mm.length, nMembersGeha: F.mm2.length,
    nHalo: F.hh?.length ?? 0, nKg: F.kg.length, nBhb: F.bhb.length, nKep: F.kep.length,
    nQso: F.qq.length,
    nClouds: F.cloudsInField?.length ?? 0,
    nVia: F.via.length,
    hi: F.hi ? { peak: F.hi.peak, mean: F.hi.mean } : null,
    ebv: F.ebv,
    ladder: { nRungs: F.ladder.nRungs, structures: F.ladder.structures.map(r => `${r.dist.toFixed(1)}kpc ${r.kind} ${r.label} (n=${r.n})`) },
    visible: { MMT: F.vMMT, Magellan: F.vMag },
    list: { srcs: state.listSrc, n: LIST.order.length, pos: state.listPos },
  };
};

// ---- boot ------------------------------------------------------------------------------
async function boot() {
  const overlay = $('loading');
  const prog = $('load-progress');
  try {
    prog.textContent = 'loading catalogs…';
    loadPrefs();
    await loadCore(DATA_DIR, name => { prog.textContent = `loaded ${name}…`; });
    bindHimap(() => state.himap);
    initScales();
    state.lam0 = DEFAULT_FIELD.lam;
    state.bet0 = DEFAULT_FIELD.bet;
    state.glo = D.GMIN;
    state.ghi = Math.min(20.0, D.GMAX);
    initHash();                                   // may override from a shared link
    if (!['field', 'sky'].includes(state.tab)) state.tab = 'field';
    if (state.mode === 'dens') state.mode = 'dist';
    state.theme = 'dark';
    applyTheme('dark');
    loadExtras();
    $('layout').classList.toggle('sb-open', state.sidebar);
    $('layout').classList.toggle('sb-closed', !state.sidebar);
    histSeed();
    initFieldModel();
    initLists();
    buildSidebar();
    initScene($('scene'));
    initFinder($('finder-wrap'));
    initLadder($('ladder-wrap'));
    initStats($('stats-wrap'), $('bottom-bar'));
    initHists($('hists-wrap'));
    initLayers($('layers-wrap'));
    initAllsky($('allsky-wrap'));
    initSgrmap($('sgrmap-wrap'));
    initPlayer($('player'));
    let tourOpenedList = false;
    initTour({
      anchor: () => $('help-btn'),
      openSidebar: () => setSidebar(true),
      showTab: name => showTab(name),
      // a consistent start: the default field at 1°, the default 3D orientation
      reset: () => {
        showTab('field');
        if (['stream', 'gc', 'dwarf', 'cone', 'via', 'list'].includes(state.lock?.kind)) replaceLock(null);
        if (Math.abs(state.fov - 1) > 1e-3) { state.fov = 1; syncFov(); }
        slideField(DEFAULT_FIELD.lam, DEFAULT_FIELD.bet);
        tourCamera('reset');
      },
      camera: mode => tourCamera(mode),
      showPlayer: () => { if (!state.listSrc.length) { tourOpenedList = true; set({ listSrc: ['via:sps'] }, 'lists'); rebuild(); } },
      onEnd: () => {
        tourCamera('halo');
        showTab('field');
        if (tourOpenedList) { tourOpenedList = false; setPlaying(false); set({ listSrc: [], listPos: -1 }, 'lists'); rebuild(); }
      },
    });
    for (const t of document.querySelectorAll('.tab-btn')) t.addEventListener('click', () => showTab(t.dataset.tab));
    $('sb-toggle').addEventListener('click', () => setSidebar(!state.sidebar));
    $('help-btn').addEventListener('click', startTour);
    wireKeys();
    showTab(state.tab);
    recompute({});
    if (state.listSrc.length) rebuild();
    overlay.classList.add('done');
    setTimeout(() => overlay.remove(), 450);
    if (!tourDone()) setTimeout(startTour, 600);
    // lazy heavy catalogs — each arrival recomputes the field + refreshes the counts
    const lazy = [
      ['quaia', () => loadQuaia(DATA_DIR)], ['halo RRL', () => loadHalo(DATA_DIR)],
      ['K giants', () => loadKgiants(DATA_DIR)], ['BHB', () => loadBhb(DATA_DIR)],
      ['Kepler stars', () => loadKepler(DATA_DIR)], ['Geha members', () => loadGeha(DATA_DIR)],
      ['dust', () => loadDust(DATA_DIR)], ['3D dust', () => loadDust3d(DATA_DIR)],
    ];
    for (const [nm, fn] of lazy) {
      fn().then(n => { console.log(`[viasual3] ${nm} loaded: ${n}`); emit('catalog', nm); });
    }
    console.log(`[viasual3] boot ok — ${D.N} stars, load ${D.loadMs.toFixed(0)} ms`);
  } catch (err) {
    prog.innerHTML = `<span style="color:#e05252">failed to load: ${err.message}</span>`;
    console.error(err);
  }
}

boot();
