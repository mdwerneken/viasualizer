// Field targets box (breakdown + fiber budget + gas/dust + Via plan here) and the bottom
// coordinate bar (Galactic / Sagittarius / Equatorial typed inputs, visibility badges).
import { D } from '../data.js';
import { state, on, emit, setField } from '../state.js';
import { F, KIND } from '../fieldmodel.js';
import * as C from '../compute.js';
import { KIND_COL, SVY_COL, SVY_SHORT } from '../colors.js';

let statsEl, barEl;

export function initStats(container, bottomBar) {
  statsEl = container;
  barEl = bottomBar;
  on('fieldmodel', render);
  statsEl.addEventListener('pointerover', e => {
    const s = e.target.closest?.('[data-hl-stream]')?.dataset?.hlStream;
    if (s !== undefined) { emit('hilite', { type: 'stream', name: s }); return; }
    const k = e.target.closest?.('[data-hl]')?.dataset?.hl;
    if (k !== undefined) emit('hilite', { type: 'kind', kind: isNaN(+k) ? k : +k });
  });
  statsEl.addEventListener('pointerout', e => {
    if (e.target.closest?.('[data-hl], [data-hl-stream]')) emit('hilite', null);
  });
  statsEl.addEventListener('click', e => {
    const v = e.target.closest?.('[data-via]')?.dataset?.via;
    if (v !== undefined) window.dispatchEvent(new CustomEvent('v3-goto-via', { detail: +v }));
  });
}

const f1 = x => x.toFixed(1), f2 = x => x.toFixed(2);
const red = (n, hl) => `<span class="tcount"${hl !== undefined ? ` data-hl="${hl}"` : ''}>${n}</span>`;
const plural = (n, s, p) => n === 1 ? s : (p ?? s + 's');

