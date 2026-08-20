// Full-screen enlarge for the dossier panels (field / sky / Sgr views).
// Expands over everything except the left control sidebar; ✕ or Esc collapses.
// Uses a FLIP transform so the panel visually grows from its place in the column.
export function makeExpandable(wrap, { onToggle } = {}) {
  const btn = document.createElement('button');
  btn.className = 'expand-btn';
  btn.title = 'enlarge';
  btn.textContent = '⤢';
  const close = document.createElement('button');
  close.className = 'expand-close';
  close.title = 'close (Esc)';
  close.textContent = '✕';
  close.style.display = 'none';
  wrap.append(btn, close);
  let expanded = false;
  function setExpanded(v) {
    if (v === expanded) return;
    expanded = v;
    if (v) {
      const r0 = wrap.getBoundingClientRect();
      wrap.classList.add('expanded');
      const r1 = wrap.getBoundingClientRect();
      const sx = Math.max(0.04, r0.width / Math.max(1, r1.width));
      const sy = Math.max(0.04, r0.height / Math.max(1, r1.height));
      wrap.style.transformOrigin = 'top left';
      wrap.style.transition = 'none';
      wrap.style.transform =
        `translate(${r0.left - r1.left}px, ${r0.top - r1.top}px) scale(${sx}, ${sy})`;
      wrap.getBoundingClientRect();               // force reflow before animating
      wrap.style.transition = 'transform .28s ease';
      wrap.style.transform = 'none';
      setTimeout(() => { wrap.style.transition = ''; wrap.style.transform = ''; }, 300);
    } else {
      wrap.classList.remove('expanded');
      wrap.style.transition = '';
      wrap.style.transform = '';
    }
    btn.style.display = v ? 'none' : '';
    close.style.display = v ? '' : 'none';
    onToggle?.(v);
  }
  btn.addEventListener('click', e => { e.stopPropagation(); setExpanded(true); });
  close.addEventListener('click', e => { e.stopPropagation(); setExpanded(false); });
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && expanded) setExpanded(false); });
  return { isExpanded: () => expanded, collapse: () => setExpanded(false) };
}
