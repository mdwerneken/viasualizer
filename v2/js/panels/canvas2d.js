// Shared canvas helpers: DPR-aware sizing, marker glyphs, axes/histogram scaffolding.
export function fitCanvas(cv, cssW, cssH) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = Math.round(cssW), h = Math.round(cssH);
  if (cv.width !== w * dpr || cv.height !== h * dpr) {
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export function starGlyph(ctx, x, y, r, fill, stroke) {
  ctx.beginPath();
  for (let k = 0; k < 10; k++) {
    const rr = k % 2 === 0 ? r : r * 0.45;
    const a = -Math.PI / 2 + k * Math.PI / 5;
    const px = x + rr * Math.cos(a), py = y + rr * Math.sin(a);
    k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 0.7; ctx.stroke(); }
}

export function hexagram(ctx, x, y, r, fill, stroke) {
  ctx.beginPath();
  for (let k = 0; k < 12; k++) {
    const rr = k % 2 === 0 ? r : r * 0.58;
    const a = -Math.PI / 2 + k * Math.PI / 6;
    const px = x + rr * Math.cos(a), py = y + rr * Math.sin(a);
    k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 0.9; ctx.stroke(); }
}

export function diamond(ctx, x, y, r, fill, stroke) {
  ctx.beginPath();
  ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 0.9; ctx.stroke(); }
}

export function dot(ctx, x, y, r, fill, alpha = 1) {
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 2 * Math.PI);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.globalAlpha = 1;
}

export function circleOutline(ctx, x, y, r, color, lw = 1.5, dash = null) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 2 * Math.PI);
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  if (dash) ctx.setLineDash(dash);
  ctx.stroke();
  ctx.setLineDash([]);
}

// simple bar histogram into a rect; bars: [{x0,x1,count,color}] in data units
export function drawBars(ctx, rect, bars, maxCount, opts = {}) {
  const { x, y, w, h } = rect;
  for (const b of bars) {
    if (!b.count) continue;
    const bx = x + (b.t0) * w;
    const bw = Math.max(1, (b.t1 - b.t0) * w - 0.6);
    const bh = (b.count / maxCount) * h * (b.frac ?? 1);
    ctx.fillStyle = b.color;
    ctx.fillRect(bx, y + h - (b.yoff ?? 0) - bh, bw, bh);
  }
}

export function label(ctx, text, x, y, { size = 10, color = '#8b96a8', align = 'left', baseline = 'alphabetic', weight = '' } = {}) {
  ctx.font = `${weight ? weight + ' ' : ''}${size}px "SF Mono", ui-monospace, Menlo, monospace`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(text, x, y);
  ctx.textBaseline = 'alphabetic';
}
