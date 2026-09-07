// VIAsual v2 — app shell: boot, sidebar, tabs, saved fields + history, oracle verify.
const DATA_DIR = 'data';
export const CODE_VERSION = 'v2.6';

import { loadCore, loadQuaia, loadHalo, D } from './data.js';
import {
  state, set, setField, slideField, replaceLock, on, emit, initHash,
  loadSaved, storeSaved, saveCurrentField, galField, histState, histGo, histSeed,
} from './state.js';
import * as C from './compute.js';
import { initScales, UI, scales } from './colors.js';
import { initFieldModel, F, recompute } from './fieldmodel.js';
import { initScene, requestRender, restyle } from './scene3d.js';
import { initFinder } from './panels/finder.js';
import { initAllsky } from './panels/allsky.js';
import { initSgrmap } from './panels/sgrmap.js';
import { initHists } from './panels/hists.js';
import { initLadder } from './panels/ladder.js';
import { initStats } from './panels/stats.js';

const $ = id => document.getElementById(id);
const FOV_SNAPS = [1, 2, 3, 5];

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
  // tangent-plane components and its 3x3 scatter matrix
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const tps = [];
  for (const i of idx) {
    const u = [D.UG_SGR[3 * i], D.UG_SGR[3 * i + 1], D.UG_SGR[3 * i + 2]];
    const d = u[0] * c[0] + u[1] * c[1] + u[2] * c[2];
    const t = [u[0] - d * c[0], u[1] - d * c[1], u[2] - d * c[2]];
    tps.push([t, u]);
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) S[a][b] += t[a] * t[b];
  }
  // dominant eigenvector by power iteration
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
  const sMin = Math.min(...ss), sMax = Math.max(...ss);
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
  // interpolate between track bins (the old nearest-bin snap made scanning choppy)
  const L = TRACK.list;
  if (L.length === 1) return C.lonlatOf(L[0][1]);
  let j = 1;
  while (j < L.length - 1 && L[j][0] < phi) j++;
  const [p0, v0] = L[j - 1], [p1, v1] = L[j];
  const t = Math.max(0, Math.min(1, (phi - p0) / ((p1 - p0) || 1)));
  const v = [
    v0[0] + (v1[0] - v0[0]) * t,
    v0[1] + (v1[1] - v0[1]) * t,
    v0[2] + (v1[2] - v0[2]) * t,
  ];
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
  // re-clicking the locked cone keeps its original restore point; switching from
  // another cone restores that one's FOV first (replaceLock), then we record ours
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

// ---- sidebar construction ------------------------------------------------------------
function option(v, t, sel) { return `<option value="${v}"${sel ? ' selected' : ''}>${t}</option>`; }
const NONE_OPT = `<option value="">none selected</option>`;

// dwarf-member counts per galaxy (full catalog)
let MEM_COUNTS = null;
function memCounts() {
  if (MEM_COUNTS) return MEM_COUNTS;
  MEM_COUNTS = new Map();
  if (D.MEM) for (const nm of D.MEM.name) MEM_COUNTS.set(nm, (MEM_COUNTS.get(nm) ?? 0) + 1);
  return MEM_COUNTS;
}

