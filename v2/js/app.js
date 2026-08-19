// VIAsual v2 — app shell: boot, sidebar, tabs, saved fields, oracle verify.
const DATA_DIR = '../data';
export const CODE_VERSION = 'v2.1';

import { loadCore, loadQuaia, D } from './data.js';
import { state, set, setField, on, emit, initHash, loadSaved, storeSaved, saveCurrentField, galField } from './state.js';
import * as C from './compute.js';
import { initScales, UI } from './colors.js';
import { initFieldModel, F, recompute } from './fieldmodel.js';
import { initScene, setZoomDistance, requestRender, restyle } from './scene3d.js';
import { initFinder } from './panels/finder.js';
import { initAllsky } from './panels/allsky.js';
import { initSgrmap } from './panels/sgrmap.js';
import { initHists } from './panels/hists.js';
import { initLadder } from './panels/ladder.js';
import { initStats } from './panels/stats.js';
import { initHalo, maybeBuild as buildHalo } from './panels/halo.js';

const $ = id => document.getElementById(id);

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
  const [lam, bet] = trackPos(mid);
  setField(lam, bet);
}

// ---- sidebar construction ------------------------------------------------------------
function option(v, t, sel) { return `<option value="${v}"${sel ? ' selected' : ''}>${t}</option>`; }

