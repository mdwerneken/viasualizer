// three.js scene: 80k catalog stars as GPU points (positions uploaded once; color/
// size buffers rewritten in-place on state changes), object catalogs, galactic disk,
// Sun, HI shell, survey + telescope cones, and a mesh-based field pointer that can be
// dragged. No GL line primitives anywhere (macOS/ANGLE renders them unreliably).
import * as THREE from './vendor/three.module.min.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { D } from './data.js';
import { state, setField, slideField, on, emit, galField } from './state.js';
import * as C from './compute.js';
import { UI, scales, streamColor, HEMI_COL, HEMI_LBL, hexToRgb01 } from './colors.js';

let renderer, scene, camera, controls, raycaster;
let starPts, starGeom, colAttr, sizeAttr;
let gcPts, dwfPts, memPts, haloPts = null;
let pointer = {};            // shaft, tip, ring, hitProxy groups
let hiSphere = null, conesGroup = null, hemiConesGroup = null, disk, sunMesh, gridGroup;
let SUN;
let needsRender = true;
let cbarEl = null;
let pinLayer = null;
const pins = [];             // [{kind, i, el, pos:Vector3}]
const ARROW_LEN = 15;        // constant arrow length [kpc] (Matt 8-19-26)
const _tmpV = new THREE.Vector3();

const STAR_VS = `
  attribute float psize;
  attribute float alpha;
  varying float vAlpha;
  varying vec3 vColor;
  attribute vec3 color;
  void main() {
    vAlpha = alpha;
    vColor = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = psize;
    gl_Position = projectionMatrix * mv;
  }`;
const STAR_FS = `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float r2 = dot(c, c);
    if (r2 > 0.25) discard;
    float soft = smoothstep(0.25, 0.12, r2);
    gl_FragColor = vec4(vColor, vAlpha * soft);
    if (gl_FragColor.a < 0.01) discard;
  }`;
// diamond sprite (dwarf galaxies — matches the finder-chart glyph)
const DIAMOND_FS = `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 c = abs(gl_PointCoord - 0.5);
    float m = c.x + c.y;
    if (m > 0.5) discard;
    float soft = smoothstep(0.5, 0.38, m);
    gl_FragColor = vec4(vColor, vAlpha * soft);
    if (gl_FragColor.a < 0.01) discard;
  }`;

function makePointsMaterial(fs = STAR_FS) {
  return new THREE.ShaderMaterial({
    vertexShader: STAR_VS, fragmentShader: fs,
    transparent: true, depthWrite: false,
  });
}

export function initScene(container) {
  SUN = new THREE.Vector3(...D.SUN_GC);
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(new THREE.Color(UI.bg));
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, 1, 0.5, 4000);
  camera.up.set(0, 0, 1);
  const camDir = new THREE.Vector3(1.12, 1.12, 0.72).normalize();
  camera.position.copy(SUN.clone().add(camDir.multiplyScalar(160)));

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(SUN);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.addEventListener('change', () => { needsRender = true; });

  raycaster = new THREE.Raycaster();
  raycaster.params.Points.threshold = 1.2;

  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const dl = new THREE.DirectionalLight(0xffffff, 1.2);
  dl.position.set(50, 80, 120);
  scene.add(dl);

  buildStars();
  buildDisk();
  buildSun();
  buildGrid();
  buildObjectCatalogs();
  buildPointer();
  buildCones();
  buildHemiCones();
  buildColorbar(container);
  buildPinLayer(container);

  wirePicking(container);
  resize(container);
  new ResizeObserver(() => resize(container)).observe(container);

  on('field', () => { updatePointer(); needsRender = true; });
  on('ui', () => { restyle(); needsRender = true; });
  on('lock', () => { updatePointer(); needsRender = true; });
  on('quaia', () => { needsRender = true; });
  on('halo', () => { buildHaloPoints(); needsRender = true; });

  restyle();
  updatePointer();
  animate();
}

function resize(container) {
  const w = container.clientWidth, h = container.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  needsRender = true;
}

function animate() {
  requestAnimationFrame(animate);
  const moved = controls.update();
  if (needsRender || moved) {
    renderer.render(scene, camera);
    placePins();
    needsRender = false;
  }
}

// ---- stars --------------------------------------------------------------------
function buildStars() {
  const n = D.N;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[3 * i] = D.s_X[i]; pos[3 * i + 1] = D.s_Y[i]; pos[3 * i + 2] = D.s_Z[i];
  }
  starGeom = new THREE.BufferGeometry();
  starGeom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  colAttr = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
  sizeAttr = new THREE.BufferAttribute(new Float32Array(n), 1);
  const alphaAttr = new THREE.BufferAttribute(new Float32Array(n), 1);
  starGeom.setAttribute('color', colAttr);
  starGeom.setAttribute('psize', sizeAttr);
  starGeom.setAttribute('alpha', alphaAttr);
  starGeom.alphaAttr = alphaAttr;
  starPts = new THREE.Points(starGeom, makePointsMaterial());
  starPts.frustumCulled = false;
  starPts.userData.kind = 'star';
  scene.add(starPts);
}

