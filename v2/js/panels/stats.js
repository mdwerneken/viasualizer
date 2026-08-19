// Field stats block + the bottom coordinate bar (readouts, visibility badges).
import { D } from '../data.js';
import { state, on } from '../state.js';
import { F } from '../fieldmodel.js';

let statsEl, barEl;

export function initStats(container, bottomBar) {
  statsEl = container;
  barEl = bottomBar;
  on('fieldmodel', render);
}

const f1 = x => x.toFixed(1), f2 = x => x.toFixed(2);

function render() {
  // --- dossier stats block ---
  const L = [];
  if (F.comp.length) {
    const parts = F.comp.slice(0, 6).map(([nm, c]) => `${nm} (${c})`);
    if (F.comp.length > 6) parts.push `…`;
    L.push(`<b>${F.idx.length} stream stars</b> — ${parts.join(', ')}${F.comp.length > 6 ? ', …' : ''}`);
  } else L.push(`<b>0 stream stars</b>`);
  if (F.hi) L.push(`<b>HI column${state.himap === 'hvc' ? ' (HVC)' : ''}</b>: mean ${F.hi.mean.toExponential(2)}, peak ${F.hi.peak.toExponential(2)} cm⁻² (log ${Math.log10(F.hi.mean).toFixed(2)})`);
  else if (state.himap === 'hvc') L.push(`<b>no HVC signal</b> in field`);
  if (F.gc.length) L.push(`<b>${F.gc.length} globular cluster${F.gc.length > 1 ? 's' : ''}</b>: ` +
    F.gc.slice(0, 4).map(i => `${D.GCC.name[i]} (${f1(D.GCC.dist[i])} kpc)`).join(', '));
  if (F.dw.length) L.push(`<b>${F.dw.length} dwarf galax${F.dw.length > 1 ? 'ies' : 'y'}</b>: ` +
    F.dw.slice(0, 4).map(i => `${D.DWF.name[i]} (${f1(D.DWF.dist[i])} kpc)`).join(', '));
  if (F.mm.length) {
    const names = new Map();
    for (const i of F.mm) names.set(D.MEM.name[i], (names.get(D.MEM.name[i]) ?? 0) + 1);
    let gmin = Infinity, gmax = -Infinity;
    for (const i of F.mm) {
      const g = D.MEM.G[i];
      if (Number.isFinite(g)) { gmin = Math.min(gmin, g); gmax = Math.max(gmax, g); }
    }
    L.push(`<b>${F.mm.length} dwarf member stars</b> at G ${f1(gmin)}–${f1(gmax)} — ` +
      [...names.entries()].map(([n, c]) => `${n} (${c})`).join(', '));
  }
  if (D.QSO && state.qsoOn) {
    let gmin = Infinity, gmax = -Infinity;
    for (const i of F.qq) { gmin = Math.min(gmin, D.QSO.G[i]); gmax = Math.max(gmax, D.QSO.G[i]); }
    L.push(`<b>${F.qq.length} quasars</b>${F.qq.length ? ` at G ${f1(gmin)}–${f1(gmax)}` : ''}`);
  } else if (!D.QSO) L.push(`<span class="tiny">quasars loading…</span>`);
  statsEl.innerHTML = L.map(x => `<div>${x}</div>`).join('');

  // --- bottom bar ---
  const site = F.vMMT && F.vMag ? '<span class="badge both">MMT + Magellan</span>'
    : F.vMMT ? '<span class="badge mmt">MMT</span>'
    : F.vMag ? '<span class="badge mag">Magellan</span>'
    : '<span class="badge none">not visible</span>';
  barEl.innerHTML =
    `<span class="coord"><i>ℓ</i> <input id="in-l" value="${f2(F.l0)}"> <i>b</i> <input id="in-b" value="${f2(F.b0)}"></span>` +
    `<span class="coord">Λ <input id="in-lam" value="${f2(state.lam0)}"> B <input id="in-bet" value="${f2(state.bet0)}"></span>` +
    `<span class="coord ro">α ${f1(F.ra)}° δ ${F.dec >= 0 ? '+' : ''}${f1(F.dec)}°</span>` +
    site +
    `<button id="copy-link" class="mini-btn" title="copy a shareable link to this exact field">copy link</button>`;
  wireInputs();
}

function wireInputs() {
  const num = el => parseFloat(el.value);
  const go = () => {
    const l = num(document.getElementById('in-l')), b = num(document.getElementById('in-b'));
    if (Number.isFinite(l) && Number.isFinite(b)) {
      import('../compute.js').then(C => {
        import('../state.js').then(S => {
          const [lam, bet] = C.convPoint(D.M_GAL, D.M_SGR, l, b);
          S.setField(lam, bet);
        });
      });
    }
  };
  const goSgr = () => {
    const lam = num(document.getElementById('in-lam')), bet = num(document.getElementById('in-bet'));
    if (Number.isFinite(lam) && Number.isFinite(bet)) {
      import('../state.js').then(S => S.setField(lam, bet));
    }
  };
  for (const [id, fn] of [['in-l', go], ['in-b', go], ['in-lam', goSgr], ['in-bet', goSgr]]) {
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
