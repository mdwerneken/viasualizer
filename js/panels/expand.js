// Full-screen enlarge for the dossier panels (field / sky / Sgr views).
// Expands over everything except the left control sidebar; ✕ or Esc collapses.
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
    wrap.classList.toggle('expanded', v);
    btn.style.display = v ? 'none' : '';
    close.style.display = v ? '' : 'none';
    onToggle?.(v);
  }
  btn.addEventListener('click', e => { e.stopPropagation(); setExpanded(true); });
  close.addEventListener('click', e => { e.stopPropagation(); setExpanded(false); });
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && expanded) setExpanded(false); });
  return { isExpanded: () => expanded, collapse: () => setExpanded(false) };
}