// recolor + resize the star cloud from current state — typed-array writes only
export function restyle() {
  const n = D.N;
  const col = colAttr.array, sz = sizeAttr.array, al = starGeom.alphaAttr.array;
  const mode = state.mode, glo = state.glo, ghi = state.ghi;
  const distLo = D.DIST_MIN, distSpan = D.DIST_MAX - D.DIST_MIN;
  const densMax = D.DENS_CMAX;
  const grey = hexToRgb01(UI.greyStar), out = hexToRgb01(UI.outRange);
  const selCode = (state.hlStream && state.streamSel) ? D.STREAM_NAMES.indexOf(state.streamSel) : -1;
  const hemiRgb = [hexToRgb01(HEMI_COL[0]), hexToRgb01(HEMI_COL[1]), hexToRgb01(HEMI_COL[2])];
  const palRgb = [];
  for (let c = 0; c < 20; c++) palRgb.push(hexToRgb01(streamColor(c)));

  starPts.visible = state.streamsOn;
  for (let i = 0; i < n; i++) {
    const g = D.s_G[i];
    const inR = g >= glo && g <= ghi;
    const isVia = D.viaMask[i] === 1;
    const code = D.s_name_code[i];
    const isSel = selCode < 0 || code === selCode;
    let hide = false;
    if (state.via && !isVia) hide = true;
    if (state.hide && !inR) hide = true;
    if (hide) { al[i] = 0; sz[i] = 0; continue; }

    if (!inR) {                       // visible but outside mag window
      col[3 * i] = out[0]; col[3 * i + 1] = out[1]; col[3 * i + 2] = out[2];
      al[i] = 0.35; sz[i] = 2.0;
      continue;
    }
    if (!isSel) {                     // de-emphasised (other streams)
      col[3 * i] = grey[0]; col[3 * i + 1] = grey[1]; col[3 * i + 2] = grey[2];
      al[i] = 0.45; sz[i] = 2.2;
      continue;
    }
    let r, gg, b;
    if (mode === 'dist') {
      const t = (D.s_dist_use[i] - distLo) / distSpan;
      [r, gg, b] = scales.dist.rgb(Math.max(0, Math.min(1, t)));
      r /= 255; gg /= 255; b /= 255;
    } else if (mode === 'mag') {
      const t = (g - glo) / Math.max(1e-9, ghi - glo);
      [r, gg, b] = scales.mag.rgb(Math.max(0, Math.min(1, t)));
      r /= 255; gg /= 255; b /= 255;
    } else if (mode === 'dens') {
      const t = D.s_density[i] / densMax;
      [r, gg, b] = scales.dens.rgb(Math.max(0, Math.min(1, t)));
      r /= 255; gg /= 255; b /= 255;
    } else if (mode === 'hemi') {
      [r, gg, b] = hemiRgb[D.s_hemi[i]];
    } else {                          // stream palette
      [r, gg, b] = palRgb[code % 20];
    }
    col[3 * i] = r; col[3 * i + 1] = gg; col[3 * i + 2] = b;
    al[i] = 0.85; sz[i] = 2.6;
  }
  colAttr.needsUpdate = true;
  sizeAttr.needsUpdate = true;
  starGeom.alphaAttr.needsUpdate = true;

  restyleObjects();
  restyleCones();
  updateHiSphere();
  updateChrome();
  drawColorbar();
  needsRender = true;
}

// ---- fixed scene elements --------------------------------------------------------
function buildDisk() {
  const geo = new THREE.CylinderGeometry(10, 10, 1, 72);
  geo.rotateX(Math.PI / 2);          // cylinder axis -> z
  const mat = new THREE.MeshBasicMaterial({
    color: 0x6a5acd, transparent: true, opacity: 0.30, depthWrite: false,
  });
  disk = new THREE.Mesh(geo, mat);
  scene.add(disk);
}

function buildSun() {
  sunMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.55, 20, 14),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(UI.sun) }));
  sunMesh.position.copy(SUN);
  scene.add(sunMesh);
}

