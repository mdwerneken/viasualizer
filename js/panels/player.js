// Field-list player — a floating transport bar over the 3D view (music-player style):
// which lists are active, previous / play / next, position, sort, visibility filter,
// save, and a scoring progress line while the list is being ranked in the background.
import { D } from '../data.js';
import { state, set, on, emit, saveCurrentField } from '../state.js';
import { LIST, SOURCES, currentItem, stepList, gotoIndex, setPlaying, isPlaying, rebuild } from '../lists.js';
import { SVY_COL } from '../colors.js';

let el;
const $ = id => document.getElementById(id);

export function initPlayer(container) {
  el = container;
  el.innerHTML = `
    <button class="pl-btn pl-close" id="pl-close" title="close list (Esc)">✕</button>
    <div class="pl-sep"></div>
    <button class="pl-btn" id="pl-prev" title="previous field (←)">‹</button>
    <button class="pl-btn play" id="pl-play" title="auto-step through the list (space)">▶</button>
    <button class="pl-btn" id="pl-next" title="next field (→)">›</button>
    <span class="pl-pos" id="pl-pos">– / 0</span>
    <div class="pl-info"><span class="pl-title" id="pl-title">no list selected</span><span class="pl-sub" id="pl-sub"></span></div>
    <div class="pl-sep"></div>
    <select class="pl-sel" id="pl-sort" title="sort the list">
      <option value="order">survey order</option>
      <option value="rungs">most distance rungs</option>
      <option value="targets">most targets</option>
      <option value="qso">most quasars</option>
      <option value="nhi">lowest HI column</option>
      <option value="dec">closest to the equator</option>
    </select>
    <label class="pl-chk" title="only fields visible from MMT or Magellan (airmass < 1.5 at transit)"><input type="checkbox" id="pl-vis"> visible</label>
    <button class="pl-btn" id="pl-save" title="save this field">☆</button>
    <div class="pl-prog" id="pl-prog" hidden><span></span></div>`;
  $('pl-prev').addEventListener('click', () => stepList(-1));
  $('pl-next').addEventListener('click', () => stepList(1));
  $('pl-play').addEventListener('click', () => setPlaying(!isPlaying()));
  $('pl-close').addEventListener('click', () => { setPlaying(false); set({ listSrc: [], listPos: -1 }, 'lists'); rebuild(); });
  $('pl-sort').value = state.listSort;
  $('pl-sort').addEventListener('change', e => { set({ listSort: e.target.value }, 'lists'); rebuild(false); });
  $('pl-vis').checked = state.listOnlyVisible;
  $('pl-vis').addEventListener('change', e => { set({ listOnlyVisible: e.target.checked }, 'lists'); rebuild(false); });
  $('pl-save').addEventListener('click', () => { saveCurrentField(); $('pl-save').textContent = '★'; setTimeout(() => { $('pl-save').textContent = '☆'; }, 900); });
  on('list', render);
  on('list-progress', renderProgress);
  on('field', render);
  render();
}

function render() {
  const has = state.listSrc.length > 0;
  el.hidden = !has;
  if (!has) return;
  const n = LIST.order.length;
  const it = currentItem();
  const names = state.listSrc.map(id => SOURCES.find(s => s.id === id)?.title ?? id);
  $('pl-pos').textContent = `${state.listPos >= 0 ? state.listPos + 1 : '–'} / ${n}`;
  if (it) {
    const dot = it.svy ? `<span class="svy-dot" style="background:${SVY_COL[it.svy]}"></span>` : '';
    $('pl-title').innerHTML = `${dot}${it.label}`;
    let sc = '';
    if (it.score) {
      sc = ` · ${it.score.rungs} rung${it.score.rungs === 1 ? '' : 's'} · ${it.score.targets} targets` +
        (it.score.vMMT && it.score.vMag ? ' · MMT+Magellan' : it.score.vMMT ? ' · MMT' : it.score.vMag ? ' · Magellan' : ' · not visible');
    }
    $('pl-sub').textContent = `${it.meta}${sc}`;
  } else {
    $('pl-title').textContent = names.join(' + ');
    $('pl-sub').textContent = n ? `${n} fields — press ▶ or › to start` : 'empty list';
  }
  $('pl-play').textContent = isPlaying() ? '❙❙' : '▶';
  $('pl-prev').disabled = $('pl-next').disabled = $('pl-play').disabled = n === 0;
  $('pl-sort').value = state.listSort;
  renderProgress();
}

function renderProgress() {
  const p = $('pl-prog');
  if (!p) return;
  if (LIST.scoring && LIST.items.length) {
    p.hidden = false;
    p.firstElementChild.style.width = `${(100 * LIST.scored / LIST.items.length).toFixed(1)}%`;
    p.title = `ranking fields with the live rules… ${LIST.scored} / ${LIST.items.length}`;
  } else p.hidden = true;
}
