// Field targets box (breakdown + fiber budget) + the bottom coordinate bar
// (Galactic / Sagittarius / Equatorial typed inputs, visibility badges).
import { D } from '../data.js';
import { state, on, emit, setField } from '../state.js';
import { F } from '../fieldmodel.js';
import * as C from '../compute.js';
import { KIND_COL } from '../colors.js';

let statsEl, barEl;

export function initStats(container, bottomBar) {
  statsEl = container;
  barEl = bottomBar;
  on('fieldmodel', render);
  statsEl.addEventListener('pointerover', e => {
    const k = e.target.closest?.('[data-hl]')?.dataset?.hl;
    if (k !== undefined) emit('hilite', { type: 'kind', kind: isNaN(+k) ? k : +k });
  });
  statsEl.addEventListener('pointerout', e => {
    if (e.target.closest?.('[data-hl]')) emit('hilite', null);
  });
}

const f1 = x => x.toFixed(1), f2 = x => x.toFixed(2);
const red = (n, hl) => `<span class="tcount"${hl !== undefined ? ` data-hl="${hl}"` : ''}>${n}</span>`;

function render() {
  // --- targets box ---
  const L = [];
  L.push(`<div class="targets-head">${red(F.fibers.targets)} targets:</div>`);
  if (F.idx.length) {
    const parts = F.comp.slice(0, 6).map(([nm, c]) => `${nm} (${c}★)`);
    L.push(`<div><b>${red(F.idx.length, 0)} stream star${F.idx.length > 1 ? 's' : ''}</b> — ` +
      `${parts.join(', ')}${F.comp.length > 6 ? ', …' : ''}</div>`);
  } else if (state.streamsOn) L.push(`<div><b>0 stream stars</b></div>`);
  // dwarfs + their members, collapsed into one line
  if (F.dw.length || F.memComp?.size) {
    const names = new Map();
    for (const i of F.dw) names.set(D.DWF.name[i], D.DWF.dist[i]);
    for (const [nm] of F.memComp) {
      if (!names.has(nm)) {
        const j = D.DWF.name.indexOf(nm);
        names.set(nm, j >= 0 ? D.DWF.dist[j] : NaN);
      }
    }
    const nDw = names.size;
    const parts = [...names.entries()].map(([nm, dist]) => {
      const nMem = F.memComp.get(nm);
      return `${nm}${nMem ? ` (${nMem}★)` : ''}${Number.isFinite(dist) ? ` at ${f1(dist)} kpc` : ''}`;
    });
    L.push(`<div><b>${red(nDw, 'dwarf')} dwarf galax${nDw > 1 ? 'ies' : 'y'}</b>: ${parts.join(', ')}</div>`);
  }
  if (F.gc.length) {
    L.push(`<div><b>${red(F.gc.length, 'gc')} globular cluster${F.gc.length > 1 ? 's' : ''}</b>: ` +
      F.gc.slice(0, 4).map(i => `${D.GCC.name[i]} (${f1(D.GCC.dist[i])} kpc)`).join(', ') + `</div>`);
  }
  if (F.hh?.length) {
    let dmin = Infinity, dmax = -Infinity;
    for (const i of F.hh) { dmin = Math.min(dmin, D.HALO.dist[i]); dmax = Math.max(dmax, D.HALO.dist[i]); }
    L.push(`<div><b>${red(F.hh.length, 3)} halo RR Lyrae</b> at ${dmin.toFixed(0)}–${dmax.toFixed(0)} kpc</div>`);
  }
  if (D.QSO && state.qsoOn) {
    L.push(`<div><b>${red(F.qq.length, 1)} quasar${F.qq.length === 1 ? '' : 's'}</b></div>`);
  } else if (!D.QSO) L.push(`<div><span class="tiny">quasars loading…</span></div>`);
  if (state.cloudsOn && F.cloudsInField) {
    if (F.cloudsInField.length) {
      const names = F.cloudsInField.slice(0, 3).map(i =>
        `${D.CLOUDS.name[i]} (v<sub>LSR</sub> ${D.CLOUDS.vlsr[i].toFixed(0)})`);
      L.push(`<div><b>${F.cloudsInField.length} HVC cloud${F.cloudsInField.length > 1 ? 's' : ''}</b> overlapping: ` +
        names.join(', ') + (F.cloudsInField.length > 3 ? ', …' : '') + `</div>`);
    } else L.push(`<div><b>0 HVC clouds</b> overlap the field</div>`);
  }
  L.push(fiberHtml());
  statsEl.innerHTML = L.join('');

  // --- bottom bar ---
  const site = F.vMMT && F.vMag ? '<span class="badge both">MMT + Magellan</span>'
    : F.vMMT ? '<span class="badge mmt">MMT</span>'
    : F.vMag ? '<span class="badge mag">Magellan</span>'
    : '<span class="badge none">not visible</span>';
  barEl.innerHTML =
    `<span class="coord"><span class="coord-lab">Galactic</span> <i>ℓ</i> <input id="in-l" value="${f2(F.l0)}"> <i>b</i> <input id="in-b" value="${f2(F.b0)}"></span>` +
    `<span class="coord"><span class="coord-lab">Sagittarius</span> Λ <input id="in-lam" value="${f2(state.lam0)}"> B <input id="in-bet" value="${f2(state.bet0)}"></span>` +
    `<span class="coord"><span class="coord-lab">Equatorial</span> α <input id="in-ra" value="${f2(F.ra)}"> δ <input id="in-dec" value="${f2(F.dec)}"></span>` +
    site +
    `<button id="copy-link" class="mini-btn" title="copy a shareable link to this exact field">copy link</button>`;
  wireInputs();
}

