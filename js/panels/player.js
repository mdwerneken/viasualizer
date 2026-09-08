// Field-list explorer — a floating bar over the 3D view, shown while the sidebar's Field
// collections group is open. Manual stepping only (‹ ›, ← →); the field name is a dropdown of
// the whole list; the position "2 / 20" is editable; sort; save. Fixed width whatever is
// selected. (Auto-play and the visibility filter removed 9-7-26.)
import { D } from '../data.js';
import { state, set, on, saveCurrentField } from '../state.js';
import { LIST, SOURCES, currentItem, stepList, gotoIndex, rebuild } from '../lists.js';
import { SVY_COL } from '../colors.js';

let el;
const $ = id => document.getElementById(id);

export function initPlayer(container) {
  el = container;
  el.innerHTML = `
    <button class="pl-btn pl-close" id="pl-close" title="clear the active lists">✕</button>
    <div class="pl-sep"></div>
    <button class="pl-btn big" id="pl-prev" title="previous field (←)">‹</button>
    <span class="pl-pos" id="pl-pos"><input id="pl-idx" type="text" inputmode="numeric" title="type a field number and press Enter"> <span id="pl-n">/ 0</span></span>
    <button class="pl-btn big" id="pl-next" title="next field (→)">›</button>
    <div class="pl-info">
      <select class="pl-title-sel" id="pl-title" title="pick any field in the active lists"></select>
      <span class="pl-sub" id="pl-sub"></span>
    </div>
    <div class="pl-sep"></div>
    <select class="pl-sel" id="pl-sort" title="sort the list">
      <option value="order">survey order</option>
      <option value="rungs">most distance rungs</option>
      <option value="targets">most targets</option>
      <option value="nhi">HI column (high → low)</option>
    </select>
    <button class="mini-btn save-btn" id="pl-save" title="save this field to Save fields">save field</button>
    <div class="pl-prog" id="pl-prog" hidden><span></span></div>`;
  $('pl-prev').addEventListener('click', () => stepList(-1));
  $('pl-next').addEventListener('click', () => stepList(1));
  $('pl-close').addEventListener('click', () => { set({ listSrc: [], listPos: -1 }, 'lists'); rebuild(); });
  $('pl-sort').value = state.listSort;
  $('pl-sort').addEventListener('change', e => { set({ listSort: e.target.value }, 'lists'); rebuild(false); });
  $('pl-title').addEventListener('change', e => { if (e.target.value !== '') gotoIndex(+e.target.value); });
  const idx = $('pl-idx');
  const commit = () => {
    const v = parseInt(idx.value, 10);
    if (Number.isFinite(v) && v >= 1 && v <= LIST.order.length) gotoIndex(v - 1); else render();
  };
  idx.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(); idx.blur(); } if (e.key === 'Escape') { render(); idx.blur(); } e.stopPropagation(); });
  idx.addEventListener('blur', commit);
  $('pl-save').addEventListener('click', () => { saveCurrentField(); $('pl-save').textContent = 'saved ✓'; setTimeout(() => { $('pl-save').textContent = 'save field'; }, 900); });
  on('list', render);
  on('list-progress', renderProgress);
  on('field', render);
  on('layout', render);
  render();
}

function render() {
  el.hidden = !state.listsOpen;
  if (el.hidden) return;
  const n = LIST.order.length;
  const has = state.listSrc.length > 0;
  const it = currentItem();
  const idx = $('pl-idx');
  if (document.activeElement !== idx) idx.value = state.listPos >= 0 ? String(state.listPos + 1) : '–';
  $('pl-n').textContent = `/ ${n}`;
  const sel = $('pl-title');
  if (!has) {
    sel.innerHTML = `<option value="">no field lists selected</option>`;
    $('pl-sub').textContent = 'toggle a collection in Field collections';
  } else {
    const opts = LIST.order.map((x, i) => `<option value="${i}"${state.listPos === i ? ' selected' : ''}>${i + 1}. ${x.label}${x.sub ? ` · ${x.sub}` : ''}</option>`);
    sel.innerHTML = `<option value=""${state.listPos < 0 ? ' selected' : ''}>${n ? 'pick a field' : 'empty list'}</option>${opts.join('')}`;
    if (it) {
      let sc = '';
      if (it.score) {
        sc = ` · ${it.score.rungs} rung${it.score.rungs === 1 ? '' : 's'} · ${it.score.targets} targets` +
          (it.score.vMMT && it.score.vMag ? ' · MMT+Magellan' : it.score.vMMT ? ' · MMT' : it.score.vMag ? ' · Magellan' : ' · not visible');
      }
      $('pl-sub').textContent = `${it.meta}${sc}`;
    } else $('pl-sub').textContent = n ? `${n} fields — ‹ › or ← → to step` : 'empty list';
    sel.classList.toggle('nonesel', state.listPos < 0);
  }
  sel.style.setProperty('--dot', it?.svy ? SVY_COL[it.svy] : 'transparent');
  $('pl-prev').disabled = $('pl-next').disabled = n === 0;
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