function buildGrid() {
  // reference box around the Sun (checkbox-controlled, ±BOX_R = 100 kpc)
  gridGroup = new THREE.Group();
  const R = D.BOX_R;
  const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(UI.grid) });
  gridGroup.userData.mat = mat;
  const edge = (a, b) => {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    const geo = new THREE.CylinderGeometry(0.09, 0.09, len, 5);
    geo.translate(0, len / 2, 0);
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(a);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    return m;
  };
  const cor = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    cor.push(new THREE.Vector3(SUN.x + sx * R, SUN.y + sy * R, SUN.z + sz * R));
  }
  const idx = [[0, 1], [0, 2], [0, 4], [3, 1], [3, 2], [3, 7], [5, 1], [5, 4], [5, 7], [6, 2], [6, 4], [6, 7]];
  for (const [a, b] of idx) gridGroup.add(edge(cor[a], cor[b]));
  scene.add(gridGroup);
}

function buildCones() {
  conesGroup = new THREE.Group();
  for (const cone of D.CONES) {
    const kd = C.matVec(D.RG_GAL2GC, C.unitVector1(cone.l, cone.b));
    const dir = new THREE.Vector3(...kd).normalize();
    const len = cone.len, a = cone.r * Math.PI / 180;
    const rBase = len * Math.tan(a);
    const geo = new THREE.ConeGeometry(rBase, len, 40, 1, true);
    geo.translate(0, -len / 2, 0);     // apex at origin, base at -len
    geo.rotateX(Math.PI);              // base at +len along +y
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(cone.color), transparent: true, opacity: 0.22,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(SUN);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    m.userData = { kind: 'cone', cone };
    conesGroup.add(m);
  }
  scene.add(conesGroup);
}

// telescope visibility cones: boundary surfaces of the declination rule
//   dec > SITES.Magellan + (90 - ALT_MIN)  -> MMT-only  (north cone, blue)
//   dec < SITES.MMT      - (90 - ALT_MIN)  -> Magellan-only (south cone, amber)
function buildHemiCones() {
  hemiConesGroup = new THREE.Group();
  const ncpGC = new THREE.Vector3(...C.matVec(D.R_ICRS2GC, [0, 0, 1])).normalize();
  const window_ = 90 - D.ALT_MIN;
  const defs = [
    { dec: D.SITES['Magellan (Chile)'] + window_, axis: ncpGC.clone(), color: '#7fb8f0' },
    { dec: D.SITES['MMT (Arizona)'] - window_, axis: ncpGC.clone().negate(), color: '#e0c07f' },
  ];
  for (const d of defs) {
    const half = (90 - Math.abs(d.dec)) * Math.PI / 180;
    const len = 40;
    const rBase = len * Math.tan(half);
    const geo = new THREE.ConeGeometry(rBase, len, 64, 1, true);
    geo.translate(0, -len / 2, 0);
    geo.rotateX(Math.PI);
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(d.color), transparent: true, opacity: 0.07,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(SUN);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.axis);
    hemiConesGroup.add(m);
  }
  hemiConesGroup.visible = state.hemiCones;
  scene.add(hemiConesGroup);
}

function restyleCones() {
  if (!conesGroup) return;
  for (const m of conesGroup.children) m.visible = !!state[m.userData.cone.key];
  if (hemiConesGroup) hemiConesGroup.visible = state.hemiCones;
}

// ---- object catalogs (GCs, dwarfs, members) ---------------------------------------
function catPoints(cat, colorHex, sizePx, kind, fs = STAR_FS) {
  const n = cat.lam.length;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const sz = new Float32Array(n), al = new Float32Array(n);
  const [r, g, b] = hexToRgb01(colorHex);
  const R = D.BOX_R;
  const base = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // park objects beyond the volume on its edge along the sightline (v1 behaviour)
    const vx = cat.X[i] - SUN.x, vy = cat.Y[i] - SUN.y, vz = cat.Z[i] - SUN.z;
    const rr = Math.hypot(vx, vy, vz) || 1;
    const f = Math.min(1, R / rr);
    pos[3 * i] = SUN.x + vx * f; pos[3 * i + 1] = SUN.y + vy * f; pos[3 * i + 2] = SUN.z + vz * f;
    col[3 * i] = r; col[3 * i + 1] = g; col[3 * i + 2] = b;
    let s = sizePx;
    if (cat.mass) {
      const m = Number.isFinite(cat.mass[i]) && cat.mass[i] > 0 ? cat.mass[i] : 1e2;
      s = sizePx + 5 * Math.max(0, Math.min(1, (Math.log10(Math.max(m, 1e2)) - 3) / 6));
    }
    base[i] = s;
    sz[i] = s; al[i] = 0.95;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('psize', new THREE.BufferAttribute(sz, 1));
  const alphaAttr = new THREE.BufferAttribute(al, 1);
  geo.setAttribute('alpha', alphaAttr);
  geo.alphaAttr = alphaAttr;
  const pts = new THREE.Points(geo, makePointsMaterial(fs));
  pts.frustumCulled = false;
  pts.userData = { kind, colorHex, baseSize: base };
  scene.add(pts);
  return pts;
}