function candGrid() {
  const pairs = new Map();
  for (const c of D.CANDIDATES) {
    const g = c.glim ?? 20;
    pairs.set(`${c.fov}|${g}`, { fov: c.fov, glim: g });
  }
  if (!pairs.size) return null;
  let best = null, bd = Infinity;
  for (const p of pairs.values()) {
    const d = Math.abs(p.fov - state.fov) * 2 + Math.abs(p.glim - state.ghi);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
function candOptions() {
  const best = candGrid();
  if (!best) return { html: '', lab: 'PROMISING FIELDS' };
  const list = D.CANDIDATES.filter(c => c.fov === best.fov && (c.glim ?? 20) === best.glim);
  const opt = c => option(D.CANDIDATES.indexOf(c),
    `${c.fov}° • ℓ ${c.l.toFixed(1)}, b ${c.b.toFixed(1)} • G ≤ ${best.glim}`);
  const top = list.filter(c => (c.sec ?? 'top') === 'top').map(opt).join('');
  const via = list.filter(c => c.sec === 'via').map(opt).join('');
  const html = `<optgroup label="top ${list.filter(c => (c.sec ?? 'top') === 'top').length}">${top}</optgroup>` +
    (via ? `<optgroup label="best with a Via stream">${via}</optgroup>` : '');
  return { html, lab: `PROMISING FIELDS (${best.fov}°, G≤${best.glim})` };
}

// mark selects that sit at "none selected" so the closed box shows the dim italic style
function syncNoneSel(sel) { sel.classList.toggle('nonesel', sel.value === ''); }

// slider fraction -> css left, compensating for the thumb width
const sliderLeft = f => `calc(${(f * 100).toFixed(2)}% + ${(7 - 14 * f).toFixed(1)}px)`;

function fovSnapDots() {
  return FOV_SNAPS.map(s => {
    const f = (s - 1) / 4;
    return `<span class="fov-dot" data-fov="${s}" style="left:${sliderLeft(f)}"></span>` +
      `<span class="fov-snap" data-fov="${s}" style="left:${sliderLeft(f)}">${s}<span class="deg">°</span></span>`;
  }).join('');
}

// ADS/arXiv sources for the Input Catalogs section
const CAT_SOURCES = [
  { src: 'BONACA & PW 24', url: 'https://ui.adsabs.harvard.edu/abs/2025NewAR.10001713B/abstract',
    num: () => `${D.N.toLocaleString()}`, lab: () => `stream stars · ${D.STREAM_NAMES.length} streams` },
  { src: 'BAUMGARDT+21', url: 'https://ui.adsabs.harvard.edu/abs/2021MNRAS.505.5957B/abstract',
    num: () => `${D.GCC.lam.length}`, lab: () => 'globular clusters' },
  { src: 'MCCONNACHIE+12', url: 'https://ui.adsabs.harvard.edu/abs/2012AJ....144....4M/abstract',
    num: () => `${D.DWF.lam.length}`, lab: () => 'dwarf galaxies' },
  { src: 'BATTAGLIA+22', url: 'https://ui.adsabs.harvard.edu/abs/2022A%26A...657A..54B/abstract',
    num: () => `${D.MEM.lam.length.toLocaleString()}`, lab: () => `members across ${memCounts().size} dwarfs` },
  { src: 'STOREY-FISHER+24', url: 'https://ui.adsabs.harvard.edu/abs/2024ApJ...964...69S/abstract',
    num: () => D.QSO ? D.QSO.lam.length.toLocaleString() : '…', lab: () => 'Quaia quasars · G < 20.5' },
  { src: 'CLEMENTINI+23', url: 'https://ui.adsabs.harvard.edu/abs/2023A%26A...674A..18C/abstract',
    num: () => D.HALO ? D.HALO.lam.length.toLocaleString() : '…', lab: () => 'halo RR Lyrae · |Z| > 3 kpc' },
  { src: 'PUTMAN+02 · ADAMS+13', url: 'https://ui.adsabs.harvard.edu/abs/2002AJ....123..873P/abstract',
    url2: 'https://ui.adsabs.harvard.edu/abs/2013ApJ...768...77A/abstract',
    num: () => D.CLOUDS ? D.CLOUDS.name.length.toLocaleString() : '—', lab: () => 'HVC clouds (HIPASS + UCHVC)' },
  { src: 'HI4PI (BEN BEKHTI+16) · WESTMEIER 18', url: 'https://ui.adsabs.harvard.edu/abs/2016A%26A...594A.116H/abstract',
    url2: 'https://ui.adsabs.harvard.edu/abs/2018MNRAS.474..289W/abstract',
    num: () => '', lab: () => 'all-sky HI maps' },
];
function catalogsHtml() {
  return CAT_SOURCES.map(c => {
    const names = c.src.split(' · ');
    const links = c.url2
      ? `<a href="${c.url}" target="_blank" rel="noopener">${names[0]}</a> · <a href="${c.url2}" target="_blank" rel="noopener">${names[1] ?? ''}</a>`
      : `<a href="${c.url}" target="_blank" rel="noopener">${c.src}</a>`;
    return `<div class="cat-entry"><div class="sec-lab cat-src">${links}</div>` +
      `<div class="cat-num">${c.num() ? c.num() + ' ' : ''}<span class="tiny">${c.lab()}</span></div></div>`;
  }).join('');
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
  const cand = candOptions();
  // stream subheading color: the distance colormap at ~10 kpc
  const streamHead = scales.dist.css((10 - D.DIST_MIN) / (D.DIST_MAX - D.DIST_MIN));

  $('sidebar').innerHTML = `
  <div class="brand">VIAsual</div>

  <div id="core-controls">
    <div class="row"><label>FOV <b id="fov-v">${state.fov.toFixed(1)}</b>° <span class="tiny" id="fov-note"></span></label>
      <div class="fov-wrap">
        <input type="range" id="fov" min="1" max="5" step="0.1" value="${state.fov}">
        ${fovSnapDots()}
      </div>
    </div>
    <div class="row"><label>color by</label>
      <select id="mode-sel">
        ${option('dist', 'Distance (kpc)', state.mode === 'dist')}
        ${option('mag', 'Magnitude (Gaia G)', state.mode === 'mag')}
        ${option('hemi', 'Visibility/site', state.mode === 'hemi')}
        ${option('stream', 'Streams', state.mode === 'stream')}
      </select>
    </div>
    <div class="row"><label>mag limit G ≤ <b id="ghi-v">${state.ghi.toFixed(1)}</b>
      <span class="inline-chk"><input type="checkbox" id="hide-chk" ${state.hide ? 'checked' : ''}> hide fainter</span></label>
      <input type="range" id="ghi" min="${D.GMIN.toFixed(2)}" max="${D.GMAX.toFixed(2)}" step="0.1" value="${state.ghi}">
    </div>
  </div>

  <details class="group">
    <summary>3D display</summary>
    <div class="row checks catalogs"><label class="tiny sec-lab">display objects</label>
      <label><input type="checkbox" id="streams-chk" ${state.streamsOn ? 'checked' : ''}> <i class="sw str"></i>streams</label>
      <label><input type="checkbox" id="dg-chk" ${state.dgOn ? 'checked' : ''}> <i class="sw dg"></i>dwarfs</label>
      <label><input type="checkbox" id="gc-chk" ${state.gcOn ? 'checked' : ''}> <i class="sw gc"></i>GCs</label>
      <label><input type="checkbox" id="qso-chk" ${state.qsoOn ? 'checked' : ''}> <i class="sw qso"></i>quasars</label>
      <label><input type="checkbox" id="halo-chk" ${state.haloOn ? 'checked' : ''}> <i class="sw halo"></i>halo RRL</label>
    </div>
    <div class="row"><label class="tiny sec-lab">display fields</label></div>
    ${D.CONES.map(c => `
    <div class="row combo cone-row">
      <button class="cone-btn" data-cone="${c.key}" style="--cone:${c.color}">${c.name} <span class="tiny">(${c.fov}°)</span></button>
      <button class="mini-btn cone-go" data-cone="${c.key}">GO</button>
    </div>`).join('')}
    <div class="row"><label class="tiny sec-lab">display options</label></div>
    <div class="row combo">
      <button id="disk-btn" class="cone-btn ${state.diskOn ? 'on' : ''}" style="--cone:#8a7ae0">disk (10 kpc)</button>
      <button id="hisph-btn" class="cone-btn ${state.hiSphere ? 'on' : ''}" style="--cone:#5b8fc9">HI shell</button>
    </div>
    <div class="row checks">
      <label><input type="checkbox" id="box-chk" ${state.boxOn ? 'checked' : ''}> ${D.BOX_R} kpc box</label>
      <label><input type="checkbox" id="hemi-cones" ${state.hemiCones ? 'checked' : ''}> site visibility</label>
    </div>
    <div class="row">
      <button id="theme-btn" class="theme-btn ${state.theme === 'light' ? 'on' : ''}">white background</button>
    </div>
  </details>

  <details class="group" open>
    <summary>Fields
      <span class="sum-btns">
        <button id="hist-back" class="micro-btn" title="back to the previous field">◀</button>
        <button id="hist-fwd" class="micro-btn" title="forward again">▶</button>
      </span>
    </summary>
    <div class="row"><label class="sec-lab" id="cand-lab">${cand.lab}</label>
      <select id="cand-sel">${NONE_OPT}${cand.html}</select>
    </div>
    <div class="row"><label class="sec-lab">SAVED FIELDS</label>
      <div class="save-row">
        <button id="save-field" class="mini-btn">save field</button>
        <span class="save-col">
          <button id="export-saved" class="micro-btn">copy list</button>
          <button id="import-saved" class="micro-btn">paste list</button>
        </span>
      </div>
    </div>
    <div id="saved-list"></div>
  </details>


  <details class="group" open>
    <summary>Targets
      <span class="sum-btns"><button id="reset-sel" class="micro-btn" title="clear all three selections">reset</button></span>
    </summary>
    <div class="subhead" style="color:${streamHead}">Streams</div>
    <div class="row checks">
      <label><input type="checkbox" id="via-chk" ${state.via ? 'checked' : ''}> Via only</label>
      <label><input type="checkbox" id="hl-stream" ${state.hlStream ? 'checked' : ''}> highlight selected</label>
    </div>
    <div class="row combo">
      <select id="stream-sel">${NONE_OPT}${sortedStreams.map(s => option(s, s, state.streamSel === s)).join('')}</select>
      <button id="stream-go" class="mini-btn" title="go to this stream">GO</button>
    </div>
    <div class="row"><label>scan along stream</label>
      <input type="range" id="scan-stream" disabled>
    </div>
    <div class="subdiv"></div>
    <div class="subhead" style="color:${UI.dwarf}">Dwarf galaxies</div>
    <div class="row checks">
      <label><input type="checkbox" id="via-dg-chk" ${state.viaDwarfs ? 'checked' : ''}> &le; 300 kpc</label>
      <label><input type="checkbox" id="hl-dwarf" ${state.hlDwarf ? 'checked' : ''}> highlight selected</label>
    </div>
    <div class="row combo">
      <select id="dg-sel">${NONE_OPT}${dgOpts.join('')}</select>
      <button id="dg-go" class="mini-btn" title="go to this dwarf">GO</button>
    </div>
    <div class="row checks">
      <label><input type="checkbox" id="mem-chk" ${state.memOn ? 'checked' : ''}> display members</label>
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
  </details>

  <details class="group">
    <summary>Clouds</summary>
    <div class="row"><select id="himap-sel">
      ${option('total', 'Total N(HI) (all v)', state.himap === 'total')}
      ${option('hvc', 'High-velocity (HVC)', state.himap === 'hvc')}
      ${option('overlay', 'Total + HVC overlay', state.himap === 'overlay')}
    </select></div>
    <div class="row checks">
      <label><input type="checkbox" id="clouds-chk" ${state.cloudsOn ? 'checked' : ''}> <i class="sw cloud"></i>HVC clouds</label>
    </div>
    <div class="row"><label>cloud subset</label>
      <select id="cloud-filter">
        <option value="all"${state.cloudFilter === 'all' ? ' selected' : ''}>all (Putman+02 + UCHVC)</option>
        <option value="compact"${state.cloudFilter === 'compact' ? ' selected' : ''}>compact only (CHVC + UCHVC)</option>
        <option value="vhvc"${state.cloudFilter === 'vhvc' ? ' selected' : ''}>very high velocity (|vLSR| ≥ 200)</option>
      </select>
    </div>
  </details>

  <details class="group">
    <summary>Input Catalogs</summary>
    <div id="catalog-list">${catalogsHtml()}</div>
  </details>`;

  wireSidebar();
  renderSaved();
  syncFov();
  syncHistory();
  syncLockButtons();
  for (const id of ['cand-sel', 'stream-sel', 'dg-sel', 'gc-sel']) syncNoneSel($(id));
}

function wireSidebar() {
  // FOV slider with snap points
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

  $('cand-sel').addEventListener('change', e => {
    syncNoneSel(e.target);
    if (e.target.value === '') return;
    const c = D.CANDIDATES[+e.target.value];
    state.fov = c.fov;
    syncFov();
    slideField(c.lam, c.bet);
  });

  // changing a dropdown after a GO drops that GO's lock (the button unhighlights)
  const dropLock = kind => {
    if (state.lock?.kind === kind) replaceLock(null);
  };
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
    const el = $('ghi');
    const f = (state.ghi - D.GMIN) / (D.GMAX - D.GMIN) * 100;
    el.style.setProperty('--fill', f.toFixed(1) + '%');
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
  $('hisph-btn').addEventListener('click', e => {
    const v = !state.hiSphere;
    e.currentTarget.classList.toggle('on', v);
    set({ hiSphere: v });
  });
  $('box-chk').addEventListener('change', e => set({ boxOn: e.target.checked }));
  $('hemi-cones').addEventListener('change', e => set({ hemiCones: e.target.checked }));
  $('theme-btn').addEventListener('click', e => {
    const light = state.theme !== 'light';
    set({ theme: light ? 'light' : 'dark' });
    e.target.classList.toggle('on', light);
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

  $('via-chk').addEventListener('change', e => set({ via: e.target.checked }));
  $('hl-stream').addEventListener('change', e => set({ hlStream: e.target.checked }));
  $('via-dg-chk').addEventListener('change', e => set({ viaDwarfs: e.target.checked }));
  $('hl-dwarf').addEventListener('change', e => set({ hlDwarf: e.target.checked }));
  $('hl-gc').addEventListener('change', e => set({ hlGC: e.target.checked }));
  $('gc-sel').addEventListener('change', e => {
    syncNoneSel(e.target); dropLock('gc'); set({ gcSel: e.target.value === '' ? null : +e.target.value });
  });
  $('gc-go').addEventListener('click', () => { if (state.gcSel !== null) gotoGC(state.gcSel); });
  $('dg-sel').addEventListener('change', e => {
    syncNoneSel(e.target); dropLock('dwarf'); set({ dwarfSel: e.target.value === '' ? null : +e.target.value });
  });
  $('dg-go').addEventListener('click', () => { if (state.dwarfSel !== null) gotoDwarf(state.dwarfSel); });
  document.querySelectorAll('.cone-go').forEach(b => {
    b.addEventListener('click', () => {
      const cone = D.CONES.find(c => c.key === b.dataset.cone);
      if (cone) gotoCone(cone);
    });
  });

  $('streams-chk').addEventListener('change', e => set({ streamsOn: e.target.checked }));
  $('qso-chk').addEventListener('change', e => set({ qsoOn: e.target.checked }));
  $('gc-chk').addEventListener('change', e => set({ gcOn: e.target.checked }));
  $('dg-chk').addEventListener('change', e => set({ dgOn: e.target.checked }));
  $('mem-chk').addEventListener('change', e => set({ memOn: e.target.checked }));
  $('halo-chk').addEventListener('change', e => set({ haloOn: e.target.checked }));
  $('himap-sel').addEventListener('change', e => set({ himap: e.target.value }));
  $('clouds-chk').addEventListener('change', e => set({ cloudsOn: e.target.checked }));
  $('cloud-filter').addEventListener('change', e => set({ cloudFilter: e.target.value }));

  // the history arrows live inside the <summary>: don't let clicks toggle the section
  $('hist-back').addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); histGo(-1); });
  $('hist-fwd').addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); histGo(1); });
  // Targets summary "reset": all three selections back to none selected
  $('reset-sel').addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation();
    for (const id of ['stream-sel', 'dg-sel', 'gc-sel']) {
      const el = $(id);
      el.value = '';
      syncNoneSel(el);
    }
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
  on('ui', refreshCandidates);
  on('field', refreshCandidates);
  on('field', syncFov);            // fov can change via history / cones / saved chips
  on('ui', syncFov);
  on('quaia', refreshCatalogs);
  on('halo', refreshCatalogs);
  // a lingering hover tooltip after scrolling the dossier
  document.getElementById('dossier').addEventListener('scroll', () => {
    document.getElementById('tooltip2d').style.display = 'none';
  }, { passive: true });
}

