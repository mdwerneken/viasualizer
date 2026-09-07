// First-run tour: darkens everything except one feature at a time, with a short card.
// Skippable at every step; replay with the ? button. Remembers completion in localStorage.
const LS_TOUR = 'viasual3_tour_done';

const STEPS = [
  { sel: null, title: 'VIAsual — Via cold-gas sightline planner',
    text: 'Pick 1° Via pointings whose backlights (stream stars, cluster and dwarf members, halo tracers, quasars) sit at <b>several distinct distances</b>, so absorption against them locates the Galaxy\'s cold gas in 3D. This tour takes about 15 seconds.' },
  { sel: '#scene', title: '3D view — the halo around you',
    text: 'The Sun is at the arrow\'s base; the red arrow is where the field points. <b>Drag the arrow tip</b> to aim, <b>scroll</b> to zoom, <b>right-drag</b> to pan, <b>double-click</b> any object to jump to it. Single-click pins a label.' },
  { sel: '#p-finder', title: 'Field view — what the fibers see',
    text: 'The 1° field on the gas/dust background. <b>Drag</b> to pan the sky, <b>double-click</b> to recenter, hover anything for details, <b>⤢</b> for full screen (there you can also two-finger scroll to pan and pinch to change the FOV).' },
  { sel: '#p-ladder', title: 'Distance ladder — the headline metric',
    text: 'Each rung is one structure at one distance (quasars count as ∞). More rungs = better 3D constraints on where the gas is. Hover a rung to light up those sources in the field view.' },
  { sel: '#p-stats', title: 'Targets & fiber budget',
    text: 'Everything a pointing here could observe, by catalog, against Via\'s 540 science fibers. Hover a count to highlight those sources.' },
  { sel: '#sidebar', title: 'Controls',
    text: 'Field size (FOV), color mode and the G-magnitude limit at the top; then catalogs, go-to targets, gas &amp; dust maps and <b>field lists</b>. <span class="k">C</span> or the ☰ button hides this sidebar for more room.', open: true },
  { sel: '#player', title: 'Field lists — step through the survey',
    text: 'Load Via\'s planned pointings or the best-ranked fields and step through them like a playlist: <span class="k">←</span> <span class="k">→</span> to step, <span class="k">space</span> to auto-play, sort by rungs, targets or HI column.', prep: 'player' },
  { sel: '[data-tab="sky"]', title: 'Sky maps',
    text: 'The Sky tab shows the whole sky in Galactic and Sagittarius-stream coordinates with the survey footprints and gas/dust layers. Click or drag the red circle to move the field.' },
  { sel: null, title: 'That\'s it',
    text: '<span class="k">⌘Z</span> / <span class="k">⌘⇧Z</span> undo and redo field moves anywhere. Explore the controls to see what else is possible, and use <b>copy link</b> in the bottom bar to share an exact field. Replay this tour with <b>?</b>.' },
];

let idx = 0, root, spot, card, hooks = {};

export function tourDone() { try { return localStorage.getItem(LS_TOUR) === '1'; } catch { return false; } }

export function initTour(h = {}) {
  hooks = h;
  root = document.getElementById('tour');
  root.innerHTML = `<div class="tour-spot"></div><div class="tour-card"></div>`;
  spot = root.querySelector('.tour-spot');
  card = root.querySelector('.tour-card');
  root.addEventListener('click', e => { if (e.target === root) next(); });
  window.addEventListener('keydown', e => {
    if (root.hidden) return;
    if (e.key === 'Escape') end();
    else if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); show(Math.max(0, idx - 1)); }
  });
  window.addEventListener('resize', () => { if (!root.hidden) place(); });
}

export function startTour() { idx = 0; root.hidden = false; show(0); }

function end() {
  root.hidden = true;
  try { localStorage.setItem(LS_TOUR, '1'); } catch {}
  hooks.onEnd?.();
}
function next() { if (idx >= STEPS.length - 1) end(); else show(idx + 1); }

function show(i) {
  idx = i;
  const s = STEPS[i];
  if (s.open) hooks.openSidebar?.();
  if (s.prep === 'player') hooks.showPlayer?.();
  card.innerHTML = `<button class="tour-x" title="skip">✕</button><h3>${s.title}</h3><p>${s.text}</p>
    <div class="tour-foot"><span class="steps">${i + 1} / ${STEPS.length}</span>
    ${i > 0 ? '<button class="tour-btn" data-act="back">back</button>' : ''}
    <button class="tour-btn" data-act="skip">skip</button>
    <button class="tour-btn primary" data-act="next">${i === STEPS.length - 1 ? 'done' : 'next'}</button></div>`;
  card.querySelector('.tour-x').addEventListener('click', end);
  card.querySelector('[data-act="skip"]').addEventListener('click', end);
  card.querySelector('[data-act="next"]').addEventListener('click', next);
  card.querySelector('[data-act="back"]')?.addEventListener('click', () => show(idx - 1));
  // give the DOM a moment (sidebar/player may have just opened); a timer, not rAF,
  // because rAF never ticks in an occluded window
  setTimeout(place, 40);
}

function place() {
  const s = STEPS[idx];
  const target = s.sel ? document.querySelector(s.sel) : null;
  const vw = window.innerWidth, vh = window.innerHeight;
  const cw = 320, ch = card.offsetHeight || 170;
  if (!target || target.hidden || target.getClientRects().length === 0) {
    spot.style.left = `${vw / 2}px`; spot.style.top = `${vh / 2}px`; spot.style.width = '0px'; spot.style.height = '0px';
    spot.style.borderColor = 'transparent';
    card.style.left = `${(vw - cw) / 2}px`; card.style.top = `${(vh - ch) / 2}px`;
    return;
  }
  const r = target.getBoundingClientRect();
  const pad = 6;
  spot.style.borderColor = '';
  spot.style.left = `${r.left - pad}px`; spot.style.top = `${r.top - pad}px`;
  spot.style.width = `${r.width + 2 * pad}px`; spot.style.height = `${r.height + 2 * pad}px`;
  // card: to the right of the target if room, else left, else below/above
  let x, y;
  if (r.right + 16 + cw < vw) { x = r.right + 16; y = Math.min(Math.max(12, r.top), vh - ch - 12); }
  else if (r.left - 16 - cw > 0) { x = r.left - 16 - cw; y = Math.min(Math.max(12, r.top), vh - ch - 12); }
  else if (r.bottom + 12 + ch < vh) { x = Math.min(Math.max(12, r.left), vw - cw - 12); y = r.bottom + 12; }
  else { x = Math.min(Math.max(12, r.left), vw - cw - 12); y = Math.max(12, r.top - ch - 12); }
  card.style.left = `${x}px`; card.style.top = `${y}px`;
}