function buildSidebar() {
  const sortedStreams = (() => {
    const counts = new Map();
    for (let i = 0; i < D.N; i++) counts.set(D.streamName(i), (counts.get(D.streamName(i)) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([nm]) => nm);
  })();
  const gcOpts = [...D.GCC.name.keys()]
    .sort((a, b) => Math.abs(D.GCC.b[b]) - Math.abs(D.GCC.b[a]))
    .map(i => option(i, `${D.GCC.name[i]} · ${D.GCC.dist[i].toFixed(1)} kpc · |b|=${Math.abs(D.GCC.b[i]).toFixed(0)}°`));
  const dgOpts = [...D.DWF.name.keys()]
    .sort((a, b) => (D.DWF.mass[b] || 0) - (D.DWF.mass[a] || 0))
    .map(i => option(i, `${D.DWF.name[i]} · ${D.DWF.dist[i].toFixed(1)} kpc`));
  const candOpts = D.CANDIDATES.map((c, i) =>
    option(i, `${c.fov}° #${c.rank} — ${c.n_rungs} rungs · ${c.combo} · ${c.site}`));

  $('sidebar').innerHTML = `
  <div class="brand">VIAsual<span class="v2tag">v2</span>
    <a class="tolink" href="../" title="open the original v1 app">v1 ↗</a>
  </div>

  <details class="group" open>
    <summary>Field</summary>
    <div class="row seg" id="fov-seg">
      <button data-fov="1" class="segbtn">1°</button>
      <button data-fov="3" class="segbtn">3°</button>
      <button data-fov="5" class="segbtn">5°</button>
      <span class="tiny" id="fov-note">Via field</span>
    </div>
    <div class="row"><label>promising fields</label>
      <select id="cand-sel"><option value="">— pick a shortlisted field —</option>${candOpts.join('')}</select>
    </div>
    <div class="row"><label>go to stream</label>
      <select id="stream-goto"><option value="">— pick —</option>${sortedStreams.map(s => option(s, s)).join('')}</select>
    </div>
    <div class="row"><label>scan along stream</label>
      <input type="range" id="scan-stream" disabled>
    </div>
  </details>

  <details class="group" open>
    <summary>View</summary>
    <div class="row"><label>colour by</label>
      <select id="mode-sel">
        ${option('dist', 'Distance [kpc]', state.mode === 'dist')}
        ${option('mag', 'Gaia G magnitude', state.mode === 'mag')}
        ${option('dens', 'On-sky density', state.mode === 'dens')}
        ${option('hemi', 'Hemisphere visibility', state.mode === 'hemi')}
        ${option('stream', 'Stream (palette)', state.mode === 'stream')}
      </select>
    </div>
    <div class="row"><label>mag limit G ≤ <b id="ghi-v">${state.ghi.toFixed(1)}</b></label>
      <input type="range" id="ghi" min="${D.GMIN.toFixed(2)}" max="${D.GMAX.toFixed(2)}" step="0.1" value="${state.ghi}">
    </div>
    <div class="row checks">
      <label><input type="checkbox" id="hide-chk" ${state.hide ? 'checked' : ''}> hide beyond limit</label>
    </div>
    <div class="row"><label>3D view ± <b id="zoom-v">${state.zoom}</b> kpc</label>
      <input type="range" id="zoom" min="15" max="130" step="1" value="${state.zoom}">
    </div>
    <div class="row checks">
      <label><input type="checkbox" id="kepler-chk" ${state.kepler ? 'checked' : ''}> Kepler cone</label>
      <label><input type="checkbox" id="hisph-chk" ${state.hiSphere ? 'checked' : ''}> HI shell</label>
      <label><input type="checkbox" id="clean-chk" ${state.clean ? 'checked' : ''}> clean 3D</label>
    </div>
  </details>

  <details class="group" open>
    <summary>Objects</summary>
    <div class="row"><label>highlight stream</label>
      <select id="stream-sel"><option value="">— all —</option>${sortedStreams.map(s => option(s, s, state.stream === s)).join('')}</select>
    </div>
    <div class="row checks">
      <label><input type="checkbox" id="isolate-chk" ${state.isolate ? 'checked' : ''}> only selected</label>
      <label><input type="checkbox" id="via-chk" ${state.via ? 'checked' : ''}> Via streams only</label>
    </div>
    <div class="row combo"><select id="gc-sel">${gcOpts.join('')}</select><button id="gc-go" class="mini-btn">→</button></div>
    <div class="row combo"><select id="dg-sel">${dgOpts.join('')}</select><button id="dg-go" class="mini-btn">→</button></div>
    <div class="row checks catalogs">
      <label><input type="checkbox" id="qso-chk" ${state.qsoOn ? 'checked' : ''}> <i class="sw qso"></i>quasars</label>
      <label><input type="checkbox" id="gc-chk" ${state.gcOn ? 'checked' : ''}> <i class="sw gc"></i>GCs</label>
      <label><input type="checkbox" id="dg-chk" ${state.dgOn ? 'checked' : ''}> <i class="sw dg"></i>dwarfs</label>
      <label><input type="checkbox" id="mem-chk" ${state.memOn ? 'checked' : ''}> <i class="sw mem"></i>dwarf ★</label>
    </div>
  </details>

  <details class="group">
    <summary>HI map</summary>
    <div class="row"><select id="himap-sel">
      ${option('total', 'Total N(HI) (all v)', state.himap === 'total')}
      ${option('hvc', 'High-velocity (HVC)', state.himap === 'hvc')}
      ${option('overlay', 'Total + HVC overlay', state.himap === 'overlay')}
    </select></div>
    <div class="row checks">
      <label><input type="checkbox" id="rescale-chk" ${state.rescale ? 'checked' : ''}> rescale colours to field</label>
      <label><input type="checkbox" id="connect-chk" ${state.connect ? 'checked' : ''}> NN lines on finder</label>
    </div>
    <div class="row"><label>pair plot</label>
      <select id="pair-sel">
        ${option('dd', 'sep vs Δdist (pairs)', state.pairKind === 'dd')}
        ${option('dv', 'sep vs Δv (pairs)', state.pairKind === 'dv')}
        ${option('nn', 'd_i vs d_nn (NN)', state.pairKind === 'nn')}
        ${option('dnn', 'NN Δdist histogram', state.pairKind === 'dnn')}
      </select>
    </div>
  </details>

  <details class="group" open>
    <summary>Saved fields</summary>
    <div class="row">
      <button id="save-field" class="mini-btn wide">☆ save current field</button>
    </div>
    <div id="saved-list"></div>
    <div class="row">
      <button id="export-saved" class="mini-btn">copy JSON</button>
      <button id="import-saved" class="mini-btn">paste to import</button>
    </div>
  </details>
  <div class="side-note tiny">drag the red arrow in 3D, drag the circle on the maps,
    or click any star / object / map point to move the field. Links encode the exact field.</div>`;

  wireSidebar();
  renderSaved();
  syncFovSeg();
}

function wireSidebar() {
  $('fov-seg').addEventListener('click', e => {
    const b = e.target.closest('.segbtn');
    if (!b) return;
    set({ fov: parseFloat(b.dataset.fov) }, 'field');
    syncFovSeg();
  });
  $('cand-sel').addEventListener('change', e => {
    if (e.target.value === '') return;
    const c = D.CANDIDATES[+e.target.value];
    state.fov = c.fov;
    syncFovSeg();
    setField(c.lam, c.bet);
  });
  $('stream-goto').addEventListener('change', e => { if (e.target.value) gotoStream(e.target.value); });
  $('scan-stream').addEventListener('input', e => {
    if (!TRACK.list) return;
    const [lam, bet] = trackPos(parseFloat(e.target.value));
    setField(lam, bet, { live: true });
  });
  $('scan-stream').addEventListener('change', () => setField(state.lam0, state.bet0));
  $('mode-sel').addEventListener('change', e => set({ mode: e.target.value }));
  $('ghi').addEventListener('input', e => {
    $('ghi-v').textContent = (+e.target.value).toFixed(1);
    set({ ghi: +e.target.value });
  });
  $('hide-chk').addEventListener('change', e => set({ hide: e.target.checked }));
  $('zoom').addEventListener('input', e => {
    $('zoom-v').textContent = e.target.value;
    state.zoom = +e.target.value;
    setZoomDistance(state.zoom);
  });
  $('kepler-chk').addEventListener('change', e => set({ kepler: e.target.checked }));
  $('hisph-chk').addEventListener('change', e => set({ hiSphere: e.target.checked }));
  $('clean-chk').addEventListener('change', e => set({ clean: e.target.checked }));
  $('stream-sel').addEventListener('change', e => set({ stream: e.target.value || null }));
  $('isolate-chk').addEventListener('change', e => set({ isolate: e.target.checked }));
  $('via-chk').addEventListener('change', e => set({ via: e.target.checked }));
  $('gc-go').addEventListener('click', () => {
    const i = +$('gc-sel').value;
    setField(D.GCC.lam[i], D.GCC.bet[i]);
  });
  $('dg-go').addEventListener('click', () => {
    const i = +$('dg-sel').value;
    setField(D.DWF.lam[i], D.DWF.bet[i]);
  });
  $('qso-chk').addEventListener('change', e => set({ qsoOn: e.target.checked }));
  $('gc-chk').addEventListener('change', e => set({ gcOn: e.target.checked }));
  $('dg-chk').addEventListener('change', e => set({ dgOn: e.target.checked }));
  $('mem-chk').addEventListener('change', e => set({ memOn: e.target.checked }));
  $('himap-sel').addEventListener('change', e => set({ himap: e.target.value }));
  $('rescale-chk').addEventListener('change', e => set({ rescale: e.target.checked }));
  $('connect-chk').addEventListener('change', e => set({ connect: e.target.checked }));
  $('pair-sel').addEventListener('change', e => set({ pairKind: e.target.value }));

  $('save-field').addEventListener('click', () => { saveCurrentField(); renderSaved(); });
  $('export-saved').addEventListener('click', async e => {
    const txt = JSON.stringify(loadSaved(), null, 1);
    try { await navigator.clipboard.writeText(txt); e.target.textContent = 'copied ✓'; }
    catch { window.prompt('copy this:', txt); }
    setTimeout(() => { e.target.textContent = 'copy JSON'; }, 1400);
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
    set({ stream: e.detail });
    gotoStream(e.detail);
    showTab('field');
  });
  window.addEventListener('v2-show-field-tab', () => showTab('field'));
}

function syncFovSeg() {
  for (const b of document.querySelectorAll('#fov-seg .segbtn')) {
    b.classList.toggle('active', Math.abs(parseFloat(b.dataset.fov) - state.fov) < 0.01);
  }
  $('fov-note').textContent = state.fov <= 1.001 ? 'Via field' : `${state.fov}° = ~${Math.round((state.fov) ** 2)} pointings`;
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
    lbl.textContent = f.label || `ℓ${f.l.toFixed(1)} b${f.b.toFixed(1)}`;
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
      if (f.fov) { state.fov = f.fov; syncFovSeg(); }
      setField(f.lam, f.bet);
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
    nQso: F.qq.length,
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
    // lazy quasars
    loadQuaia(DATA_DIR).then(n => {
      console.log(`[viasual2] quaia loaded: ${n}`);
      emit('quaia');
    });
    console.log(`[viasual2] boot ok — ${D.N} stars, load ${D.loadMs.toFixed(0)} ms`);
  } catch (err) {
    prog.innerHTML = `<span style="color:#e05252">failed to load: ${err.message}</span>`;
    console.error(err);
  }
}

boot();
