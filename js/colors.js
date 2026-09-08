// Colour utilities: plotly-style colorscale sampling (meta.json carries the Crameri
// scales exported by the notebook) + the v3 theme palette (warm neutral dark / paper light).
// UI is mutated in place by applyTheme() so every canvas panel reads the live theme.
import { D } from './data.js';

const THEMES = {
  dark: {
    bg: '#161514', scene: '#0b0f16', panel: '#1d1c1a', panel2: '#191816', panelBorder: '#2e2c28',
    text: '#e7e2d8', textDim: '#9d968b', grid: '#2a2826', greyStar: '#4a463f',
    hiBlue: [[0, 'rgb(22,21,20)'], [0.5, 'rgb(58,80,118)'], [1, 'rgb(170,200,240)']],
    hiRed: [[0, 'rgb(24,20,18)'], [0.5, 'rgb(150,58,44)'], [1, 'rgb(250,185,140)']],
    dust: [[0, 'rgb(22,21,20)'], [0.5, 'rgb(120,86,50)'], [1, 'rgb(245,205,150)']],
    pairs: [[0, 'rgb(25,24,22)'], [0.5, 'rgb(110,100,70)'], [1, 'rgb(240,220,170)']],
    finderBg: '#141312', rungLine: '#3a3733',
  },
  light: {
    bg: '#f4f1ea', scene: '#f4f1ea', panel: '#fbf9f5', panel2: '#f2efe8', panelBorder: '#d8d2c6',
    text: '#26231f', textDim: '#6e675e', grid: '#c9c2b6', greyStar: '#c4bfb5',
    hiBlue: [[0, 'rgb(250,248,244)'], [0.5, 'rgb(150,170,205)'], [1, 'rgb(40,60,110)']],
    hiRed: [[0, 'rgb(250,246,242)'], [0.5, 'rgb(225,150,120)'], [1, 'rgb(140,40,30)']],
    dust: [[0, 'rgb(250,248,244)'], [0.5, 'rgb(210,170,120)'], [1, 'rgb(110,70,30)']],
    pairs: [[0, 'rgb(248,246,242)'], [0.5, 'rgb(190,170,120)'], [1, 'rgb(90,70,30)']],
    finderBg: '#ffffff', rungLine: '#cfc8bb',
  },
};

export const UI = {
  // theme-independent identity colors
  accent: '#e0524f',        // field red (arrow / circles)
  accentSoft: '#d8a35a',    // amber (headers, links)
  accent2: '#f2c200',       // quasar yellow
  gc: '#a06ae0',            // globular clusters
  dwarf: '#2ec695',         // dwarf galaxies
  member: '#2ec695',        // dwarf member stars — same color as the dwarfs (8-19-26)
  member2: '#7fd6c0',       // Geha+26 members (lighter teal)
  halo: '#e08b4e',          // halo RR Lyrae
  kg: '#ff6fb0',            // Chandra K giants (magenta-pink)
  bhb: '#6fb8ff',           // BHB stars (light blue)
  kep: '#b6d94a',           // Kepler-field stars (lime)
  outRange: '#5e2929',      // outside mag limit
  hist: '#c05252',
  kepler: '#4caf50',
  sun: '#ffd34d',
  axis: '#4d4944',          // plot axes / ticks / slider tracks (lighter than the panel border)
  cloud: '#6fd8e8',         // HVC clouds
  sight: '#ffffff',         // literature sightlines
  ...THEMES.dark,
};

// Via survey identity colors (pointings on the maps + list chips)
export const SVY_COL = { sps: '#f0a14d', dgs: '#2ec695', cgs: '#e0524f', krs: '#4caf50', rbs: '#c77bd8', tfs: '#c77bd8' };
export const SVY_SHORT = { sps: 'Streams', dgs: 'Dwarfs', cgs: 'Cold Gas', krs: 'Kepler', rbs: 'Rubin', tfs: 'Transients (rand)' };