function buildObjectCatalogs() {
  gcPts = catPoints(D.GCC, UI.gc, 6.5, 'gc');
  // dwarf galaxies: diamond sprite + larger, matching the finder glyph (Matt 8-19-26)
  dwfPts = catPoints(D.DWF, UI.dwarf, 10.5, 'dwarf', DIAMOND_FS);
  memPts = catPoints(D.MEM, UI.member, 2.4, 'member');
}

// grey-out unselected objects of the same type when a highlight selection is active
function tintCat(pts, cat, selIdx, selName = null) {
  const geo = pts.geometry;
  const col = geo.getAttribute('color').array;
  const al = geo.alphaAttr.array;
  const n = cat.lam.length;
  const [r, g, b] = hexToRgb01(pts.userData.colorHex);
  const [gr, gg, gb] = hexToRgb01(UI.greyStar);
  const active = selIdx !== null || selName !== null;
  for (let i = 0; i < n; i++) {
    const isSel = !active || i === selIdx || (selName !== null && cat.name[i] === selName);
    col[3 * i] = isSel ? r : gr; col[3 * i + 1] = isSel ? g : gg; col[3 * i + 2] = isSel ? b : gb;
    al[i] = isSel ? 0.95 : 0.4;
  }
  geo.getAttribute('color').needsUpdate = true;
  geo.alphaAttr.needsUpdate = true;
}

function restyleObjects() {
  gcPts.visible = state.gcOn;
  dwfPts.visible = state.dgOn;
  memPts.visible = state.dgOn && state.memOn;
  if (haloPts) haloPts.visible = state.haloOn;
  tintCat(gcPts, D.GCC, state.hlGC ? state.gcSel : null);
  tintCat(dwfPts, D.DWF, state.hlDwarf ? state.dwarfSel : null);
  const dwName = (state.hlDwarf && state.dwarfSel !== null) ? D.DWF.name[state.dwarfSel] : null;
  tintCat(memPts, D.MEM, null, dwName);
}

