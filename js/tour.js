// First-run tour: darkens everything except one feature at a time, with a short card.
// The spotlit feature stays interactive (the shade is four panels around it); clicking
// the shade advances. The card flies out of the Tutorial button on start and sinks back
// into it on finish, so it is obvious where the tour lives. Replay with the Tutorial button.
const LS_TOUR = 'viasual3_tour_done';

const STEPS = [
  { sel: null, title: 'Explore halo sightlines',
    text: 'This is a tool for exploring Via fields in the halo. You can change which objects are shown, find and save interesting fields, and learn about the 3D distribution of known (or best-estimate) halo sources.' },
  { sel: '#scene', title: '3D view (interactive)', cam: 'sun',
    text: 'Red arrow shows the field direction, and can be dragged. Click and drag anywhere to rotate, right-click to pan, scroll to zoom. Click an object to pin its label, and double-click to point at it.' },
  { sel: '#p-finder', title: 'Field view (interactive)', tab: 'field',
    text: 'Projected field (default 1°), showing stars and quasars on a background map (default HI). Drag to pan, hover objects for info, double-click to center, or expand to full screen.' },
  { sel: '[data-tab="sky"]', title: 'Sky maps', tab: 'sky',
    text: 'The all-sky view in Galactic and Sagittarius-Stream coordinates. Click anywhere to point there.' },
  { sel: '#sidebar', title: 'Controls', open: true, tab: 'field',
    text: 'Select objects based on brightness, type, catalog, and more. Change and save fields. Press ☰ to collapse.' },
  { sel: '#player', title: 'Scroll through selected fields', prep: 'player',
    text: 'Sort and scroll through Via\'s planned pointings, best-ranked cold gas fields, or custom field lists.' },
];

let idx = 0, root, spot, card, shades = [], hooks = {};
let camOn = false;

export function tourDone() { try { return localStorage.getItem(LS_TOUR) === '1'; } catch { return false; } }

export function initTour(h = {}) {
  hooks = h;
  root = document.getElementById('tour');
  root.innerHTML = `<div class="tour-shade"></div><div class="tour-shade"></div><div class="tour-shade"></div><div class="tour-shade"></div>
    <div class="tour-spot"></div><div class="tour-card"></div>`;
  shades = [...root.querySelectorAll('.tour-shade')];
  spot = root.querySelector('.tour-spot');
  card = root.querySelector('.tour-card');
  for (const sh of shades) sh.addEventListener('click', next);
  window.addEventListener('keydown', e => {
    if (root.hidden) return;
    if (e.key === 'Escape') end();
    else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); show(Math.max(0, idx - 1)); }
  });
  window.addEventListener('resize', () => { if (!root.hidden) place(); });
}

export function startTour() {
  idx = 0;
  hooks.reset?.();
  root.hidden = false;
  show(0, { flyIn: true });
}

function anchorRect() {
  const a = hooks.anchor?.();
  if (!a || a.getClientRects().length === 0) return null;
  return a.getBoundingClientRect();
}

function end() {
  setCam(false);
  try { localStorage.setItem(LS_TOUR, '1'); } catch {}
  const a = anchorRect();
  const lit = hooks.anchor?.();
  lit?.classList.add('lit');
  if (a) {
    // sink the card into the Tutorial button
    const r = card.getBoundingClientRect();
    card.classList.add('fly');
    card.style.transform = `translate(${a.left - r.left}px, ${a.top - r.top}px) scale(${a.width / r.width}, ${a.height / r.height})`;
    card.style.opacity = '0';
    for (const sh of shades) sh.style.opacity = '0';
    setTimeout(() => {
      root.hidden = true;
      card.classList.remove('fly'); card.style.transform = ''; card.style.opacity = '';
      for (const sh of shades) sh.style.opacity = '';
      setTimeout(() => lit?.classList.remove('lit'), 700);
      hooks.onEnd?.();
    }, 420);
  } else {
    root.hidden = true;
    setTimeout(() => lit?.classList.remove('lit'), 700);
    hooks.onEnd?.();
  }
}
function next() { if (idx >= STEPS.length - 1) end(); else show(idx + 1); }

function setCam(on) {
  if (on === camOn) return;
  camOn = on;
  hooks.camera?.(on ? 'sun' : 'halo');
}