export const KIND_COL = { 0: '#c05252', 1: UI.accent2, 2: UI.member, 3: UI.halo, 4: UI.kg, 5: UI.bhb, 6: UI.kep, 7: UI.member2 };
export const KIND_LBL = { 0: 'stream stars', 1: 'quasars', 2: 'dwarf members', 3: 'halo RRL', 4: 'K giants', 5: 'BHB', 6: 'Kepler stars', 7: 'Geha members' };
export const STREAM_SW = '#c05252';   // sidebar swatch for the streams show-toggle

// 20-color stream palette (v1's tab20-style list, works on dark and light)
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
  // diverging velocity scale for clouds (blue = approaching, red = receding)
  scales.vel = makeScale([[0, 'rgb(60,110,220)'], [0.5, 'rgb(235,232,225)'], [1, 'rgb(220,70,50)']]);
  applyTheme(UI.themeName ?? 'dark');
}

// switch the whole app palette; canvases re-read UI.* on their next draw
export function applyTheme(name) {
  const t = THEMES[name] ?? THEMES.dark;
  Object.assign(UI, t);
  UI.themeName = name;
  scales.hiBlue = makeScale(t.hiBlue);
  scales.hiRed = makeScale(t.hiRed);
  scales.dust = makeScale(t.dust);
  scales.pairs = makeScale(t.pairs);
  const root = document.documentElement;
  root.dataset.theme = name;
  root.style.setProperty('--bg', t.bg);
  root.style.setProperty('--panel', t.panel);
  root.style.setProperty('--panel2', t.panel2);
  root.style.setProperty('--border', t.panelBorder);
  root.style.setProperty('--text', t.text);
  root.style.setProperty('--dim', t.textDim);
}

export const HEMI_COL = { 0: '#4e9cd6', 1: '#57c069', 2: '#e06060' };  // S / Both / N
export const HEMI_LBL = { 0: 'S / Magellan', 1: 'Both', 2: 'N / MMT' };

export function streamColor(code) { return PALETTE[code % PALETTE.length]; }
export function streamColorByName(name) {
  const i = D.STREAM_NAMES.indexOf(name);
  return i >= 0 ? streamColor(i) : '#c05252';
}
// per-galaxy dwarf color (offset + stride so nearby indices don't mirror the streams)
export function dwarfColor(idx) { return PALETTE[(idx * 3 + 11) % PALETTE.length]; }
export function dwarfColorByName(name) {
  const i = D.DWF ? D.DWF.name.indexOf(name) : -1;
  return i >= 0 ? dwarfColor(i) : UI.dwarf;
}

export function hexToRgb01(hex) {
  const [r, g, b] = parseRgb(hex);
  return [r / 255, g / 255, b / 255];
}

// background-map helpers shared by finder / all-sky / Sgr strip
export function bgScale() {
  const m = state_himap();
  if (m === 'vlsr' || m === 'vgsr') return scales.vel;
  return m === 'hvc' ? scales.hiRed : (m === 'dust' || m.startsWith('e')) ? scales.dust : scales.hiBlue;
}
let _himapGetter = () => 'total';
export function bindHimap(fn) { _himapGetter = fn; }
function state_himap() { return _himapGetter(); }
export const BG_OPTIONS = [
  ['total', 'HI4PI total N(HI)'], ['hvc', 'HI4PI high-velocity N(HI)'], ['overlay', 'total + HVC overlay'],
  ['vlsr', 'HVC velocity v_LSR (km/s)'], ['vgsr', 'HVC velocity v_GSR (km/s)'],
  ['dust', 'SFD dust E(B−V) (all distances)'], ['e300', 'Edenhofer 3D dust within 300 pc'],
  ['e600', 'Edenhofer 3D dust within 600 pc'], ['e1250', 'Edenhofer 3D dust within 1.25 kpc'],
];
export function bgLabel() {
  const m = state_himap();
  if (m === 'hvc') return 'HVC log N(HI)';
  if (m === 'vlsr') return 'HVC v_LSR [km/s]';
  if (m === 'vgsr') return 'HVC v_GSR [km/s]';
  if (m === 'dust') return 'log E(B−V) SFD';
  if (m === 'e300') return 'log E (ZGR23) < 300 pc';
  if (m === 'e600') return 'log E (ZGR23) < 600 pc';
  if (m === 'e1250') return 'log E (ZGR23) < 1.25 kpc';
  return 'log N(HI)';
}