function render() {
  const L = [];
  // the count lives in the panel header ("24 TARGETS in this field")
  const tt = document.getElementById('targets-title');
  if (tt) tt.innerHTML = `${red(F.fibers.targets)} targets`;
  if (F.idx.length) {
    const parts = F.comp.slice(0, 6).map(([nm, c]) =>
      `${nm}${D.VIA_SET.has(nm) ? '<span class="tiny"> (Via)</span>' : ''} (<span class="tcount" data-hl-stream="${nm}">${c}★</span>)`);
    L.push(`<div><b>${red(F.idx.length, KIND.STAR)} stream ${plural(F.idx.length, 'star')}</b> — ` +
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
    L.push(`<div><b>${red(nDw, 'dwarf')} dwarf ${plural(nDw, 'galaxy', 'galaxies')}</b>: ${parts.join(', ')}</div>`);
  }
  if (F.gc.length) {
    L.push(`<div><b>${red(F.gc.length, 'gc')} globular ${plural(F.gc.length, 'cluster')}</b>: ` +
      F.gc.slice(0, 4).map(i => `${D.GCC.name[i]} (${f1(D.GCC.dist[i])} kpc)`).join(', ') + `</div>`);
  }
  const rangeLine = (arr, cat, kind, label) => {
    if (!arr?.length) return;
    let dmin = Infinity, dmax = -Infinity;
    for (const i of arr) { dmin = Math.min(dmin, cat.dist[i]); dmax = Math.max(dmax, cat.dist[i]); }
    L.push(`<div><b>${red(arr.length, kind)} ${label}</b> at ${dmin.toFixed(dmin < 10 ? 1 : 0)}–${dmax.toFixed(dmax < 10 ? 1 : 0)} kpc</div>`);
  };
  rangeLine(F.hh, D.HALO, KIND.HALO, plural(F.hh?.length, 'halo RR Lyrae', 'halo RR Lyrae'));
  rangeLine(F.kg, D.KG, KIND.KG, plural(F.kg.length, 'K giant'));
  rangeLine(F.bhb, D.BHB, KIND.BHB, plural(F.bhb.length, 'BHB star'));
  rangeLine(F.kep, D.KEP, KIND.KEP, plural(F.kep.length, 'Kepler-field star'));
  if (D.QSO && state.qsoOn) {
    L.push(`<div><b>${red(F.qq.length, KIND.QSO)} ${plural(F.qq.length, 'quasar')}</b></div>`);
  } else if (!D.QSO && state.qsoOn) L.push(`<div><span class="tiny">quasars loading…</span></div>`);
  // gas + dust along the sightline
  const gas = [];
  if (F.hiTotal) gas.push(`log N(HI) <b>${F.hiTotal.logMean.toFixed(2)}</b> mean · ${F.hiTotal.logPeak.toFixed(2)} peak`);
  if (['hvc', 'overlay', 'vlsr', 'vgsr'].includes(state.himap)) gas.push(F.hi ? `HVC log N(HI) <b>${F.hi.logMean.toFixed(2)}</b> mean · ${F.hi.logPeak.toFixed(2)} peak` : 'no HVC gas in field');
  if (F.vel) gas.push(`HVC ${state.himap === 'vlsr' ? 'v<sub>LSR</sub>' : 'v<sub>GSR</sub>'} <b>${F.vel.mean.toFixed(0)}</b> km/s mean (intensity-weighted, Westmeier 2018)`);
  if (F.ebv) gas.push(`E(B−V) <b>${F.ebv.mean.toFixed(3)}</b> mag (SFD, all distances)`);
  if (F.e3d) gas.push(`ZGR23 E <b>${F.e3d.mean.toFixed(3)}</b> within ${{ e300: '300 pc', e600: '600 pc', e1250: '1.25 kpc' }[state.himap]} (Edenhofer+24; A<sub>V</sub> ≈ 2.8 E)`);
  if (state.cloudsOn && F.cloudsInField) {
    if (F.cloudsInField.length) {
      gas.push(`<b>${F.cloudsInField.length} HVC ${plural(F.cloudsInField.length, 'cloud')}</b> overlapping — hover the outline in the field view`);
    } else gas.push(`no cataloged HVC clouds overlap the field`);
  }
  if (gas.length) L.push(`<div class="gasline">${gas.join('<br>')}</div>`);
  L.push(fiberHtml());

  // Via planned pointings overlapping this field
  if (D.VIA && state.viaOn) {
    if (F.via.length) {
      const V = D.VIA;
      const items = F.via.slice(0, 6).map(i =>
        `<span data-via="${i}" style="cursor:pointer" title="jump to this pointing"><span class="svy-dot" style="background:${SVY_COL[V.svy[i]]}"></span>${SVY_SHORT[V.svy[i]] ?? V.svy[i]}${V.sub[i] ? '/' + V.sub[i] : ''}: ${V.name[i] || 'tile ' + V.tile[i]}</span>`);
      L.push(`<div class="via-here"><b>${F.via.length} planned Via ${plural(F.via.length, 'pointing')}</b> overlap this field — ${items.join(' · ')}${F.via.length > 6 ? ' · …' : ''}</div>`);
    } else L.push(`<div class="via-here tiny">no planned Via pointing overlaps this field</div>`);
  }
  statsEl.innerHTML = L.join('');

  // --- bottom bar ---
  const site = F.vMMT && F.vMag ? '<span class="badge both">MMT + Magellan</span>'
    : F.vMMT ? '<span class="badge mmt">MMT</span>'
    : F.vMag ? '<span class="badge mag">Magellan</span>'
    : '<span class="badge none">not visible</span>';
  barEl.innerHTML =
    `<span class="coord"><span class="coord-lab">Galactic</span> <i>ℓ</i> <input id="in-l" value="${f2(F.l0)}"> <i>b</i> <input id="in-b" value="${f2(F.b0)}"></span>` +
    `<span class="coord"><span class="coord-lab">Sgr stream</span> Λ <input id="in-lam" value="${f2(state.lam0)}"> B <input id="in-bet" value="${f2(state.bet0)}"></span>` +
    `<span class="coord"><span class="coord-lab">Equatorial</span> α <input id="in-ra" value="${f2(F.ra)}"> δ <input id="in-dec" value="${f2(F.dec)}"></span>` +
    site +
    `<button id="copy-link" class="mini-btn" title="copy a shareable link to this exact field">copy link</button>`;
  wireInputs();
}

function fiberHtml() {
  const f = F.fibers;
  const segs = [
    ['stream stars', f.stars, KIND_COL[KIND.STAR]],
    ['dwarf members', f.members, KIND_COL[KIND.MEM]],
    ['halo RRL', f.halo ?? 0, KIND_COL[KIND.HALO]],
    ['K giants', f.kg ?? 0, KIND_COL[KIND.KG]],
    ['BHB', f.bhb ?? 0, KIND_COL[KIND.BHB]],
    ['Kepler stars', f.kep ?? 0, KIND_COL[KIND.KEP]],
    ['quasars', f.qsos, KIND_COL[KIND.QSO]],
  ].filter(s => s[1] > 0);
  const pct = v => Math.min(100, v / f.science * 100);
  let barHtml = '<div class="fiber-bar">';
  for (const [nm, v, c] of segs) barHtml += `<span style="width:${pct(v)}%;background:${c}" title="${nm}: ${v}"></span>`;
  barHtml += '</div>';
  const status = f.over
    ? `<b class="over">${f.over} over</b> the ${f.science} fibers — field is target-rich`
    : `<b>${f.spare}</b> spare fibers for ancillary science`;
  return `<div class="fiber-inline">${barHtml}` +
    `<div class="fiber-line">Via (1° FOV · ${f.science} fibers) → ${status}</div></div>`;
}

function wireInputs() {
  const num = id => parseFloat(document.getElementById(id).value);
  const goGal = () => {
    const l = num('in-l'), b = num('in-b');
    if (Number.isFinite(l) && Number.isFinite(b)) setField(...C.convPoint(D.M_GAL, D.M_SGR, l, b));
  };
  const goSgr = () => {
    const lam = num('in-lam'), bet = num('in-bet');
    if (Number.isFinite(lam) && Number.isFinite(bet)) setField(lam, bet);
  };
  const goEq = () => {
    const ra = num('in-ra'), dec = num('in-dec');
    if (Number.isFinite(ra) && Number.isFinite(dec)) {
      const [lam, bet] = C.lonlatOf(C.matVec(D.M_SGR, C.unitVector1(ra, dec)));
      setField(lam, bet);
    }
  };
  for (const [id, fn] of [['in-l', goGal], ['in-b', goGal], ['in-lam', goSgr],
    ['in-bet', goSgr], ['in-ra', goEq], ['in-dec', goEq]]) {
    document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') fn(); });
  }
  document.getElementById('copy-link').addEventListener('click', async (e) => {
    try {
      await navigator.clipboard.writeText(location.href);
      e.target.textContent = 'copied ✓';
      setTimeout(() => { e.target.textContent = 'copy link'; }, 1400);
    } catch { window.prompt('copy this link:', location.href); }
  });
}