// halo RR Lyrae: geometry built from galactic (l,b) + dist when the file arrives
function buildHaloPoints() {
  if (haloPts || !D.HALO) return;
  const H = D.HALO, n = H.lam.length;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const sz = new Float32Array(n), al = new Float32Array(n);
  const [r, g, b] = hexToRgb01(UI.halo);
  for (let i = 0; i < n; i++) {
    const lr = H.l[i] * Math.PI / 180, br = H.b[i] * Math.PI / 180;
    const ug = [Math.cos(br) * Math.cos(lr), Math.cos(br) * Math.sin(lr), Math.sin(br)];
    const d = C.matVec(D.RG_GAL2GC, ug);
    pos[3 * i] = SUN.x + d[0] * H.dist[i];
    pos[3 * i + 1] = SUN.y + d[1] * H.dist[i];
    pos[3 * i + 2] = SUN.z + d[2] * H.dist[i];
    col[3 * i] = r; col[3 * i + 1] = g; col[3 * i + 2] = b;
    sz[i] = 1.6; al[i] = 0.30;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('psize', new THREE.BufferAttribute(sz, 1));
  const alphaAttr = new THREE.BufferAttribute(al, 1);
  geo.setAttribute('alpha', alphaAttr);
  geo.alphaAttr = alphaAttr;
  haloPts = new THREE.Points(geo, makePointsMaterial());
  haloPts.frustumCulled = false;
  haloPts.userData.kind = 'halo';
  haloPts.visible = state.haloOn;
  scene.add(haloPts);
}

// ---- HI shell ----------------------------------------------------------------------
// Custom lat-lon sphere: vertices placed directly at galactic (l,b) -> galactocentric
// directions, so the texture (plate carree in l,b) maps exactly — no rotation guessing.
function hiTexture() {
  const w = 720, h = 360;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(w, h);
  const grid = state.himap === 'hvc' && D.HI_LOG_HVC ? D.HI_LOG_HVC : D.HI_LOG_TOTAL;
  const scale = state.himap === 'hvc' ? scales.hiRed : scales.hiBlue;
  const vals = [];
  for (let i = 0; i < grid.length; i += 7) if (Number.isFinite(grid[i])) vals.push(grid[i]);
  vals.sort((a, b) => a - b);
  const v0 = C.quantileSorted(vals, 0.05), v1 = C.quantileSorted(vals, 0.99);
  for (let y = 0; y < h; y++) {
    const bb = 90 - (y + 0.5) * 180 / h;         // row 0 = +90 (texture top)
    for (let x = 0; x < w; x++) {
      const ll = -180 + (x + 0.5) * 360 / w;
      const v = C.hiSample(grid, D.HI_NY, D.HI_NX, D.HI_STEP, ll, bb);
      const p = 4 * (y * w + x);
      if (!Number.isFinite(v) || Math.abs(bb) < 15) { img.data[p + 3] = 0; continue; }
      const t = Math.max(0, Math.min(1, (v - v0) / (v1 - v0 || 1)));
      const [r, g, b] = scale.rgb(t);
      img.data[p] = r; img.data[p + 1] = g; img.data[p + 2] = b;
      img.data[p + 3] = 170;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function hiShellGeometry(R = 10, nl = 96, nb = 48) {
  const geo = new THREE.BufferGeometry();
  const nv = (nl + 1) * (nb + 1);
  const pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  let k = 0;
  for (let ib = 0; ib <= nb; ib++) {
    const b = -90 + 180 * ib / nb;
    for (let il = 0; il <= nl; il++) {
      const l = -180 + 360 * il / nl;
      const d = C.matVec(D.RG_GAL2GC, C.unitVector1(l, b));
      pos[3 * k] = SUN.x + R * d[0];
      pos[3 * k + 1] = SUN.y + R * d[1];
      pos[3 * k + 2] = SUN.z + R * d[2];
      uv[2 * k] = il / nl;                 // u: l = -180 .. 180
      uv[2 * k + 1] = ib / nb;             // v: b = -90 (bottom) .. +90 (top, flipY)
      k++;
    }
  }
  const idx = [];
  for (let ib = 0; ib < nb; ib++) {
    for (let il = 0; il < nl; il++) {
      const a = ib * (nl + 1) + il, b2 = a + nl + 1;
      idx.push(a, b2, a + 1, a + 1, b2, b2 + 1);
    }
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function updateHiSphere() {
  if (!state.hiSphere) {
    if (hiSphere) hiSphere.visible = false;
    return;
  }
  const key = state.himap;
  if (!hiSphere || hiSphere.userData.key !== key) {
    if (hiSphere) { scene.remove(hiSphere); hiSphere.geometry.dispose(); hiSphere.material.map?.dispose(); }
    const mat = new THREE.MeshBasicMaterial({
      map: hiTexture(), transparent: true, depthWrite: false, side: THREE.BackSide,
    });
    hiSphere = new THREE.Mesh(hiShellGeometry(10), mat);
    hiSphere.userData.key = key;
    hiSphere.renderOrder = -5;             // draw first: no popping against the points
    scene.add(hiSphere);
  }
  hiSphere.visible = true;
}

// ---- chrome (theme, box, disk) -----------------------------------------------------
function updateChrome() {
  const light = state.theme === 'light';
  gridGroup.visible = state.boxOn;
  gridGroup.userData.mat.color.set(light ? '#b9c2d0' : UI.grid);
  disk.visible = state.diskOn;
  renderer.setClearColor(new THREE.Color(light ? '#ffffff' : UI.bg));
}

// ---- colorbar overlay (upper-right of the 3D view) -----------------------------------
function buildColorbar(container) {
  cbarEl = document.createElement('canvas');
  cbarEl.id = 'cbar3d';
  container.appendChild(cbarEl);
}

function drawColorbar() {
  if (!cbarEl) return;
  const light = state.theme === 'light';
  const W = 64, H = 210;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  cbarEl.width = W * dpr; cbarEl.height = H * dpr;
  cbarEl.style.width = W + 'px'; cbarEl.style.height = H + 'px';
  const ctx = cbarEl.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const txt = light ? '#3a4150' : '#c6cede';
  if (state.mode === 'stream') { cbarEl.style.display = 'none'; return; }
  cbarEl.style.display = 'block';

  if (state.mode === 'hemi') {
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.fillStyle = txt;
    ctx.fillText('visibility', 4, 12);
    [2, 1, 0].forEach((k, row) => {
      ctx.fillStyle = HEMI_COL[k];
      ctx.fillRect(6, 24 + row * 20, 12, 12);
      ctx.fillStyle = txt;
      ctx.fillText(HEMI_LBL[k], 24, 34 + row * 20);
    });
    return;
  }
  const conf = {
    dist: { scale: scales.dist, lo: D.DIST_MIN, hi: D.DIST_MAX, lab: 'dist [kpc]' },
    mag: { scale: scales.mag, lo: state.glo, hi: state.ghi, lab: 'Gaia G' },
    dens: { scale: scales.dens, lo: 0, hi: D.DENS_CMAX, lab: 'density' },
  }[state.mode];
  if (!conf) { cbarEl.style.display = 'none'; return; }
  const bx = 8, by = 22, bw = 12, bh = H - by - 10;
  for (let k = 0; k < bh; k++) {
    ctx.fillStyle = conf.scale.css(1 - k / (bh - 1));    // top = max
    ctx.fillRect(bx, by + k, bw, 1.2);
  }
  ctx.strokeStyle = light ? '#9aa3b2' : '#3a4458';
  ctx.strokeRect(bx - 0.5, by - 0.5, bw + 1, bh + 1);
  ctx.font = '9.5px ui-monospace, Menlo, monospace';
  ctx.fillStyle = txt;
  ctx.fillText(conf.lab, 4, 12);
  for (let t = 0; t < 5; t++) {
    const v = conf.hi - (conf.hi - conf.lo) * t / 4;
    const y = by + bh * t / 4;
    ctx.fillRect(bx + bw, y - 0.5, 3, 1);
    const s = Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1);
    ctx.fillText(s, bx + bw + 5, y + 3);
  }
}

// ---- pinned object labels (single click toggles; multiple allowed) --------------------
function buildPinLayer(container) {
  pinLayer = document.createElement('div');
  pinLayer.id = 'pin-layer';
  container.appendChild(pinLayer);
}

function pinKey(p) { return `${p.kind}:${p.i}`; }

function togglePin(p) {
  const key = pinKey(p);
  const at = pins.findIndex(q => pinKey(q) === key);
  if (at >= 0) {
    pins[at].el.remove();
    pins.splice(at, 1);
  } else {
    const el = document.createElement('div');
    el.className = 'pin3d';
    el.innerHTML = objectHtml(p);
    el.addEventListener('click', () => togglePin(p));
    pinLayer.appendChild(el);
    pins.push({ ...p, el, pos: objectWorldPos(p) });
  }
  needsRender = true;
}

function objectWorldPos(p) {
  const v = new THREE.Vector3();
  const src = { star: starPts, gc: gcPts, dwarf: dwfPts, member: memPts, halo: haloPts }[p.kind];
  if (!src) return v;
  const a = src.geometry.getAttribute('position');
  return v.set(a.getX(p.i), a.getY(p.i), a.getZ(p.i));
}

function placePins() {
  if (!pins.length) return;
  const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
  for (const p of pins) {
    _tmpV.copy(p.pos).project(camera);
    if (_tmpV.z > 1) { p.el.style.display = 'none'; continue; }
    p.el.style.display = 'block';
    p.el.style.left = ((_tmpV.x + 1) / 2 * w + 10) + 'px';
    p.el.style.top = ((-_tmpV.y + 1) / 2 * h - 8) + 'px';
  }
}

// ---- field pointer -------------------------------------------------------------------
function fieldDir3() {
  // Sgr (lam,bet) -> ICRS -> galactocentric direction (v1's _field_dir)
  const vIcrs = C.matTVec(D.M_SGR, C.unitVector1(state.lam0, state.bet0));
  const v = C.matVec(D.R_ICRS2GC, vIcrs);
  return new THREE.Vector3(...v).normalize();
}

// constant 15 kpc arrow; locked on an object -> ~20% short of the object's distance
// (streams: tracks the stream stars around the current field as we scan along it)
function pointerLen() {
  const L = state.lock;
  if (L) {
    if (L.kind === 'stream') {
      const idx = C.fieldIndices(state.lam0, state.bet0, D.UG_SGR, Math.max(state.fov / 2, 1.0));
      const ds = [];
      for (const i of idx) if (D.streamName(i) === L.id) ds.push(D.s_dist_use[i]);
      const m = C.median(ds);
      if (Number.isFinite(m)) return Math.max(3, 0.8 * Math.min(m, D.BOX_R));
    } else if (Number.isFinite(L.dist)) {
      return Math.max(3, 0.8 * Math.min(L.dist, D.BOX_R));
    }
  }
  return ARROW_LEN;
}

function buildPointer() {
  const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff4545') });
  const shaftGeo = new THREE.CylinderGeometry(1, 1, 1, 8);
  shaftGeo.translate(0, 0.5, 0);        // base at origin, extends +y; unit radius/length
  pointer.shaft = new THREE.Mesh(shaftGeo, mat);
  const tipGeo = new THREE.ConeGeometry(1, 1, 12);   // unit; scaled in updatePointer
  tipGeo.translate(0, 0.5, 0);
  pointer.tip = new THREE.Mesh(tipGeo, mat.clone());
  pointer.ring = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.14, 8, 64),
    new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff5050') }));
  pointer.hit = new THREE.Mesh(
    new THREE.SphereGeometry(1, 12, 8),
    new THREE.MeshBasicMaterial({ visible: false }));
  pointer.hit.userData.kind = 'pointerHit';
  scene.add(pointer.shaft, pointer.tip, pointer.ring, pointer.hit);
}

export function updatePointer() {
  const dir = fieldDir3();
  const len = pointerLen();
  const up = new THREE.Vector3(0, 1, 0);
  // arrowhead scales with arrow length; default smaller than the old fixed head
  const tipLen = Math.max(0.7, len * 0.085);
  const tipRad = tipLen * 0.34;
  const shaftRad = Math.max(0.10, len * 0.013);
  const shaftLen = len - tipLen;
  pointer.shaft.position.copy(SUN);
  pointer.shaft.scale.set(shaftRad, shaftLen, shaftRad);
  pointer.shaft.quaternion.setFromUnitVectors(up, dir);
  pointer.tip.position.copy(SUN.clone().add(dir.clone().multiplyScalar(shaftLen)));
  pointer.tip.scale.set(tipRad, tipLen, tipRad);
  pointer.tip.quaternion.setFromUnitVectors(up, dir);
  // the field-size circle sits 1 kpc beyond the arrow tip
  const ringDist = len + 1;
  const rad = ringDist * Math.tan((state.fov / 2) * Math.PI / 180);
  const ringPos = SUN.clone().add(dir.clone().multiplyScalar(ringDist));
  pointer.ring.position.copy(ringPos);
  pointer.ring.scale.set(rad, rad, 1);
  pointer.ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  pointer.hit.position.copy(ringPos);
  pointer.hit.scale.setScalar(Math.max(rad * 1.6, len * 0.14, 2.0));
  pointer.userData = { len };
  needsRender = true;
}

// ---- picking: hover tooltips, click-to-pin, dblclick-to-recenter, drag-the-pointer ----
function wirePicking(container) {
  const el = renderer.domElement;
  let dragging = false;
  let downXY = null;
  let clickTimer = null;
  const dragSphere = new THREE.Sphere(new THREE.Vector3(), 1);
  let dragRadius = ARROW_LEN;

  const ndc = (e) => {
    const r = el.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1);
  };

  function pickPointer(e) {
    raycaster.setFromCamera(ndc(e), camera);
    return raycaster.intersectObject(pointer.hit, false).length > 0;
  }

  function dragToField(e) {
    raycaster.setFromCamera(ndc(e), camera);
    dragSphere.center.copy(SUN);
    dragSphere.radius = dragRadius;      // CONSTANT during a drag: no projection jumps
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectSphere(dragSphere, hit)) {
      // behind the sphere: project ray direction from Sun
      hit.copy(raycaster.ray.direction).multiplyScalar(dragSphere.radius).add(SUN);
    }
    const d = hit.sub(SUN).normalize();
    // GC direction -> ICRS -> Sgr
    const vIcrs = C.matTVec(D.R_ICRS2GC, [d.x, d.y, d.z]);
    const vSgr = C.matVec(D.M_SGR, vIcrs);
    const [lam, bet] = C.lonlatOf(vSgr);
    setField(lam, bet, { live: true });
  }

  el.addEventListener('pointerdown', (e) => {
    clearTimeout(clickTimer);          // a second click cancels any pending pin toggle
    downXY = [e.clientX, e.clientY];
    if (e.button === 0 && pickPointer(e)) {
      dragging = true;
      dragRadius = pointer.userData.len || ARROW_LEN;
      controls.enabled = false;
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
  });
  el.addEventListener('pointermove', (e) => {
    if (dragging) { dragToField(e); return; }
    hover(e);
  });
  el.addEventListener('pointerup', (e) => {
    if (dragging) {
      dragging = false;
      controls.enabled = true;
      setField(state.lam0, state.bet0);   // final (non-live) update
      return;
    }
    // single click: toggle a pinned info label (dblclick cancels it and recenters)
    if (downXY && Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]) < 5 && e.button === 0) {
      const p = pickAll(e);
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => { if (p) togglePin(p); }, 260);
    }
    downXY = null;
  });
  el.addEventListener('dblclick', (e) => {
    clearTimeout(clickTimer);
    const p = pickAll(e);
    if (p) { dblRecenter(p); return; }
    // no object: maybe a survey cone
    raycaster.setFromCamera(ndc(e), camera);
    const hits = raycaster.intersectObjects(conesGroup.children.filter(m => m.visible), false);
    if (hits.length) {
      window.dispatchEvent(new CustomEvent('v2-goto-cone', { detail: hits[0].object.userData.cone.key }));
    }
  });
  el.addEventListener('pointerleave', () => setHover(null));

  function pickAll(e) {
    raycaster.setFromCamera(ndc(e), camera);
    const targets = [];
    if (state.streamsOn) targets.push(starPts);
    if (state.gcOn) targets.push(gcPts);
    if (state.dgOn) targets.push(dwfPts);
    if (state.dgOn && state.memOn) targets.push(memPts);
    if (state.haloOn && haloPts) targets.push(haloPts);
    const hits = raycaster.intersectObjects(targets, false);
    for (const h of hits) {
      const kind = h.object.userData.kind;
      const i = h.index;
      if (kind === 'star' && starGeom.alphaAttr.array[i] <= 0.01) continue;
      return { kind, i };
    }
    return null;
  }

  function dblRecenter(p) {
    let lam, bet, lock = null;
    if (p.kind === 'star') {
      lam = D.s_lam[p.i]; bet = D.s_bet[p.i];
      lock = { kind: 'star', id: p.i, name: D.streamName(p.i), dist: D.s_dist_use[p.i] };
    } else if (p.kind === 'gc') {
      lam = D.GCC.lam[p.i]; bet = D.GCC.bet[p.i];
      lock = { kind: 'gc', id: p.i, name: D.GCC.name[p.i], dist: D.GCC.dist[p.i] };
    } else if (p.kind === 'dwarf') {
      lam = D.DWF.lam[p.i]; bet = D.DWF.bet[p.i];
      lock = { kind: 'dwarf', id: p.i, name: D.DWF.name[p.i], dist: D.DWF.dist[p.i] };
    } else if (p.kind === 'member') {
      lam = D.MEM.lam[p.i]; bet = D.MEM.bet[p.i];
      lock = { kind: 'star', id: p.i, name: `${D.MEM.name[p.i]} member`, dist: D.MEM.dist[p.i] };
    } else if (p.kind === 'halo') {
      lam = D.HALO.lam[p.i]; bet = D.HALO.bet[p.i];
      lock = { kind: 'star', id: p.i, name: 'halo RRL', dist: D.HALO.dist[p.i] };
    } else return;
    state.lock = lock;
    emit('lock');
    slideField(lam, bet, { keepLock: true });
  }

  let hoverTimer = null;
  function hover(e) {
    if (hoverTimer) return;
    hoverTimer = setTimeout(() => { hoverTimer = null; }, 40);
    setHover(pickAll(e), e);
  }
}

