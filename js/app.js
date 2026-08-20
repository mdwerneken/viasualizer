// VIAsual v2 — app shell: boot, sidebar, tabs, saved fields + history, oracle verify.
const DATA_DIR = 'data';
export const CODE_VERSION = 'v2.2';

import { loadCore, loadQuaia, loadHalo, D } from './data.js';
import {
  state, set, setField, slideField, on, emit, initHash,
  loadSaved, storeSaved, saveCurrentField, galField, histState, histGo, histSeed,
} from './state.js';
import * as C from './compute.js';
import { initScales, UI } from './colors.js';
import { initFieldModel, F, recompute } from './fieldmodel.js';
import { initScene, requestRender, restyle } from './scene3d.js';
import { initFinder } from './panels/finder.js';
import { initAllsky } from './panels/allsky.js';
import { initSgrmap } from './panels/sgrmap.js';
import { initHists } from './panels/hists.js';
import { initLadder } from './panels/ladder.js';
import { initStats } from './panels/stats.js';
import { initHalo, maybeBuild as buildHalo } from './panels/halo.js';

const $ = id => document.getElementById(id);
const FOV_SNAPS = [1, 2, 3, 5];
const GLIM_GRID = [16, 17, 18, 19, 20, 20.5];

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
  let best = null, bd = Infinity;
  for (const [p, v] of TRACK.list) {
    const d = Math.abs(p - phi);
    if (d < bd) { bd = d; best = v; }
  }
  return C.lonlatOf(best);
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
  state.lock = { kind: 'stream', id: sel, name: sel };
  emit('lock');
  const [lam, bet] = trackPos(mid);
  slideField(lam, bet, { keepLock: true });
}
function gotoGC(i) {
  state.lock = { kind: 'gc', id: i, name: D.GCC.name[i], dist: D.GCC.dist[i] };
  emit('lock');
  slideField(D.GCC.lam[i], D.GCC.bet[i], { keepLock: true });
}
function gotoDwarf(i) {
  state.lock = { kind: 'dwarf', id: i, name: D.DWF.name[i], dist: D.DWF.dist[i] };
  emit('lock');
  slideField(D.DWF.lam[i], D.DWF.bet[i], { keepLock: true });
}
export function gotoCone(cone) {
  state.fov = cone.fov;
  state.lock = { kind: 'cone', id: cone.key, name: cone.name };
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

// dwarf-member counts per galaxy (full catalog)
let MEM_COUNTS = null;
function memCounts() {
  if (MEM_COUNTS) return MEM_COUNTS;
  MEM_COUNTS = new Map();
  if (D.MEM) for (const nm of D.MEM.name) MEM_COUNTS.set(nm, (MEM_COUNTS.get(nm) ?? 0) + 1);
  return MEM_COUNTS;
}

function candOptions() {
  // nearest gridpoint (FOV snap, G limit) with graceful fallback to what exists
  const pairs = new Map();
  for (const c of D.CANDIDATES) {
    const g = c.glim ?? 20;
    pairs.set(`${c.fov}|${g}`, { fov: c.fov, glim: g });
  }
  if (!pairs.size) return { html: '', note: 'no shortlists in data' };
  let best = null, bd = Infinity;
  for (const p of pairs.values()) {
    const d = Math.abs(p.fov - state.fov) * 2 + Math.abs(p.glim - state.ghi);
    if (d < bd) { bd = d; best = p; }
  }
  const list = D.CANDIDATES.filter(c => c.fov === best.fov && (c.glim ?? 20) === best.glim);
  const html = list.map((c, k) =>
    option(D.CANDIDATES.indexOf(c),
      `#${c.rank} — ${c.fov}° • ℓ ${c.l.toFixed(1)}, b ${c.b.toFixed(1)} • G ≤ ${best.glim}`)).join('');
  return { html, note: `top ${list.length} for ${best.fov}° fields at G ≤ ${best.glim}` };
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

  $('sidebar').innerHTML = `
  <div class="brand">VIAsual<span class="v2tag">v2</span>
    <a class="tolink" href="v1/" title="open the original v1 app">v1 ↗</a>
  </div>

  <details class="group" open>
    <summary>Field</summary>
    <div class="row"><label>FOV <b id="fov-v">${state.fov.toFixed(1)}</b>° <span class="tiny" id="fov-note"></span></label>
      <input type="range" id="fov" min="1" max="5" step="0.1" value="${state.fov}">
      <div class="fov-snaps">${FOV_SNAPS.map(s => `<span class="fov-snap" data-fov="${s}">${s}°</span>`).join('')}</div>
    </div>
    <div class="row"><label>promising fields <span class="tiny" id="cand-note">${cand.note}</span></label>
      <select id="cand-sel"><option value="">— None selected —</option>${cand.html}</select>
    </div>
    <div class="row"><label>saved fields</label>
      <div class="save-row">
        <button id="save-field" class="mini-btn">☆ save field</button>
        <button id="hist-back" class="mini-btn" title="back to the previous field">◀</button>
        <button id="hist-fwd" class="mini-btn" title="forward again">▶</button>
      </div>
    </div>
    <div id="saved-list"></div>
    <div class="row">
      <button id="export-saved" class="mini-btn">copy field list</button>
      <button id="import-saved" class="mini-btn">paste field list</button>
    </div>
  </details>

  <details class="group" open>
    <summary>3D view</summary>
    <div class="row"><label>color by</label>
      <select id="mode-sel">
        ${option('dist', 'Distance [kpc]', state.mode === 'dist')}
        ${option('mag', 'Gaia G magnitude', state.mode === 'mag')}
        ${option('dens', 'On-sky density', state.mode === 'dens')}
        ${option('hemi', 'Hemisphere visibility', state.mode === 'hemi')}
        ${option('stream', 'Stream (palette)', state.mode === 'stream')}
      </select>
    </div>
    <div class="row"><label>mag limit G ≤ <b id="ghi-v">${state.ghi.toFixed(1)}</b>
      <span class="inline-chk"><input type="checkbox" id="hide-chk" ${state.hide ? 'checked' : ''}> hide beyond limit</span></label>
      <input type="range" id="ghi" min="${D.GMIN.toFixed(2)}" max="${D.GMAX.toFixed(2)}" step="0.1" value="${state.ghi}">
    </div>
    <div class="row checks catalogs"><label class="tiny sec-lab">show</label>
      <label><input type="checkbox" id="streams-chk" ${state.streamsOn ? 'checked' : ''}> <i class="sw str"></i>streams</label>
      <label><input type="checkbox" id="dg-chk" ${state.dgOn ? 'checked' : ''}> <i class="sw dg"></i>dwarfs</label>
      <label><input type="checkbox" id="gc-chk" ${state.gcOn ? 'checked' : ''}> <i class="sw gc"></i>GCs</label>
      <label><input type="checkbox" id="qso-chk" ${state.qsoOn ? 'checked' : ''}> <i class="sw qso"></i>quasars</label>
      <label><input type="checkbox" id="halo-chk" ${state.haloOn ? 'checked' : ''}> <i class="sw halo"></i>halo RRL</label>
    </div>
    <div class="row checks">
      <label><input type="checkbox" id="disk-chk" ${state.diskOn ? 'checked' : ''}> disk <span class="tiny">(R=10 kpc · z=1 kpc)</span></label>
      <label><input type="checkbox" id="box-chk" ${state.boxOn ? 'checked' : ''}> show ${D.BOX_R} kpc box</label>
      <label><input type="checkbox" id="hisph-chk" ${state.hiSphere ? 'checked' : ''}> HI shell</label>
    </div>
    <div class="row checks"><label class="tiny sec-lab">cones</label>
      <label><input type="checkbox" id="cone-kepler" ${state.coneKepler ? 'checked' : ''}> <i class="sw" style="background:#4caf50"></i>Kepler</label>
      <label><input type="checkbox" id="cone-m31" ${state.coneM31 ? 'checked' : ''}> <i class="sw" style="background:#5a8fd4"></i>M31</label>
      <label><input type="checkbox" id="cone-m82" ${state.coneM82 ? 'checked' : ''}> <i class="sw" style="background:#c77bd8"></i>M82</label>
      <label><input type="checkbox" id="hemi-cones" ${state.hemiCones ? 'checked' : ''}> telescope cones</label>
    </div>
    <div class="row seg theme-seg">
      <button id="theme-dark" class="segbtn ${state.theme === 'dark' ? 'active' : ''}">dark</button>
      <button id="theme-light" class="segbtn ${state.theme === 'light' ? 'active' : ''}">light</button>
    </div>
  </details>

  <details class="group" open>
    <summary>Backlights</summary>
    <div class="subhead">Streams</div>
    <div class="row checks">
      <label><input type="checkbox" id="via-chk" ${state.via ? 'checked' : ''}> Via only</label>
      <label><input type="checkbox" id="hl-stream" ${state.hlStream ? 'checked' : ''}> highlight</label>
    </div>
    <div class="row combo">
      <select id="stream-sel"><option value="">— None selected —</option>${sortedStreams.map(s => option(s, s, state.streamSel === s)).join('')}</select>
      <button id="stream-go" class="mini-btn" title="go to this stream">→</button>
    </div>
    <div class="row"><label>scan along stream</label>
      <input type="range" id="scan-stream" disabled>
    </div>
    <div class="subhead">Dwarf galaxies</div>
    <div class="row checks">
      <label><input type="checkbox" id="mem-chk" ${state.memOn ? 'checked' : ''}> <i class="sw dg"></i>show dwarf members</label>
    </div>
    <div class="row checks">
      <label><input type="checkbox" id="via-dg-chk" ${state.viaDwarfs ? 'checked' : ''}> Via only <span class="tiny">(&lt;300 kpc)</span></label>
      <label><input type="checkbox" id="hl-dwarf" ${state.hlDwarf ? 'checked' : ''}> highlight</label>
    </div>
    <div class="row combo">
      <select id="dg-sel"><option value="">— None selected —</option>${dgOpts.join('')}</select>
      <button id="dg-go" class="mini-btn" title="go to this dwarf">→</button>
    </div>
    <div class="subhead">Globular clusters</div>
    <div class="row checks">
      <label><input type="checkbox" id="hl-gc" ${state.hlGC ? 'checked' : ''}> highlight</label>
    </div>
    <div class="row combo">
      <select id="gc-sel"><option value="">— None selected —</option>${gcOpts.join('')}</select>
      <button id="gc-go" class="mini-btn" title="go to this cluster">→</button>
    </div>
    <div class="subhead">Other</div>
    <div class="row seg">
      ${D.CONES.map(c => `<button class="mini-btn cone-go" data-cone="${c.key}">${c.name}</button>`).join('')}
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
  <div class="side-note tiny">drag the red arrow in 3D, drag the circle on the maps,
    or double-click any star / object / map point to move the field. Links encode the exact field.</div>`;

  wireSidebar();
  renderSaved();
  syncFov();
  syncHistory();
  syncLockButtons();
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
  document.querySelectorAll('.fov-snap').forEach(el => {
    el.addEventListener('click', () => {
      const v = parseFloat(el.dataset.fov);
      fovEl.value = v;
      set({ fov: v }, 'field');
      syncFov();
    });
  });

  $('cand-sel').addEventListener('change', e => {
    if (e.target.value === '') return;
    const c = D.CANDIDATES[+e.target.value];
    state.fov = c.fov;
    syncFov();
    slideField(c.lam, c.bet);
  });

  $('stream-sel').addEventListener('change', e => set({ streamSel: e.target.value || null }));
  $('stream-go').addEventListener('click', () => { if (state.streamSel) gotoStream(state.streamSel); });
  $('scan-stream').addEventListener('input', e => {
    if (!TRACK.list) return;
    const [lam, bet] = trackPos(parseFloat(e.target.value));
    setField(lam, bet, { live: true, keepLock: true });
  });
  $('scan-stream').addEventListener('change', () => setField(state.lam0, state.bet0, { keepLock: true }));

  $('mode-sel').addEventListener('change', e => set({ mode: e.target.value }));
  $('ghi').addEventListener('input', e => {
    $('ghi-v').textContent = (+e.target.value).toFixed(1);
    set({ ghi: +e.target.value });
  });
  $('hide-chk').addEventListener('change', e => set({ hide: e.target.checked }));
  $('disk-chk').addEventListener('change', e => set({ diskOn: e.target.checked }));
  $('box-chk').addEventListener('change', e => set({ boxOn: e.target.checked }));
  $('hisph-chk').addEventListener('change', e => set({ hiSphere: e.target.checked }));
  $('cone-kepler').addEventListener('change', e => set({ coneKepler: e.target.checked }));
  $('cone-m31').addEventListener('change', e => set({ coneM31: e.target.checked }));
  $('cone-m82').addEventListener('change', e => set({ coneM82: e.target.checked }));
  $('hemi-cones').addEventListener('change', e => set({ hemiCones: e.target.checked }));
  $('theme-dark').addEventListener('click', () => { set({ theme: 'dark' }); syncTheme(); });
  $('theme-light').addEventListener('click', () => { set({ theme: 'light' }); syncTheme(); });

  $('via-chk').addEventListener('change', e => set({ via: e.target.checked }));
  $('hl-stream').addEventListener('change', e => set({ hlStream: e.target.checked }));
  $('via-dg-chk').addEventListener('change', e => set({ viaDwarfs: e.target.checked }));
  $('hl-dwarf').addEventListener('change', e => set({ hlDwarf: e.target.checked }));
  $('hl-gc').addEventListener('change', e => set({ hlGC: e.target.checked }));
  $('gc-sel').addEventListener('change', e => set({ gcSel: e.target.value === '' ? null : +e.target.value }));
  $('gc-go').addEventListener('click', () => { if (state.gcSel !== null) gotoGC(state.gcSel); });
  $('dg-sel').addEventListener('change', e => set({ dwarfSel: e.target.value === '' ? null : +e.target.value }));
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

  $('hist-back').addEventListener('click', () => histGo(-1));
  $('hist-fwd').addEventListener('click', () => histGo(1));
  $('save-field').addEventListener('click', () => { saveCurrentField(); renderSaved(); });
  $('export-saved').addEventListener('click', async e => {
    const txt = JSON.stringify(loadSaved(), null, 1);
    try { await navigator.clipboard.writeText(txt); e.target.textContent = 'copied ✓'; }
    catch { window.prompt('copy this:', txt); }
    setTimeout(() => { e.target.textContent = 'copy field list'; }, 1400);
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
  for (const s of document.querySelectorAll('.fov-snap')) {
    s.classList.toggle('active', Math.abs(parseFloat(s.dataset.fov) - state.fov) < 0.01);
  }
}

function syncTheme() {
  $('theme-dark')?.classList.toggle('active', state.theme === 'dark');
  $('theme-light')?.classList.toggle('active', state.theme === 'light');
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
  sel.innerHTML = `<option value="">— None selected —</option>${cand.html}`;
  $('cand-note').textContent = cand.note;
}

// saved-field default label: `1° • ℓ −28.9, b 79.8 • G ≤ 20` (object name replaces
// the coordinates when the field was saved while locked on an object)
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
    if (f.label) lbl.textContent = f.label;
    else lbl.innerHTML = fieldLabelHtml(f);
    lbl.contentEditable = 'true';
    lbl.title = `Λ=${f.lam.toFixed(2)} B=${f.bet.toFixed(2)}${f.fov ? ` · ${f.fov}°` : ''} (click name to rename)`;
    lbl.addEventListener('click', e => e.stopPropagation());
    lbl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); lbl.blur(); } });
    lbl.addEventListener('blur', () => {
      const l2 = loadSaved();
      if (l2[i]) { l2[i].label = lbl.textContent.trim(); storeSaved(l2); }
    });
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
  if (name === 'halo') buildHalo();
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
    state.lam0 = D.LAM0_DEFAULT;
    state.bet0 = D.BET0_DEFAULT;
    state.glo = D.GMIN;
    state.ghi = Math.min(20.0, D.GMAX);
    initHash();                                   // may override from a shared link
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
    initHalo($('halo-wrap'));
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
