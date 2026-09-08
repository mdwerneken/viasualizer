// VIAsual v3 — app shell: boot, collapsible sidebar, tabs, field lists + player, saved
// fields + history (with ⌘Z / ⌘⇧Z), first-run tour, oracle verify.
const DATA_DIR = 'data';
export const CODE_VERSION = 'v3.3';

import { loadCore, loadQuaia, loadHalo, loadKgiants, loadBhb, loadKepler, loadGeha, loadDust3d, D } from './data.js';
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
import { initLists, SOURCES, LIST, GROUPS, rebuild, gotoIndex, stepList, currentItem, nearestIndex } from './lists.js';
import { initTour, startTour } from './tour.js';

const $ = id => document.getElementById(id);
const FOV_SNAPS = [1, 2, 3, 4, 5];
const DEFAULT_FIELD = { lam: -150.147, bet: 10.389 };   // GD-1 × Sagittarius overlap (Matt 8-20-26)

// ---- along-stream track (port of core.py _build_track / _track_pos) ----------------
const TRACK = { list: null, stream: null };
function buildTrack(sel, nbin = 40) {
  const us = [];
  for (let i = 0; i < D.N; i++) if (D.streamName(i) === sel) us.push([D.UG_SGR[3 * i], D.UG_SGR[3 * i + 1], D.UG_SGR[3 * i + 2]]);
  const norm = v => { const n = Math.hypot(...v) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };
  if (us.length < 5) {
    const m = [0, 0, 0];
    for (const u of us) { m[0] += u[0]; m[1] += u[1]; m[2] += u[2]; }
    return [[0, norm(m)]];
  }
  // pole of the best-fit great circle = smallest-eigenvalue direction of the scatter
  // matrix (power iteration on tr(S)·I − S); the old tangent-plane projection folded
  // Sagittarius, which wraps most of the sky (Matt 9-7-26)
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const u of us) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) S[a][b] += u[a] * u[b];
  const tr = S[0][0] + S[1][1] + S[2][2];
  let p = [0.31, 0.53, 0.79];
  for (let k = 0; k < 80; k++) {
    p = norm([tr * p[0] - (S[0][0] * p[0] + S[0][1] * p[1] + S[0][2] * p[2]),
              tr * p[1] - (S[1][0] * p[0] + S[1][1] * p[1] + S[1][2] * p[2]),
              tr * p[2] - (S[2][0] * p[0] + S[2][1] * p[1] + S[2][2] * p[2])]);
  }
  const ref = Math.abs(p[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const e1 = norm([p[1] * ref[2] - p[2] * ref[1], p[2] * ref[0] - p[0] * ref[2], p[0] * ref[1] - p[1] * ref[0]]);
  const e2 = [p[1] * e1[2] - p[2] * e1[1], p[2] * e1[0] - p[0] * e1[2], p[0] * e1[1] - p[1] * e1[0]];
  // azimuth around the pole; start the parametrisation after the largest gap so a
  // partial arc reads 0 → span and a full loop stays continuous
  const phi = us.map(u => Math.atan2(u[0] * e2[0] + u[1] * e2[1] + u[2] * e2[2], u[0] * e1[0] + u[1] * e1[1] + u[2] * e1[2]) * 180 / Math.PI);
  const sorted = phi.slice().sort((a, b) => a - b);
  let start = sorted[0], gap = sorted[0] + 360 - sorted[sorted.length - 1];
  for (let k = 1; k < sorted.length; k++) if (sorted[k] - sorted[k - 1] > gap) { gap = sorted[k] - sorted[k - 1]; start = sorted[k]; }
  const ph = phi.map(x => ((x - start) % 360 + 360) % 360);
  const span = Math.max(1e-3, Math.max(...ph));
  const track = [];
  for (let b = 0; b < nbin; b++) {
    const a0 = span * b / nbin, a1 = span * (b + 1) / nbin;
    const m = [0, 0, 0]; let cnt = 0;
    for (let k = 0; k < ph.length; k++) if (ph[k] >= a0 && (ph[k] < a1 || (b === nbin - 1 && ph[k] <= a1))) { m[0] += us[k][0]; m[1] += us[k][1]; m[2] += us[k][2]; cnt++; }
    if (cnt) track.push([(a0 + a1) / 2, norm(m)]);
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
  if (cone.key === 'coneKepler' && !state.kepOn) { state.kepOn = true; $('cat-chips')?.querySelector('[data-key="kepOn"]')?.classList.add('on'); }
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
// Input catalogs, grouped by what they are used for. lab = one line after the count;
// note = an optional second line (only when it adds something)
const CAT_SOURCES = [
  { sec: 'Backlights', src: 'Bonaca & Price-Whelan 2025', url: 'https://ui.adsabs.harvard.edu/abs/2025NewAR.10001713B/abstract',
    num: () => fmtN(D.N), lab: () => 'stream stars', note: () => `${D.STREAM_NAMES.length} streams` },
  { sec: 'Backlights', src: 'Baumgardt & Vasiliev 2021', url: 'https://ui.adsabs.harvard.edu/abs/2021MNRAS.505.5957B/abstract',
    num: () => `${D.GCC.lam.length}`, lab: () => 'globular clusters' },
  { sec: 'Backlights', src: 'McConnachie 2012', url: 'https://ui.adsabs.harvard.edu/abs/2012AJ....144....4M/abstract',
    num: () => `${D.DWF.src.filter(s => !s.startsWith('LVDB')).length}`, lab: () => 'dwarf galaxies' },
  { sec: 'Backlights', src: 'Pace — Local Volume Database', url: 'https://github.com/apace7/local_volume_database',
    num: () => `${D.DWF.src.filter(s => s.startsWith('LVDB')).length}`, lab: () => 'dwarf galaxies', note: () => 'post-2012 discoveries, LVDB v1.0.6' },
  { sec: 'Backlights', src: 'Battaglia et al. 2022', url: 'https://ui.adsabs.harvard.edu/abs/2022A%26A...657A..54B/abstract',
    num: () => fmtN(D.MEM.lam.length), lab: () => 'dwarf member stars', note: () => `${memCounts().size} dwarfs · Gaia G` },
  { sec: 'Backlights', src: 'Geha et al. 2026', url: 'https://arxiv.org/abs/2602.10200',
    num: () => D.MEM2 ? fmtN(D.MEM2.lam.length) : '…', lab: () => 'DEIMOS dwarf members', note: () => 'predicted G · Via DGS input' },
  { sec: 'Backlights', src: 'Storey-Fisher et al. 2024 (Quaia)', url: 'https://ui.adsabs.harvard.edu/abs/2024ApJ...964...69S/abstract',
    num: () => D.QSO ? fmtN(D.QSO.lam.length) : '…', lab: () => 'quasars', note: () => 'G < 20.5' },
  { sec: 'Backlights', src: 'Clementini et al. 2023', url: 'https://ui.adsabs.harvard.edu/abs/2023A%26A...674A..18C/abstract',
    num: () => D.HALO ? fmtN(D.HALO.lam.length) : '…', lab: () => 'halo RR Lyrae', note: () => '|Z| > 3 kpc' },
  { sec: 'Backlights', src: 'Xue et al. 2011', url: 'https://ui.adsabs.harvard.edu/abs/2011ApJ...738...79X/abstract',
    num: () => D.BHB ? fmtN(D.BHB.lam.length) : '…', lab: () => 'SDSS BHB stars', note: () => '2–77 kpc' },
  { sec: 'Backlights', src: 'V. Chandra — K giants', url: null,
    num: () => D.KG ? fmtN(D.KG.lam.length) : '…', lab: () => 'distant K giants', note: () => '10–125 kpc · Via KG class · private communication' },
  { sec: 'Backlights', src: 'Kepler field × Gaia DR3', url: null,
    num: () => D.KEP ? fmtN(D.KEP.lam.length) : '…', lab: () => 'Kepler-field stars', note: () => 'parallax distances · Via KRS input' },
  { sec: 'Foregrounds', src: 'HI4PI — Ben Bekhti et al. 2016', url: 'https://ui.adsabs.harvard.edu/abs/2016A%26A...594A.116H/abstract',
    num: () => '', lab: () => 'all-sky HI column density', note: () => '5′ grid · 16′ beam' },
  { sec: 'Foregrounds', src: 'Westmeier 2018', url: 'https://ui.adsabs.harvard.edu/abs/2018MNRAS.474..289W/abstract',
    num: () => '', lab: () => 'HI4PI high-velocity gas', note: () => 'HVC column + v_LSR / v_GSR maps' },
  { sec: 'Foregrounds', src: 'Schlegel, Finkbeiner & Davis 1998', url: 'https://ui.adsabs.harvard.edu/abs/1998ApJ...500..525S/abstract',
    num: () => '', lab: () => 'dust E(B−V) map', note: () => 'all distances · 6′' },
  { sec: 'Foregrounds', src: 'Edenhofer et al. 2024', url: 'https://ui.adsabs.harvard.edu/abs/2024A%26A...685A..82E/abstract',
    num: () => '', lab: () => '3D dust sky slices', note: () => 'integrated to 300 / 600 / 1250 pc' },
  { sec: 'Foregrounds', src: 'Putman et al. 2002', url: 'https://ui.adsabs.harvard.edu/abs/2002AJ....123..873P/abstract',
    num: () => D.CLOUDS ? fmtN(D.CLOUDS.src.filter(x => x === 0).length) : '—', lab: () => 'HIPASS HVC clouds', note: () => 'southern sky' },
  { sec: 'Foregrounds', src: 'Adams et al. 2013', url: 'https://ui.adsabs.harvard.edu/abs/2013ApJ...768...77A/abstract',
    num: () => D.CLOUDS ? fmtN(D.CLOUDS.src.filter(x => x === 1).length) : '—', lab: () => 'ALFALFA ultra-compact HVCs' },
  { sec: 'Foregrounds', src: 'Moss et al. 2013', url: 'https://ui.adsabs.harvard.edu/abs/2013ApJS..209...12M/abstract',
    num: () => D.CLOUDS ? fmtN(D.CLOUDS.src.filter(x => x === 2).length) : '—', lab: () => 'GASS HVC clouds', note: () => 'southern sky' },
  { sec: 'Survey fields', src: 'Bish et al. 2019', url: 'https://ui.adsabs.harvard.edu/abs/2019ApJ...882...76B/abstract',
    num: () => D.SIGHT?.bish19 ? `${D.SIGHT.bish19.name.length}` : '—', lab: () => 'Na I + Ca II BHB sightlines', note: () => 'Keck/HIRES' },
  { sec: 'Survey fields', src: 'Via visit lists', url: 'https://via-project.org/#/survey',
    num: () => D.VIA ? fmtN(D.VIA.svy.length) : '—', lab: () => 'planned 1° pointings', note: () => 'cgs · dgs · krs · sps + random transients' },
];
function catalogsHtml() {
  // per section: linked entries first, unlinked (private / compiled) last
  const secs = [...new Set(CAT_SOURCES.map(c => c.sec))];
  let html = '';
  for (const sec of secs) {
    const rows = CAT_SOURCES.filter(c => c.sec === sec).sort((a, b) => (a.url ? 0 : 1) - (b.url ? 0 : 1));
    html += `<div class="cat-sec-head">${sec}</div>`;
    for (const c of rows) {
      const src = c.url ? `<a href="${c.url}" target="_blank" rel="noopener">${c.src}</a>` : `<span class="cat-plain">${c.src}</span>`;
      const note = c.note?.();
      html += `<div class="cat-entry"><div class="cat-src">${src}</div>` +
        `<div class="cat-num">${c.num() ? `<span class="cat-n">${c.num()}</span> ` : ''}<span class="tiny">${c.lab()}</span></div>` +
        (note ? `<div class="cat-note">${note}</div>` : '') + `</div>`;
    }
  }
  return html;
}

function chipHtml(s) {
  const n = s.items().length;
  return `<button class="chip-btn ${state.listSrc.includes(s.id) ? 'on' : ''}" data-src="${s.id}" style="--svy:${s.color}" title="${s.title}">${s.short}<span class="n">${n}</span></button>`;
}
function chipsHtml(group) {
  return SOURCES.filter(s => s.group === group).map(chipHtml).join('');
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
  const hlBtn = (id, key) => `<button class="hl-btn ${state[key] ? 'on' : ''}" id="${id}" title="highlight the selected object (grey out the rest)">highlight selected</button>`;
  const chk = (id, key, label, sw, title = '') =>
    `<label title="${title}"><input type="checkbox" id="${id}" ${state[key] ? 'checked' : ''}> ${sw ? `<i class="sw ${sw}"></i>` : ''}${label}</label>`;
  // catalog toggles as chips (color = the catalog's identity color)
  const cchip = (key, label, color, title = '') =>
    `<button class="chip-btn ${state[key] ? 'on' : ''}" data-key="${key}" style="--svy:${color}" title="${title}">${label}</button>`;

  $('fov-box').innerHTML = `
    <div class="row">
      <div class="fov-wrap">
        <input type="range" id="fov" min="1" max="5" step="0.1" value="${state.fov}">
        ${fovSnapDots()}
      </div>
    </div>`;

  $('sidebar-body').innerHTML = `
  <div id="core-controls">
    <div class="row"><label class="ctl-lab">color streams by</label>
      <select id="mode-sel">
        ${option('stream', 'Stream (match field view)', state.mode === 'stream')}
        ${option('dist', 'Distance (kpc)', state.mode === 'dist')}
        ${option('mag', 'Magnitude (Gaia G)', state.mode === 'mag')}
        ${option('hemi', 'Hemisphere visibility', state.mode === 'hemi')}
      </select>
    </div>
    <div class="row"><label class="ctl-lab lab-row"><span>limit G ≤ <b id="ghi-v">${state.ghi.toFixed(1)}</b></span>
      <button class="hl-btn ${state.hide ? 'on' : ''}" id="hide-chk" title="hide sources fainter than the limit everywhere">hide fainter sources</button></label>
      <input type="range" id="ghi" min="${D.GMIN.toFixed(2)}" max="${D.GMAX.toFixed(2)}" step="0.1" value="${state.ghi}">
    </div>
  </div>

  <details class="group" open>
    <summary>Save fields
      <span class="sum-btns">
        <button id="hist-back" class="micro-btn" title="previous field (⌘Z)">◀</button>
        <button id="hist-fwd" class="micro-btn" title="next field (⌘⇧Z)">▶</button>
      </span>
    </summary>
    <div class="row">
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

  <details class="group" open>
    <summary>Show catalogs</summary>
    <div id="cat-chips">
    <div class="row checks"><label class="tiny sec-lab">structures with distances</label></div>
    <div class="svy-chips">${cchip('streamsOn', 'streams', '#c05252')}${cchip('dgOn', 'dwarfs', UI.dwarf)}${cchip('gcOn', 'GCs', UI.gc)}</div>
    <div class="row checks sub"><label class="tiny sec-lab lab-row">Extragalactic <span class="lab-note">field view only</span></label></div>
    <div class="svy-chips">${cchip('qsoOn', 'quasars', UI.accent2)}</div>
    <div class="row checks sub"><label class="tiny sec-lab">individual halo stars</label></div>
    <div class="svy-chips">
      ${cchip('haloOn', 'halo RRL', UI.halo, 'Gaia DR3 RR Lyrae, |Z|>3 kpc, ~10% distances')}
      ${cchip('kgOn', 'K giants', UI.kg, 'Chandra distant K giants, isochrone distances 10-125 kpc')}
      ${cchip('bhbOn', 'BHB', UI.bhb, 'Xue+11 SDSS blue horizontal branch stars, 2-77 kpc')}
      ${cchip('kepOn', 'Kepler stars', UI.kep, 'Gaia stars in the Kepler field, parallax distances (< 5 kpc)')}
    </div>
    <div class="row checks sub"><label class="tiny sec-lab">dwarf member stars</label></div>
    <div class="svy-chips">${cchip('memOn', 'Battaglia+22 (Gaia G)', UI.member)}${cchip('mem2On', 'Geha+26 (predicted G)', UI.member2)}</div>
    <div class="row checks sub"><label class="tiny sec-lab">filters</label></div>
    <div class="svy-chips">${cchip('via', 'Via streams only', '#cfc8bb')}${cchip('viaDwarfs', 'dwarfs ≤ 300 kpc', '#cfc8bb')}</div>
    </div>
    <div class="row combo">
      <button id="disk-btn" class="cone-btn ${state.diskOn ? 'on' : ''}" style="--cone:#8a7ae0">show disk <span class="tiny">(R = 10 kpc, z = 1 kpc)</span></button>
    </div>
  </details>

  <details class="group" id="lists-group" ${state.listsOpen ? 'open' : ''}>
    <summary>Field collections</summary>
    <div class="list-top">
      <button id="ovl-sky" class="cone-btn ${state.viaOn ? 'on' : ''}" style="--cone:#cfc8bb" title="draw the active lists' fields on the sky maps and the field view">Overlay on 2D maps</button>
      <button id="ovl-3d" class="cone-btn ${state.via3d ? 'on' : ''}" style="--cone:#cfc8bb" title="active lists' pointing directions on a 15 kpc shell in the 3D view">Show in 3D</button>
    </div>
    <div class="row checks sub"><label class="tiny sec-lab">${GROUPS.top}</label></div>
    <div class="svy-chips stack" id="chips-top">${chipsHtml('top')}</div>
    <div class="row checks sub"><label class="tiny sec-lab">${GROUPS.via}</label></div>
    <div class="svy-chips" id="chips-via">${chipsHtml('via')}</div>
    <div class="row checks sub"><label class="tiny sec-lab">${GROUPS.custom}</label></div>
    <div class="svy-chips" id="chips-custom">${chipsHtml('custom')}</div>
  </details>

  <details class="group">
    <summary>Select an object
      <span class="sum-btns"><button id="reset-sel" class="micro-btn" title="clear all selections">reset</button></span>
    </summary>
    <div class="subhead" style="color:${streamHead}">Streams ${hlBtn('hl-stream', 'hlStream')}</div>
    <div class="row combo">
      <select id="stream-sel">${NONE_OPT}
        <optgroup label="— planned Via streams —">${sortedStreams.filter(s => D.VIA_SET.has(s)).map(s => option(s, s, state.streamSel === s)).join('')}</optgroup>
        <optgroup label="— other streams —">${sortedStreams.filter(s => !D.VIA_SET.has(s)).map(s => option(s, s, state.streamSel === s)).join('')}</optgroup>
      </select>
      <button id="stream-go" class="mini-btn" title="go to this stream">GO</button>
    </div>
    <div class="row"><label>scan along stream</label>
      <input type="range" id="scan-stream" disabled>
    </div>
    <div class="subdiv"></div>
    <div class="subhead" style="color:${UI.dwarf}">Dwarf galaxies ${hlBtn('hl-dwarf', 'hlDwarf')}</div>
    <div class="row combo">
      <select id="dg-sel">${NONE_OPT}${dgOpts.join('')}</select>
      <button id="dg-go" class="mini-btn" title="go to this dwarf">GO</button>
    </div>
    <div class="subdiv"></div>
    <div class="subhead" style="color:${UI.gc}">Globular clusters ${hlBtn('hl-gc', 'hlGC')}</div>
    <div class="row combo">
      <select id="gc-sel">${NONE_OPT}${gcOpts.join('')}</select>
      <button id="gc-go" class="mini-btn" title="go to this cluster">GO</button>
    </div>
    <div class="subdiv"></div>
    <div class="subhead">Survey regions</div>
    ${D.CONES.map(c => `
    <div class="row combo cone-row">
      <button class="cone-btn" data-cone="${c.key}" style="--cone:${c.color}">${c.name} <span class="tiny">(${c.fov}°)</span></button>
      <button class="mini-btn cone-go" data-cone="${c.key}">GO</button>
    </div>`).join('')}
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
  const snapFov = v => Math.round(v * 10) / 10;   // plain 0.1° steps all the way (no magnet at the integers)
  // live (cheap) updates while dragging, the full recompute + hash on release
  fovEl.addEventListener('input', e => {
    const v = snapFov(parseFloat(e.target.value));
    e.target.value = v;
    state.fov = v;
    emit('field', { live: true });
    syncFov();
  });
  fovEl.addEventListener('change', e => { set({ fov: snapFov(parseFloat(e.target.value)) }, 'field'); syncFov(); });
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
    set({ listSrc: srcs, listPos: -1 }, 'lists');
    rebuild();
  };
  for (const box of ['chips-via', 'chips-top', 'chips-custom']) {
    $(box).addEventListener('click', e => {
      const id = e.target.closest?.('.chip-btn')?.dataset?.src;
      if (id) toggleList(id, !state.listSrc.includes(id));
    });
  }
  $('ovl-sky').addEventListener('click', e => { const v = !state.viaOn; e.currentTarget.classList.toggle('on', v); set({ viaOn: v }); });
  $('ovl-3d').addEventListener('click', e => { const v = !state.via3d; e.currentTarget.classList.toggle('on', v); set({ via3d: v }); });
  $('lists-group').addEventListener('toggle', e => set({ listsOpen: e.target.open }, 'layout'));
  $('cat-chips').addEventListener('click', e => {
    const b = e.target.closest?.('.chip-btn[data-key]');
    if (!b) return;
    const v = !state[b.dataset.key];
    b.classList.toggle('on', v);
    set({ [b.dataset.key]: v });
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
  $('hide-chk').addEventListener('click', e => { const v = !state.hide; e.currentTarget.classList.toggle('on', v); set({ hide: v }); });
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

  for (const [id, key] of [['hl-stream', 'hlStream'], ['hl-dwarf', 'hlDwarf'], ['hl-gc', 'hlGC']]) {
    $(id).addEventListener('click', e => { const v = !state[key]; e.currentTarget.classList.toggle('on', v); set({ [key]: v }); });
  }
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
  for (const [box, g] of [['chips-via', 'via'], ['chips-top', 'top'], ['chips-custom', 'custom']]) $(box).innerHTML = chipsHtml(g);
  $('ovl-sky')?.classList.toggle('on', state.viaOn);
  $('ovl-3d')?.classList.toggle('on', state.via3d);
}

let coverN = 0;   // white 1° circles the finder tiled over the sources (FOV > 1°)
on('cover', n => { coverN = n; syncFov(); });
function syncFov() {
  const el = $('fov-title');
  if (!el) return;
  el.textContent = `${state.fov.toFixed(1)}°`;
  const fovEl = $('fov');
  if (fovEl && Math.abs(parseFloat(fovEl.value) - state.fov) > 0.01) {
    fovEl.value = Math.min(5, Math.max(1, state.fov));
  }
  $('fov-note').textContent = state.fov <= 1.001 ? '1 pointing'
    : `≈ ${Math.round(state.fov ** 2)} pointings${coverN ? ` (${coverN} selected)` : ''}`;
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
    const sc = it.score ? ` · ${it.score.rungs} rungs · ${it.score.targets} targets` : '';
    return option(i, `${i + 1}. ${it.label}${it.sub ? ` · ${it.sub}` : ''} — ${it.meta}${sc}`, state.listPos === i);
  });
  sel.innerHTML = `${NONE_OPT}${opts.join('')}`;
  if (state.listPos >= 0) sel.value = String(state.listPos);
  syncNoneSel(sel);
  $('cand-lab').textContent = LIST.order.length ? `Field in active list (${LIST.order.length})` : 'Field in active list — none open';
}

export function fieldLabelHtml(f) {
  const fov = f.fov ? `${(+f.fov).toFixed(f.fov % 1 ? 1 : 0)}°` : '1°';
  const mid = f.label ? f.label : f.obj ? f.obj : `<i>ℓ</i> ${f.l.toFixed(1)}, <i>b</i> ${f.b.toFixed(1)}`;
  const g = f.ghi ? ` • G ≤ ${(+f.ghi).toFixed(f.ghi % 1 ? 1 : 0)}` : '';
  return `${fov} • ${mid}${g}`;
}

function renderSaved() {
  const box = $('saved-list');
  if (!box) return;
  box.innerHTML = '';
  const list = loadSaved();
  if (!list.length) {
    box.innerHTML = `<span class="tiny">no fields saved yet</span>`;
    return;
  }
  list.forEach((f, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.innerHTML = fieldLabelHtml(f);
    lbl.title = `Λ=${f.lam.toFixed(2)} B=${f.bet.toFixed(2)}${f.fov ? ` · ${f.fov}°` : ''}`;
    const pen = document.createElement('span');
    pen.className = 'pen';
    pen.textContent = '✎';
    pen.title = 'rename this field';
    pen.addEventListener('click', e => {
      e.stopPropagation();
      const nm = window.prompt('name for this field:', f.label || f.obj || '');
      if (nm === null) return;
      const l2 = loadSaved(); l2[i].label = nm.trim(); storeSaved(l2); renderSaved();
    });
    const del = document.createElement('span');
    del.className = 'del';
    del.textContent = '×';
    del.addEventListener('click', e => {
      e.stopPropagation();
      const l2 = loadSaved(); l2.splice(i, 1); storeSaved(l2); renderSaved();
    });
    chip.append(lbl, pen, del);
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
    const freshLoad = !location.hash || location.hash.length < 2;   // base link → run the tutorial
    initHash();                                   // may override from a shared link
    if (!['field', 'sky'].includes(state.tab)) state.tab = 'field';
    if (state.mode === 'dens') state.mode = 'dist';
    state.theme = 'dark';
    applyTheme('dark');
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
    initLayers($('layers-wrap'), $('allsky-legend'));
    initAllsky($('allsky-wrap'));
    initSgrmap($('sgrmap-wrap'));
    initPlayer($('player'));
    let tourOpenedList = false, tourOpenedGroup = false;
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
      showPlayer: () => {
        if (!state.listsOpen) { tourOpenedGroup = true; $('lists-group').open = true; set({ listsOpen: true }, 'layout'); }
        if (!state.listSrc.length) {
          tourOpenedList = true;
          set({ listSrc: ['via:sps'] }, 'lists'); rebuild();
          const i = nearestIndex(state.lam0, state.bet0);     // the planned Streams field next to the start field
          if (i >= 0) gotoIndex(i);
        }
      },
      onEnd: () => {
        tourCamera('halo');
        showTab('field');
        if (tourOpenedList) {
          tourOpenedList = false; set({ listSrc: [], listPos: -1 }, 'lists'); rebuild();
          replaceLock(null); slideField(DEFAULT_FIELD.lam, DEFAULT_FIELD.bet);
        }
        tourOpenedGroup = false; $('lists-group').open = false; set({ listsOpen: false }, 'layout');
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
    if (freshLoad) setTimeout(startTour, 600);
    // lazy heavy catalogs — each arrival recomputes the field + refreshes the counts
    const lazy = [
      ['quaia', () => loadQuaia(DATA_DIR)], ['halo RRL', () => loadHalo(DATA_DIR)],
      ['K giants', () => loadKgiants(DATA_DIR)], ['BHB', () => loadBhb(DATA_DIR)],
      ['Kepler stars', () => loadKepler(DATA_DIR)], ['Geha members', () => loadGeha(DATA_DIR)],
      ['3D dust', () => loadDust3d(DATA_DIR)],
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
