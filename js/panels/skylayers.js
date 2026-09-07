// Sky-tab "Map layers": the gas & dust controls live here, where the maps are shown
// (background map, HVC cloud catalogs + filters, the 3D map shell / local dust cloud and
// camera flights), plus a legend that follows what is drawn on the two sky maps.
// Field-list overlays and survey regions are toggled in the sidebar (Field lists / Go to).
import { D } from '../data.js';
import { state, set, on } from '../state.js';
import { UI, SVY_COL, SVY_SHORT, bgLabel, BG_OPTIONS } from '../colors.js';
import { LIST, SOURCES } from '../lists.js';

let el;
export function initLayers(container) {
  el = container;
  render();
  on('ui', render);
  on('lists', render);
  on('list', render);
  on('catalog', render);
  on('theme', render);
}

const opt = (v, t, cur) => `<option value="${v}"${cur === v ? ' selected' : ''}>${t}</option>`;
const chk = (id, key, label, title = '') =>
  `<label title="${title}"><input type="checkbox" id="${id}" ${state[key] ? 'checked' : ''}> ${label}</label>`;

function render() {
  el.innerHTML = `
    <div class="layer-row"><span class="lab">background</span>
      <select id="ly-bg">${BG_OPTIONS.map(([v, t]) => opt(v, t, state.himap)).join('')}</select></div>
    <div class="layer-row"><span class="lab">HVC clouds</span>
      ${chk('ly-clouds', 'cloudsOn', 'show cloud catalogs')}
      ${state.cloudsOn ? chk('ly-hipass', 'cloudHipass', 'HIPASS (S)') + chk('ly-alfalfa', 'cloudAlfalfa', 'UCHVC') + chk('ly-gass', 'cloudGass', 'GASS (S)') : ''}
    </div>
    ${state.cloudsOn ? `<div class="layer-row sub">
      <select id="ly-cl-filter" style="flex:1">
        ${opt('all', 'all clouds', state.cloudFilter)}${opt('compact', 'compact only (CHVC + UCHVC)', state.cloudFilter)}${opt('vhvc', 'very high velocity (|vLSR| ≥ 200)', state.cloudFilter)}
      </select>
      <select id="ly-cl-color" style="flex:1">
        ${opt('none', 'one color', state.cloudColor)}${opt('vlsr', 'color by v_LSR', state.cloudColor)}${opt('vgsr', 'color by v_GSR', state.cloudColor)}
      </select></div>` : ''}
    <div class="layer-div"></div>
    <div class="layer-row"><span class="lab">3D view</span>
      ${chk('ly-hisph', 'hiSphere', 'map shell', 'the background map on a 10 kpc shell in the 3D view')}
      ${chk('ly-dust3d', 'dust3dOn', 'local dust cloud', 'Edenhofer+24 3D dust within 1.25 kpc')}
      <button id="ly-zoom-local" class="micro-btn" title="fly the camera to within a few kpc of the Sun (local dust, Kepler stars)">zoom local</button>
      <button id="ly-zoom-halo" class="micro-btn" title="back out to the halo view">halo view</button>
    </div>
    <div class="legend">${legendHtml()}</div>`;
  el.querySelector('#ly-bg').addEventListener('change', e => set({ himap: e.target.value }));
  const bind = (id, key) => el.querySelector(id)?.addEventListener('change', e => set({ [key]: e.target.checked }));
  bind('#ly-clouds', 'cloudsOn'); bind('#ly-hipass', 'cloudHipass'); bind('#ly-alfalfa', 'cloudAlfalfa'); bind('#ly-gass', 'cloudGass');
  bind('#ly-hisph', 'hiSphere'); bind('#ly-dust3d', 'dust3dOn');
  el.querySelector('#ly-cl-filter')?.addEventListener('change', e => set({ cloudFilter: e.target.value }));
  el.querySelector('#ly-cl-color')?.addEventListener('change', e => set({ cloudColor: e.target.value }));
  el.querySelector('#ly-zoom-local').addEventListener('click', () => window.dispatchEvent(new CustomEvent('v3-zoom', { detail: 'local' })));
  el.querySelector('#ly-zoom-halo').addEventListener('click', () => window.dispatchEvent(new CustomEvent('v3-zoom', { detail: 'halo' })));
}

function legendHtml() {
  const L = [];
  const lg = (col, txt, cls = '') => `<span class="lg" style="--lg:${col}"><i class="${cls}"></i>${txt}</span>`;
  L.push(`<span class="lg">background: <b>${bgLabel()}</b> (dark → light = low → high)</span>`);
  if (state.streamsOn) L.push(lg(UI.text, 'stream stars', 'fill sq'));
  if (state.gcOn) L.push(lg(UI.gc, 'globular clusters', 'fill'));
  if (state.dgOn) L.push(lg(UI.dwarf, 'dwarf galaxies', 'fill dia'));
  if (state.dgOn && state.memOn) L.push(lg(UI.member, 'dwarf members', 'fill sq'));
  if (state.cloudsOn) L.push(lg(UI.cloud, state.cloudColor === 'none' ? 'HVC clouds (size = catalog extent)' : `HVC clouds, colored by ${state.cloudColor === 'vlsr' ? 'v_LSR' : 'v_GSR'} (blue → red)`));
  if (state.viaOn) {
    for (const id of state.listSrc) {
      const s = SOURCES.find(x => x.id === id);
      if (!s) continue;
      if (s.svy) L.push(lg(SVY_COL[s.svy], `Via ${SVY_SHORT[s.svy] ?? s.svy} pointings (1°)`));
      else if (id === 'bish19') L.push(lg(UI.text, 'Bish+19 Na I / Ca II sightlines'));
      else L.push(lg(s.color, `${s.title} (field list)`));
    }
  }
  for (const c of D.CONES) if (state[c.key]) L.push(lg(c.color, `${c.name} survey region (${c.fov}°)`));
  L.push(lg(UI.accent, 'current field'));
  return L.join('');
}