function refreshCatalogs() {
  const el = $('catalog-list');
  if (el) el.innerHTML = catalogsHtml();
}

function syncFov() {
  const el = $('fov-v');
  if (!el) return;
  el.textContent = state.fov.toFixed(1);
  const fovEl = $('fov');
  if (fovEl && Math.abs(parseFloat(fovEl.value) - state.fov) > 0.01) {
    fovEl.value = Math.min(5, Math.max(1, state.fov));
  }
  $('fov-note').textContent = state.fov <= 1.001 ? 'Via field' : `≈ ${Math.round(state.fov ** 2)} pointings`;
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

let candKey = '';
function refreshCandidates() {
  const sel = $('cand-sel');
  if (!sel) return;
  const key = `${state.fov}|${state.ghi}`;
  if (key === candKey) return;
  candKey = key;
  const cand = candOptions();
  sel.innerHTML = `${NONE_OPT}${cand.html}`;
  syncNoneSel(sel);
  $('cand-lab').textContent = cand.lab;
}

// saved-field label: `1° • ℓ −28.9, b 79.8 • G ≤ 20` (object name replaces the
// coordinates when the field was saved while locked on an object)
export function fieldLabelHtml(f) {
  const fov = f.fov ? `${(+f.fov).toFixed(f.fov % 1 ? 1 : 0)}°` : '1°';
  const mid = f.obj ? f.obj
    : `<i>ℓ</i> ${f.l.toFixed(1)}, <i>b</i> ${f.b.toFixed(1)}`;
  const g = f.ghi ? ` • G ≤ ${(+f.ghi).toFixed(f.ghi % 1 ? 1 : 0)}` : '';
  return `${fov} • ${mid}${g}`;
}

function renderSaved() {
  const box = $('saved-list');
  box.innerHTML = '';
  const list = loadSaved();
  if (!list.length) {
    box.innerHTML = `<span class="tiny">none yet — ☆ saves the current field</span>`;
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

// ---- tabs ------------------------------------------------------------------------
function showTab(name) {
  state.tab = name;
  for (const t of document.querySelectorAll('.tab-btn')) {
    t.classList.toggle('active', t.dataset.tab === name);
  }
  for (const p of document.querySelectorAll('.tab-page')) {
    p.style.display = p.dataset.tab === name ? '' : 'none';
  }
  emit('fieldmodel', {});           // panels in the newly shown tab need a redraw
}

// ---- oracle cross-check (numbers comparable to v1 / the notebook) --------------------
window.viasualVerify = function () {
  const [l0, b0] = galField();
  return {
    field: { lam: state.lam0, bet: state.bet0, l: l0, b: b0, ra: F.ra, dec: F.dec, fov: state.fov },
    nStars: F.idx.length,
    streams: Object.fromEntries(F.comp),
    gcs: F.gc.map(i => D.GCC.name[i]),
    dwarfs: F.dw.map(i => D.DWF.name[i]),
    nMembers: F.mm.length,
    nHalo: F.hh?.length ?? 0,
    nQso: F.qq.length,
    nClouds: F.cloudsInField?.length ?? 0,
    clouds: (F.cloudsInField ?? []).slice(0, 12).map(i => D.CLOUDS.name[i]),
    hi: F.hi ? { peak: F.hi.peak, mean: F.hi.mean } : null,
    ladder: { nRungs: F.ladder.nRungs, structures: F.ladder.structures.map(r => `${r.dist.toFixed(1)}kpc ${r.kind} ${r.label} (n=${r.n})`) },
    visible: { MMT: F.vMMT, Magellan: F.vMag },
  };
};

// ---- boot ------------------------------------------------------------------------------
async function boot() {
  const overlay = $('loading');
  const prog = $('load-progress');
  try {
    prog.textContent = 'loading catalogs…';
    await loadCore(DATA_DIR, name => { prog.textContent = `loaded ${name}…`; });
    initScales();
    state.lam0 = -150.147;      // default field: a GD-1 x Sagittarius overlap (Matt 8-20-26)
    state.bet0 = 10.389;
    state.glo = D.GMIN;
    state.ghi = Math.min(20.0, D.GMAX);
    initHash();                                   // may override from a shared link
    if (state.tab === 'halo') state.tab = 'field';   // the halo tab is gone (8-20-26)
    if (state.mode === 'dens') state.mode = 'dist';  // density coloring removed (8-20-26)
    histSeed();
    initFieldModel();
    buildSidebar();
    initScene($('scene'));
    initFinder($('finder-wrap'));
    initLadder($('ladder-wrap'));
    initStats($('stats-wrap'), $('bottom-bar'));
    initHists($('hists-wrap'));
    initAllsky($('allsky-wrap'));
    initSgrmap($('sgrmap-wrap'));
    for (const t of document.querySelectorAll('.tab-btn')) {
      t.addEventListener('click', () => showTab(t.dataset.tab));
    }
    showTab(state.tab);
    recompute({});
    overlay.classList.add('done');
    setTimeout(() => overlay.remove(), 450);
    // lazy heavy catalogs
    loadQuaia(DATA_DIR).then(n => {
      console.log(`[viasual2] quaia loaded: ${n}`);
      emit('quaia');
    });
    loadHalo(DATA_DIR).then(n => {
      if (n) { console.log(`[viasual2] halo RRL loaded: ${n}`); emit('halo'); }
    });
    console.log(`[viasual2] boot ok — ${D.N} stars, load ${D.loadMs.toFixed(0)} ms`);
  } catch (err) {
    prog.innerHTML = `<span style="color:#e05252">failed to load: ${err.message}</span>`;
    console.error(err);
  }
}

boot();
