// Colour utilities: plotly-style colorscale sampling (meta.json carries the Crameri
// scales exported by the notebook) + the v2 dark-theme palette.
import { D } from './data.js';

export const UI = {
  bg: '#0b0f16',            // page / canvas background
  panel: '#121826',
  panelBorder: '#232c3d',
  text: '#dbe2ee',
  textDim: '#8b96a8',
  accent: '#e05252',        // field red (arrow / circles)
  accent2: '#f2c200',       // quasar yellow
  gc: '#a06ae0',            // globular clusters (lifted for dark bg)
  dwarf: '#2ec695',         // dwarf galaxies
  member: '#4da3ff',
  halo: '#e08b4e',        // halo RR Lyrae        // dwarf member stars
  greyStar: '#3d4658',      // de-emphasised stars
  outRange: '#5e2929',      // outside mag limit
  hist: '#c05252',
  kepler: '#4caf50',
  grid: '#1c2536',
  sun: '#ffd34d',
};

export const KIND_COL = { 0: '#c05252', 1: UI.accent2, 2: UI.member, 3: '#e08b4e' };
export const KIND_LBL = { 0: 'stream stars', 1: 'quasars', 2: 'dwarf members', 3: 'halo RRL' };

// 20-colour stream palette (v1's tab20-style list, works on dark)
export const PALETTE = ['#4e9cd6', '#ff9a4d', '#57c069', '#e06060', '#b48ee0', '#a8766a',
  '#f0a3d8', '#a5adb8', '#d4d660', '#4ed3e8', '#7a7fd4', '#8fb055', '#c9a24f', '#c96b66',
  '#b070b0', '#8486d0', '#a6c46e', '#d8b855', '#c4706e', '#c96fb2'];

function parseRgb(s) {
  const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(s.replace(/\s/g, ''));
  if (m) return [+m[1], +m[2], +m[3]];
  const h = /^#?([0-9a-f]{6})$/i.exec(s);
  if (h) { const v = parseInt(h[1], 16); return [v >> 16, (v >> 8) & 255, v & 255]; }
  return [255, 0, 255];
}

// build a fast 256-entry LUT sampler from a plotly colorscale [[t, 'rgb(..)'], ...]
export function makeScale(colorscale) {
  const stops = colorscale.map(([t, c]) => [t, parseRgb(c)]);
  const lut = new Uint8Array(256 * 3);
  let k = 0;
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, c0] = stops[k], [t1, c1] = stops[k + 1];
    const f = t1 > t0 ? Math.max(0, Math.min(1, (t - t0) / (t1 - t0))) : 0;
    for (let j = 0; j < 3; j++) lut[3 * i + j] = Math.round(c0[j] + (c1[j] - c0[j]) * f);
  }
  return {
    lut,
    rgb(t) {
      const i = Math.max(0, Math.min(255, Math.round(t * 255)));
      return [lut[3 * i], lut[3 * i + 1], lut[3 * i + 2]];
    },
    css(t) { const [r, g, b] = this.rgb(t); return `rgb(${r},${g},${b})`; },
  };
}

export const scales = {};
export function initScales() {
  scales.dist = makeScale(D.CMAP_DIST);
  scales.mag = makeScale(D.CMAP_MAG);
  scales.dens = makeScale(D.CMAP_DENS);
  // HI backgrounds: dark-friendly monochrome ramps (blue for total, red for HVC)
  scales.hiBlue = makeScale([[0, 'rgb(11,15,22)'], [0.5, 'rgb(38,70,124)'], [1, 'rgb(158,196,243)']]);
  scales.hiRed = makeScale([[0, 'rgb(22,11,11)'], [0.5, 'rgb(140,50,40)'], [1, 'rgb(250,180,140)']]);
  scales.pairs = makeScale([[0, 'rgb(18,24,38)'], [0.5, 'rgb(60,100,170)'], [1, 'rgb(170,210,255)']]);
}

export const HEMI_COL = { 0: '#4e9cd6', 1: '#57c069', 2: '#e06060' };  // S / Both / N
export const HEMI_LBL = { 0: 'S', 1: 'Both', 2: 'N' };

export function streamColor(code) { return PALETTE[code % PALETTE.length]; }

export function hexToRgb01(hex) {
  const [r, g, b] = parseRgb(hex);
  return [r / 255, g / 255, b / 255];
}