function fiberHtml() {
  const f = F.fibers;
  const segs = [
    ['stars', f.stars, KIND_COL[0]],
    ['dwarf ★', f.members, KIND_COL[2]],
    ['halo RRL', f.halo ?? 0, KIND_COL[3]],
    ['QSO', f.qsos, KIND_COL[1]],
  ].filter(s => s[1] > 0);
  const pct = v => Math.min(100, v / f.positioners * 100);
  let barHtml = '<div class="fiber-bar">';
  for (const [nm, v, c] of segs) {
    barHtml += `<span style="width:${pct(v)}%;background:${c}" title="${nm}: ${v}"></span>`;
  }
  barHtml += '</div>';
  const status = f.over
    ? `<b class="over">${f.over} over</b> the ${f.positioners} fibers — field is target-rich`
    : `<b>${f.spare}</b> spare fibers for ancillary science`;
  return `<div class="fiber-inline">${barHtml}` +
    `<div class="fiber-line">Via (1° FOV · ${f.positioners} fibers) → ${status}</div>` +
    (state.fov > 1.001 ? `<div class="tiny warn">FOV ${state.fov}° > instrument field — budget applies per 1° pointing</div>` : '') +
    `</div>`;
}

function wireInputs() {
  const num = id => parseFloat(document.getElementById(id).value);
  const goGal = () => {
    const l = num('in-l'), b = num('in-b');
    if (Number.isFinite(l) && Number.isFinite(b)) {
      const [lam, bet] = C.convPoint(D.M_GAL, D.M_SGR, l, b);
      setField(lam, bet);
    }
  };
  const goSgr = () => {
    const lam = num('in-lam'), bet = num('in-bet');
    if (Number.isFinite(lam) && Number.isFinite(bet)) setField(lam, bet);
  };
  const goEq = () => {
    const ra = num('in-ra'), dec = num('in-dec');
    if (Number.isFinite(ra) && Number.isFinite(dec)) {
      const v = C.matVec(D.M_SGR, C.unitVector1(ra, dec));
      const [lam, bet] = C.lonlatOf(v);
      setField(lam, bet);
    }
  };
  for (const [id, fn] of [['in-l', goGal], ['in-b', goGal], ['in-lam', goSgr],
    ['in-bet', goSgr], ['in-ra', goEq], ['in-dec', goEq]]) {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') fn();
    });
  }
  document.getElementById('copy-link').addEventListener('click', async (e) => {
    try {
      await navigator.clipboard.writeText(location.href);
      e.target.textContent = 'copied ✓';
      setTimeout(() => { e.target.textContent = 'copy link'; }, 1400);
    } catch { window.prompt('copy this link:', location.href); }
  });
}
