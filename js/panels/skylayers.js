// Sky-tab "Map layers": background map + HVC cloud catalogs (chips; the sub-options stay
// visible but faint while clouds are off). The "Active on map" legend is rendered under the
// Galactic-frame map (and inside its full-screen view) via renderLegend().
// Field-list overlays and survey regions are toggled in the sidebar (Field lists / Focus on object).
import { D } from '../data.js';
import { state, set, on } from '../state.js';
import { UI, SVY_COL, SVY_SHORT, bgLabel, BG_OPTIONS } from '../colors.js';
import { SOURCES } from '../lists.js';

let el, legendEls = [];
export function initLayers(container, legendContainer) {
  el = container;
  if (legendContainer) legendEls.push(legendContainer);
  render();
  const all = () => { render(); renderLegend(); };
  on('ui', all);
  on('lists', all);
  on('list', renderLegend);
  on('catalog', all);
  on('theme', all);
}
// extra legend targets (the full-screen Galactic view registers its own box)
export function addLegendTarget(node) { legendEls.push(node); renderLegend(); }
export function removeLegendTarget(node) { legendEls = legendEls.filter(n => n !== node); }

const opt = (v, t, cur) => `<option value="${v}"${cur === v ? ' selected' : ''}>${t}</option>`;
const chip = (key, label, title = '', color = '#cfc8bb') =>
  `<button class="chip-btn ${state[key] ? 'on' : ''}" data-key="${key}" style="--svy:${color}" title="${title}">${label}</button>`;

function render() {
  const faint = state.cloudsOn ? '' : ' faint';
  el.innerHTML = `
    <div class="layer-row"><span class="lab">background</span>
      <select id="ly-bg">${BG_OPTIONS.map(([v, t]) => opt(v, t, state.himap)).join('')}</select></div>
    <div class="layer-row"><span class="lab">HVC clouds</span>
      ${chip('cloudsOn', 'show cloud catalogs', 'draw the HVC cloud catalogs on the maps and the field view', UI.cloud)}
    </div>
    <div class="layer-row sub${faint}">
      ${chip('cloudHipass', 'HIPASS (S)', 'Putman+02 HIPASS HVCs, southern sky')}
      ${chip('cloudAlfalfa', 'UCHVC', 'Adams+13 ALFALFA ultra-compact HVCs')}
      ${chip('cloudGass', 'GASS (S)', 'Moss+13 GASS HVCs, southern sky')}
    </div>
    <div class="layer-row sub${faint}">
      <select id="ly-cl-filter" style="flex:1">
        ${opt('all', 'all clouds', state.cloudFilter)}${opt('compact', 'compact only (CHVC + UCHVC)', state.cloudFilter)}${opt('vhvc', 'very high velocity (|vLSR| ≥ 200)', state.cloudFilter)}
      </select>
      <select id="ly-cl-color" style="flex:1">
        ${opt('none', 'one color', state.cloudColor)}${opt('vlsr', 'color by v_LSR', state.cloudColor)}${opt('vgsr', 'color by v_GSR', state.cloudColor)}
      </select></div>`;
  el.querySelector('#ly-bg').addEventListener('change', e => set({ himap: e.target.value }));
  el.querySelectorAll('.chip-btn[data-key]').forEach(b => b.addEventListener('click', () => set({ [b.dataset.key]: !state[b.dataset.key] })));
  el.querySelector('#ly-cl-filter').addEventListener('change', e => set({ cloudFilter: e.target.value }));
  el.querySelector('#ly-cl-color').addEventListener('change', e => set({ cloudColor: e.target.value }));
}

export function renderLegend() {
  const html = legendHtml();
  for (const n of legendEls) n.innerHTML = html;
}

function legendHtml() {
  const L = [];
  const lg = (col, txt, cls = '') => `<span class="lg" style="--lg:${col}"><i class="${cls}"></i>${txt}</span>`;
  L.push(`<span class="lg lg-head">Active on map:</span>`);
  if (state.streamsOn) L.push(lg(UI.text, 'stream stars', 'fill'));
  if (state.gcOn) L.push(lg(UI.gc, 'globular clusters', 'fill'));
  if (state.dgOn) L.push(lg(UI.dwarf, 'dwarf galaxies', 'fill dia'));
  if (state.dgOn && state.memOn) L.push(lg(UI.member, 'dwarf members', 'fill'));
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
