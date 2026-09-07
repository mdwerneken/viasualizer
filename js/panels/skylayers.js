// Sky-tab layer controls + a legend that follows what is drawn on the two sky maps.
// Controls here mirror the same state the sidebar uses (background map, clouds, Via
// pointings, sightlines, survey cones), so either place can drive them.
import { D } from '../data.js';
import { state, set, on } from '../state.js';
import { UI, SVY_COL, SVY_SHORT, bgLabel, BG_OPTIONS } from '../colors.js';

let el;
export function initLayers(container) {
  el = container;
  render();
  on('ui', render);
  on('catalog', render);
  on('theme', render);
}

function render() {
  const svyChips = (D.VIA?.SVY_KEYS ?? []).map(k =>
    `<button class="chip-btn ${state.viaSvy[k] ? 'on' : ''}" data-svy="${k}" style="--svy:${SVY_COL[k]}" title="${D.VIA.surveys[k]}">${SVY_SHORT[k] ?? k}</button>`).join('');
  el.innerHTML = `
    <div class="layer-row"><span class="lab">background</span>
      <select id="ly-bg">
        ${BG_OPTIONS.map(([v, t]) => `<option value="${v}"${state.himap === v ? ' selected' : ''}>${t}</option>`).join('')}
      </select></div>
    <div class="layer-row"><span class="lab">overlays</span>
      <label><input type="checkbox" id="ly-via" ${state.viaOn ? 'checked' : ''}> Via pointings</label>
      <label><input type="checkbox" id="ly-clouds" ${state.cloudsOn ? 'checked' : ''}> HVC clouds</label>
      <label><input type="checkbox" id="ly-sight" ${state.sightOn ? 'checked' : ''}> sightlines</label>
      <label><input type="checkbox" id="ly-kep" ${state.coneKepler ? 'checked' : ''}> Kepler</label>
      <label><input type="checkbox" id="ly-m31" ${state.coneM31 ? 'checked' : ''}> M31</label>
      <label><input type="checkbox" id="ly-m82" ${state.coneM82 ? 'checked' : ''}> M82</label>
    </div>
    ${state.viaOn && D.VIA ? `<div class="layer-row"><span class="lab">surveys</span><span class="svy-chips" style="padding:0" id="ly-svy">${svyChips}</span></div>` : ''}
    <div class="legend">${legendHtml()}</div>`;
  el.querySelector('#ly-bg').addEventListener('change', e => set({ himap: e.target.value }));
  const bind = (id, key) => el.querySelector(id).addEventListener('change', e => set({ [key]: e.target.checked }));
  bind('#ly-via', 'viaOn'); bind('#ly-clouds', 'cloudsOn'); bind('#ly-sight', 'sightOn');
  bind('#ly-kep', 'coneKepler'); bind('#ly-m31', 'coneM31'); bind('#ly-m82', 'coneM82');
  el.querySelectorAll('#ly-svy .chip-btn').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.svy;
    set({ viaSvy: { ...state.viaSvy, [k]: !state.viaSvy[k] } });
  }));
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
  if (state.viaOn && D.VIA) for (const k of D.VIA.SVY_KEYS) if (state.viaSvy[k]) L.push(lg(SVY_COL[k], `Via ${SVY_SHORT[k] ?? k} pointings (1°)`));
  if (state.sightOn) L.push(lg(UI.text, 'Bish+19 Na I / Ca II sightlines'));
  for (const c of D.CONES) if (state[c.key]) L.push(lg(c.color, `${c.name} survey region (${c.fov}°)`));
  L.push(lg(UI.accent, 'current field'));
  return L.join('');
}