function show(i, { flyIn = false } = {}) {
  idx = i;
  const s = STEPS[i];
  if (s.open) hooks.openSidebar?.();
  if (s.tab) hooks.showTab?.(s.tab);
  if (s.prep === 'player') hooks.showPlayer?.();
  setCam(s.cam === 'sun');
  card.innerHTML = `<button class="tour-x" title="close">✕</button><h3>${s.title}</h3><p>${s.text}</p>
    <div class="tour-foot"><span class="steps">${i + 1} / ${STEPS.length}</span>
    ${i > 0 ? '<button class="tour-btn mute" data-act="back">back</button>' : ''}
    <button class="tour-btn primary" data-act="next">${i === STEPS.length - 1 ? 'done' : 'next'}</button></div>`;
  card.querySelector('.tour-x').addEventListener('click', end);
  card.querySelector('[data-act="next"]').addEventListener('click', next);
  card.querySelector('[data-act="back"]')?.addEventListener('click', () => show(idx - 1));
  // give the DOM a moment (sidebar/player may have just opened); a timer, not rAF,
  // because rAF never ticks in an occluded window
  setTimeout(() => {
    place();
    if (flyIn) flyFromAnchor();
  }, 40);
}

// the card grows out of the Tutorial button (lit while it does)
function flyFromAnchor() {
  const a = anchorRect();
  if (!a) return;
  const lit = hooks.anchor?.();
  lit?.classList.add('lit');
  const r = card.getBoundingClientRect();
  card.style.transition = 'none';
  card.style.transform = `translate(${a.left - r.left}px, ${a.top - r.top}px) scale(${a.width / r.width}, ${a.height / r.height})`;
  card.style.opacity = '0.2';
  card.getBoundingClientRect();
  card.style.transition = '';
  card.classList.add('fly');
  card.style.transform = 'none';
  card.style.opacity = '1';
  setTimeout(() => { card.classList.remove('fly'); card.style.transform = ''; card.style.opacity = ''; lit?.classList.remove('lit'); }, 480);
}

function setShades(x0, y0, x1, y1) {
  const vw = window.innerWidth, vh = window.innerHeight;
  const put = (el, l, t, w, h) => { el.style.left = `${l}px`; el.style.top = `${t}px`; el.style.width = `${Math.max(0, w)}px`; el.style.height = `${Math.max(0, h)}px`; };
  put(shades[0], 0, 0, vw, y0);                 // top
  put(shades[1], 0, y1, vw, vh - y1);           // bottom
  put(shades[2], 0, y0, x0, y1 - y0);           // left
  put(shades[3], x1, y0, vw - x1, y1 - y0);     // right
}

function place() {
  const s = STEPS[idx];
  const target = s.sel ? document.querySelector(s.sel) : null;
  const vw = window.innerWidth, vh = window.innerHeight;
  const cw = 480, ch = card.offsetHeight || 250;
  if (!target || target.hidden || target.getClientRects().length === 0) {
    setShades(vw / 2, vh / 2, vw / 2, vh / 2);
    spot.style.left = `${vw / 2}px`; spot.style.top = `${vh / 2}px`; spot.style.width = '0px'; spot.style.height = '0px';
    spot.style.borderColor = 'transparent'; spot.style.boxShadow = 'none';
    card.style.left = `${(vw - cw) / 2}px`; card.style.top = `${(vh - ch) / 2}px`;
    return;
  }
  const r = target.getBoundingClientRect();
  const pad = 6;
  const x0 = r.left - pad, y0 = r.top - pad, x1 = r.right + pad, y1 = r.bottom + pad;
  setShades(x0, y0, x1, y1);
  spot.style.borderColor = ''; spot.style.boxShadow = '';
  spot.style.left = `${x0}px`; spot.style.top = `${y0}px`;
  spot.style.width = `${x1 - x0}px`; spot.style.height = `${y1 - y0}px`;
  // card: to the right of the target if room, else left, else below/above
  let x, y;
  if (r.right + 16 + cw < vw) { x = r.right + 16; y = Math.min(Math.max(12, r.top), vh - ch - 12); }
  else if (r.left - 16 - cw > 0) { x = r.left - 16 - cw; y = Math.min(Math.max(12, r.top), vh - ch - 12); }
  else if (r.bottom + 12 + ch < vh) { x = Math.min(Math.max(12, r.left), vw - cw - 12); y = r.bottom + 12; }
  else { x = Math.min(Math.max(12, r.left), vw - cw - 12); y = Math.max(12, r.top - ch - 12); }
  card.style.left = `${x}px`; card.style.top = `${y}px`;
}