function objectHtml(p) {
  if (p.kind === 'star') {
    const known = D.s_dist_known[p.i] ? '' : ' (geom.)';
    return `<b>${D.streamName(p.i)}</b><br>${D.s_dist_use[p.i].toFixed(1)} kpc${known}<br>G = ${D.s_G[p.i].toFixed(2)}`;
  }
  if (p.kind === 'gc') {
    const c = D.GCC;
    let html = `<b>${c.name[p.i]}</b> · GC<br>${c.dist[p.i].toFixed(1)} kpc`;
    if (Number.isFinite(c.mass?.[p.i])) html += `<br>${c.mass[p.i].toExponential(1)} M☉`;
    return html;
  }
  if (p.kind === 'dwarf') {
    const c = D.DWF;
    return `<b>${c.name[p.i]}</b> · dwarf<br>${c.dist[p.i].toFixed(1)} kpc`;
  }
  if (p.kind === 'member') {
    const c = D.MEM;
    return `<b>${c.name[p.i]}</b> member<br>${c.dist[p.i].toFixed(0)} kpc (galaxy)<br>G = ${c.G[p.i].toFixed(2)}`;
  }
  if (p.kind === 'halo') {
    const H = D.HALO;
    return `<b>halo ${H.clsNames[H.cls[p.i]] || 'RRL'}</b><br>${H.dist[p.i].toFixed(1)} kpc (±10%)<br>G = ${H.G[p.i].toFixed(2)}`;
  }
  return '';
}

function setHover(p, e) {
  const tip = document.getElementById('tooltip3d');
  if (!p) { tip.style.display = 'none'; document.body.style.cursor = ''; return; }
  tip.innerHTML = objectHtml(p);
  tip.style.display = 'block';
  placeTooltip(tip, e);
  document.body.style.cursor = 'pointer';
}

// keep tooltips on-screen: flip to the left of the cursor near the right edge
export function placeTooltip(tip, e) {
  const pad = 12;
  tip.style.left = '0px'; tip.style.top = '0px';
  const w = tip.offsetWidth || 160;
  let x = e.clientX + pad;
  if (x + w > window.innerWidth - 6) x = e.clientX - pad - w;
  tip.style.left = x + 'px';
  tip.style.top = (e.clientY + 10) + 'px';
}

export function requestRender() { needsRender = true; }
