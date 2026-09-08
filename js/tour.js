// First-run tour: darkens everything except one feature at a time, with a short card.
// The spotlit feature stays interactive (the shade is four panels around it); clicking
// the shade advances. The card flies out of the Tutorial button on start and sinks back
// into it on finish, so it is obvious where the tour lives. Replay with the Tutorial button.
const LS_TOUR = 'viasual3_tour_done';

const STEPS = [
  { sel: null, title: 'Explore halo sightlines',
    text: 'This is a tool for exploring Via fields in the halo. You can change which objects are shown, find and save interesting fields, and learn about the 3D distribution of known (or best-estimate) halo sources.' },
  { sel: '#scene', title: '3D view (interactive)', cam: 'sun',
    text: 'Red arrow shows the field direction, and can be dragged.<br><br>Click and drag anywhere to rotate, right-click to pan, scroll to zoom.<br><br>Click an object to pin its label, and double-click to point at it.' },
  { sel: ['#p-finder', '[data-tab="field"]'], spanX: '#dossier', title: 'Field view (interactive)', tab: 'field',
    text: 'Projected field, showing objects on-sky. Hover them for info.<br><br>Drag to pan, double-click to center, or scroll to change FOV.' },
  { sel: ['#p-allsky', '[data-tab="sky"]'], spanX: '#dossier', title: 'Sky maps', tab: 'sky',
    text: 'The all-sky view in Galactic coordinates.<br><br>Click anywhere to point there.<br><br>Press ⤢ to explore in full screen (after tutorial).' },
  { sel: '#sidebar', title: 'Controls', open: true, tab: 'field',
    text: 'Change view based on brightness, object type, catalog, and more. Change and save fields.<br><br>Press ☰ to hide.' },
  { sel: ['#player', '#lists-group'], separate: true, title: 'Browse fields', prep: 'player',
    text: 'Sort and scroll through Via\'s planned pointings, promising cold gas fields, or custom lists.' },
];

let idx = 0, root, shadePath, spots, card, hooks = {};
let camOn = false;

export function tourDone() { try { return localStorage.getItem(LS_TOUR) === '1'; } catch { return false; } }

export function initTour(h = {}) {
  hooks = h;
  root = document.getElementById('tour');
  // one SVG shade: a full-screen path with even-odd holes for each spotlight, so any
  // number of spotlit areas stay interactive while the shade (and only the shade) advances
  root.innerHTML = `<svg class="tour-shade" xmlns="http://www.w3.org/2000/svg"><path class="shade-path" fill-rule="evenodd"/><g class="spots"></g></svg>
    <div class="tour-card"></div>`;
  shadePath = root.querySelector('.shade-path');
  spots = root.querySelector('.spots');
  card = root.querySelector('.tour-card');
  shadePath.addEventListener('click', next);
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
  document.body.classList.add('tour-on');       // hides the ⤢ enlarge buttons while the tour runs
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
  document.body.classList.remove('tour-on');
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
    root.querySelector('.tour-shade').style.opacity = '0';
    setTimeout(() => {
      root.hidden = true;
      card.classList.remove('fly'); card.style.transform = ''; card.style.opacity = '';
      root.querySelector('.tour-shade').style.opacity = '';
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

// shade = whole viewport minus the hole rectangles (even-odd fill); amber outlines per hole
function setShades(holes) {
  const vw = window.innerWidth, vh = window.innerHeight;
  let d = `M0 0H${vw}V${vh}H0Z`;
  for (const h of holes) d += `M${h.x0} ${h.y0}H${h.x1}V${h.y1}H${h.x0}Z`;
  shadePath.setAttribute('d', d);
  spots.innerHTML = holes.map(h => `<rect x="${h.x0}" y="${h.y0}" width="${h.x1 - h.x0}" height="${h.y1 - h.y0}" rx="10"/>`).join('');
}

function place() {
  const s = STEPS[idx];
  const sels = s.sel ? (Array.isArray(s.sel) ? s.sel : [s.sel]) : [];
  const rects = sels.map(q => document.querySelector(q)).filter(t => t && !t.hidden && t.getClientRects().length).map(t => t.getBoundingClientRect());
  const vw = window.innerWidth, vh = window.innerHeight;
  const cw = 480, ch = card.offsetHeight || 250;
  if (!rects.length) {
    setShades([]);
    card.style.left = `${(vw - cw) / 2}px`; card.style.top = `${(vh - ch) / 2}px`;
    return;
  }
  const pad = 6;
  // spanX: take the horizontal extent from a container (so the Field and Sky boxes line up)
  const sx = s.spanX ? document.querySelector(s.spanX)?.getBoundingClientRect() : null;
  const box = q => ({ x0: (sx ? sx.left : q.left) - pad, y0: q.top - pad, x1: (sx ? sx.right : q.right) + pad, y1: q.bottom + pad });
  const holes = s.separate ? rects.map(box) : [box({
    left: Math.min(...rects.map(q => q.left)), top: Math.min(...rects.map(q => q.top)),
    right: Math.max(...rects.map(q => q.right)), bottom: Math.max(...rects.map(q => q.bottom)) })];
  setShades(holes);
  // card: to the right of the spotlit region if room, else left, else below/above
  const r = { left: Math.min(...holes.map(h => h.x0)), top: Math.min(...holes.map(h => h.y0)),
    right: Math.max(...holes.map(h => h.x1)), bottom: Math.max(...holes.map(h => h.y1)) };
  let x, y;
  if (r.right + 16 + cw < vw) { x = r.right + 16; y = Math.min(Math.max(12, r.top), vh - ch - 12); }
  else if (r.left - 16 - cw > 0) { x = r.left - 16 - cw; y = Math.min(Math.max(12, r.top), vh - ch - 12); }
  else if (r.bottom + 12 + ch < vh) { x = Math.min(Math.max(12, r.left), vw - cw - 12); y = r.bottom + 12; }
  else { x = Math.min(Math.max(12, r.left), vw - cw - 12); y = Math.max(12, r.top - ch - 12); }
  card.style.left = `${x}px`; card.style.top = `${y}px`;
}
