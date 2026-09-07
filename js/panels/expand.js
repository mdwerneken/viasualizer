// Full-screen enlarge for the dossier panels (field / sky / Sgr views).
// Expands over everything except the left control sidebar; ✕ or Esc collapses.
// Opening grows from the panel's place (FLIP); closing snaps back and redraws at the
// small size BEFORE the panel becomes visible again (the v2 reverse-FLIP left the
// canvas at its enlarged size for a frame and painted a scaled ghost — Matt 9-6-26).
export function makeExpandable(wrap, { onToggle, hint } = {}) {
  const btn = document.createElement('button');
  btn.className = 'expand-btn';
  btn.title = 'enlarge';
  btn.textContent = '⤢';
  const close = document.createElement('button');
  close.className = 'expand-close';
  close.title = 'close (Esc)';
  close.textContent = '✕';
  close.style.display = 'none';
  const hintEl = document.createElement('div');
  hintEl.className = 'expand-hint';
  hintEl.textContent = hint ?? '';
  hintEl.style.display = 'none';
  wrap.append(btn, close, hintEl);
  let expanded = false;
  let placeholder = null;

  function open() {
    if (expanded) return;
    expanded = true;
    const r0 = wrap.getBoundingClientRect();
    // keep the column from collapsing while the panel is fixed-positioned
    placeholder = document.createElement('div');
    placeholder.style.height = r0.height + 'px';
    wrap.parentNode.insertBefore(placeholder, wrap);
    wrap.classList.add('expanded');
    btn.style.display = 'none';
    close.style.display = '';
    hintEl.style.display = hint ? '' : 'none';
    onToggle?.(true);
    const r1 = wrap.getBoundingClientRect();
    const sx = Math.max(0.04, r0.width / Math.max(1, r1.width));
    const sy = Math.max(0.04, r0.height / Math.max(1, r1.height));
    wrap.style.transformOrigin = 'top left';
    wrap.style.transition = 'none';
    wrap.style.transform = `translate(${r0.left - r1.left}px, ${r0.top - r1.top}px) scale(${sx}, ${sy})`;
    wrap.getBoundingClientRect();
    wrap.style.transition = 'transform .26s ease';
    wrap.style.transform = 'none';
    setTimeout(() => { wrap.style.transition = ''; wrap.style.transform = ''; }, 280);
  }
  function shut() {
    if (!expanded) return;
    expanded = false;
    wrap.style.transition = 'opacity .12s';
    wrap.style.opacity = '0';
    setTimeout(() => {
      wrap.classList.remove('expanded');
      wrap.style.transform = '';
      placeholder?.remove(); placeholder = null;
      btn.style.display = '';
      close.style.display = 'none';
      hintEl.style.display = 'none';
      onToggle?.(false);                       // redraw at the column size while invisible
      wrap.style.transition = 'opacity .18s';
      wrap.style.opacity = '1';
      setTimeout(() => { wrap.style.transition = ''; wrap.style.opacity = ''; }, 200);
    }, 120);
  }
  btn.addEventListener('click', e => { e.stopPropagation(); open(); });
  close.addEventListener('click', e => { e.stopPropagation(); shut(); });
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && expanded) shut(); });
  return { isExpanded: () => expanded, collapse: shut, expand: open };
}
