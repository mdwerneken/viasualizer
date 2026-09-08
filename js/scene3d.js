// three.js scene: 80k catalog stars as GPU points (positions uploaded once; color/
// size buffers rewritten in-place on state changes), object catalogs (GCs, dwarfs,
// members, halo tracers: RRL / K giants / BHB / Kepler stars), galactic disk, Sun,
// HI shell, survey + telescope cones, Via pointing directions, and a mesh-based field
// pointer that can be dragged. No GL line primitives anywhere (macOS/ANGLE bug).
import * as THREE from './vendor/three.module.min.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { D, bgGridFor } from './data.js';
import { state, setField, slideField, replaceLock, on, emit, galField } from './state.js';
import * as C from './compute.js';
import { UI, scales, streamColor, HEMI_COL, HEMI_LBL, hexToRgb01, SVY_COL, bgScale } from './colors.js';
import { LIST, sourceById } from './lists.js';

let renderer, scene, camera, controls, raycaster;
let starPts, starGeom, colAttr, sizeAttr;
let gcPts, dwfPts, memPts, mem2Pts = null;
const tracerPts = {};        // key -> THREE.Points (halo, kg, bhb, kep)
let viaPts = null, listPts = null;
let bold = 1;                // tour: thicker Sun + arrow while the 3D step is shown
const CAM_DIR = new THREE.Vector3(1.12, 1.12, 0.72).normalize();
const CAM_DIST = 160;
let pointer = {};
let hiSphere = null, conesGroup = null, hemiConesGroup = null, disk, sunMesh, gridGroup;
let SUN;
let needsRender = true;
let camBucket = -1, camThin = 1;
let cbarEl = null;
let pinLayer = null;
const pins = [];
const ARROW_LEN = 15;
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
  uniform float uDim;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float r2 = dot(c, c);
    if (r2 > 0.25) discard;
    float soft = smoothstep(0.25, 0.12, r2);
    gl_FragColor = vec4(vColor, vAlpha * soft * uDim);
    if (gl_FragColor.a < 0.01) discard;
  }`;
const DIAMOND_FS = `
  uniform float uDim;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 c = abs(gl_PointCoord - 0.5);
    float m = c.x + c.y;
    if (m > 0.5) discard;
    float soft = smoothstep(0.5, 0.38, m);
    gl_FragColor = vec4(vColor, vAlpha * soft * uDim);
    if (gl_FragColor.a < 0.01) discard;
  }`;
const HEXAGRAM_FS = `
  uniform float uDim;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    p.y = -p.y;
    bool t1 = p.y >= -0.25 && p.y <= 0.5 - 1.732 * abs(p.x);
    vec2 q = -p;
    bool t2 = q.y >= -0.25 && q.y <= 0.5 - 1.732 * abs(q.x);
    if (!t1 && !t2) discard;
    gl_FragColor = vec4(vColor, vAlpha * uDim);
    if (gl_FragColor.a < 0.01) discard;
  }`;
const RING_FS = `
  uniform float uDim;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float r2 = dot(c, c);
    if (r2 > 0.25 || r2 < 0.12) discard;
    gl_FragColor = vec4(vColor, vAlpha * uDim);
  }`;

const POINT_MATS = new Set();
function makePointsMaterial(fs = STAR_FS) {
  const m = new THREE.ShaderMaterial({ vertexShader: STAR_VS, fragmentShader: fs, transparent: true, depthWrite: false,
    uniforms: { uDim: { value: 1 } } });
  POINT_MATS.add(m);
  return m;
}
// tour: fade everything except the Sun and the arrow (points via a shader uniform,
// translucent meshes via their opacity)
const DIM_MESH = [];   // [mesh, baseOpacity]
let dimF = 1;
function setDim(f) {
  for (const m of POINT_MATS) m.uniforms.uDim.value = f;
  if (!DIM_MESH.length) {
    DIM_MESH.push([disk, disk.material.opacity]);
    for (const m of conesGroup?.children ?? []) DIM_MESH.push([m, m.material.opacity]);
  }
  for (const [m, o] of DIM_MESH) m.material.opacity = o * f;
  dimF = f;
  if (hiSphere) hiSphere.material.opacity = f;
  needsRender = true;
}

export function initScene(container) {
  SUN = new THREE.Vector3(...D.SUN_GC);
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(new THREE.Color(UI.scene));
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, 1, 0.05, 4000);
  camera.up.set(0, 0, 1);
  camera.position.copy(SUN.clone().add(CAM_DIR.clone().multiplyScalar(CAM_DIST)));

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(SUN);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.minDistance = 0.3;
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
  on('theme', () => { restyle(); needsRender = true; });
  on('lock', () => { updatePointer(); needsRender = true; });
  on('catalog', () => { buildLazyPoints(); restyle(); needsRender = true; });
  on('layout', () => setTimeout(() => resize(container), 300));
  on('list', () => { updateListShell(); needsRender = true; });
  on('lists', () => { updateVia(); updateListShell(); needsRender = true; });

  restyle();
  updatePointer();
  animate();

  window.viasualPointerXY = () => {
    const v = pointer.hit.position.clone().project(camera);
    const r = renderer.domElement.getBoundingClientRect();
    return [r.left + (v.x + 1) / 2 * r.width, r.top + (-v.y + 1) / 2 * r.height];
  };
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
    // the Sun marker shrinks as the camera closes in (0.55 kpc would swallow the local volume)
    const dcam = camera.position.distanceTo(controls.target);
    sunMesh.scale.setScalar(Math.max(0.02, Math.min(1, dcam / 160)) * bold);
    // the arrow thins out when the camera is close (a 15 kpc arrow sized for the halo view
    // reads as a beam at 3 kpc); rebuild only when the zoom bucket changes
    const bucket = Math.round(Math.log2(Math.max(1, dcam)) * 2);
    if (bucket !== camBucket) { camBucket = bucket; camThin = Math.max(0.12, Math.min(1, dcam / 160)); updatePointer(); }
    renderer.render(scene, camera);
    placePins();
    needsRender = false;
  }
}
window.viasualDebug3d = () => ({
  dust: !!dustPts, dustVisible: dustPts?.visible, dustN: dustPts?.geometry.attributes.position.count,
  camDist: camera?.position.distanceTo(controls.target), tracers: Object.keys(tracerPts),
});

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

export function restyle() {
  const n = D.N;
  const col = colAttr.array, sz = sizeAttr.array, al = starGeom.alphaAttr.array;
  const mode = state.mode, glo = state.glo, ghi = state.ghi;
  const distLo = D.DIST_MIN, distSpan = D.DIST_MAX - D.DIST_MIN;
  const light = UI.themeName === 'light';
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
    if (!inR) {
      col[3 * i] = out[0]; col[3 * i + 1] = out[1]; col[3 * i + 2] = out[2];
      al[i] = 0.35; sz[i] = 2.0;
      continue;
    }
    if (!isSel) {
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
    } else if (mode === 'hemi') {
      [r, gg, b] = hemiRgb[D.s_hemi[i]];
    } else {
      [r, gg, b] = palRgb[code % 20];
    }
    col[3 * i] = r; col[3 * i + 1] = gg; col[3 * i + 2] = b;
    al[i] = light ? 0.95 : 0.85; sz[i] = light ? 3.0 : 2.6;
  }
  colAttr.needsUpdate = true;
  sizeAttr.needsUpdate = true;
  starGeom.alphaAttr.needsUpdate = true;

  restyleObjects();
  restyleCones();
  updateHiSphere();
  updateVia();
  updateListShell();
  updateChrome();
  drawColorbar();
  needsRender = true;
}

// ---- fixed scene elements --------------------------------------------------------
function buildDisk() {
  const geo = new THREE.CylinderGeometry(10, 10, 1, 72);
  geo.rotateX(Math.PI / 2);
  // depthWrite off: the translucent slab must not hide the local dust / Kepler stars inside it
  const mat = new THREE.MeshBasicMaterial({ color: 0x6a5acd, transparent: true, opacity: 0.30, depthWrite: false });
  disk = new THREE.Mesh(geo, mat);
  disk.renderOrder = -4;
  scene.add(disk);
}
function buildSun() {
  sunMesh = new THREE.Mesh(new THREE.SphereGeometry(0.55, 20, 14), new THREE.MeshBasicMaterial({ color: new THREE.Color(UI.sun) }));
  sunMesh.position.copy(SUN);
  scene.add(sunMesh);
}
function buildGrid() {
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
    const geo = new THREE.ConeGeometry(len * Math.tan(a), len, 40, 1, true);
    geo.translate(0, -len / 2, 0);
    geo.rotateX(Math.PI);
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(cone.color), transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false });
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(SUN);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    m.userData = { kind: 'cone', cone };
    conesGroup.add(m);
  }
  scene.add(conesGroup);
}

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
    const len = 40 * Math.cos(half);
    const rBase = 40 * Math.sin(half);
    const geo = new THREE.ConeGeometry(rBase, len, 64, 1, true);
    geo.translate(0, -len / 2, 0);
    geo.rotateX(Math.PI);
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(d.color), transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false });
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

// ---- object catalogs ------------------------------------------------------------------
function catPoints(cat, colorHex, sizePx, kind, fs = STAR_FS) {
  const n = cat.lam.length;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const sz = new Float32Array(n), al = new Float32Array(n);
  const [r, g, b] = hexToRgb01(colorHex);
  const R = D.BOX_R;
  const base = new Float32Array(n);
  for (let i = 0; i < n; i++) {
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
  gcPts = catPoints(D.GCC, UI.gc, 11, 'gc', HEXAGRAM_FS);
  dwfPts = catPoints(D.DWF, UI.dwarf, 10.5, 'dwarf', DIAMOND_FS);
  memPts = catPoints(D.MEM, UI.member, 2.4, 'member');
}

// tracer clouds: geometry from galactic (l,b) + dist when the file arrives
function tracerCloud(cat, colorHex, size, alpha, kind) {
  const n = cat.lam.length;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const sz = new Float32Array(n), al = new Float32Array(n);
  const [r, g, b] = hexToRgb01(colorHex);
  const R = D.BOX_R;
  for (let i = 0; i < n; i++) {
    const lr = cat.l[i] * Math.PI / 180, br = cat.b[i] * Math.PI / 180;
    const ug = [Math.cos(br) * Math.cos(lr), Math.cos(br) * Math.sin(lr), Math.sin(br)];
    const d = C.matVec(D.RG_GAL2GC, ug);
    const dist = Math.min(cat.dist[i], R);
    pos[3 * i] = SUN.x + d[0] * dist;
    pos[3 * i + 1] = SUN.y + d[1] * dist;
    pos[3 * i + 2] = SUN.z + d[2] * dist;
    col[3 * i] = r; col[3 * i + 1] = g; col[3 * i + 2] = b;
    sz[i] = size; al[i] = alpha;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('psize', new THREE.BufferAttribute(sz, 1));
  const alphaAttr = new THREE.BufferAttribute(al, 1);
  geo.setAttribute('alpha', alphaAttr);
  geo.alphaAttr = alphaAttr;
  const pts = new THREE.Points(geo, makePointsMaterial());
  pts.frustumCulled = false;
  pts.userData = { kind, colorHex, alpha };
  scene.add(pts);
  return pts;
}

function buildLazyPoints() {
  if (D.HALO && !tracerPts.halo) tracerPts.halo = tracerCloud(D.HALO, UI.halo, 1.6, 0.30, 'halo');
  if (D.KG && !tracerPts.kg) tracerPts.kg = tracerCloud(D.KG, UI.kg, 1.4, 0.22, 'kg');
  if (D.BHB && !tracerPts.bhb) tracerPts.bhb = tracerCloud(D.BHB, UI.bhb, 2.6, 0.8, 'bhb');
  if (D.KEP && !tracerPts.kep) tracerPts.kep = tracerCloud(D.KEP, UI.kep, 1.4, 0.35, 'kep');
  if (D.MEM2 && !mem2Pts) { mem2Pts = catPoints(D.MEM2, UI.member2, 2.2, 'member2'); }
  if (D.VIA && !viaPts) buildViaPoints();
  if (D.DUST3D && !dustPts) buildDustCloud();
}

// Edenhofer+24 local dust: the densest voxels within 1.25 kpc, warm ramp by density
let dustPts = null;
function buildDustCloud() {
  const Dd = D.DUST3D, n = Dd.n;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const sz = new Float32Array(n), al = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const g = [Dd.xyz[3 * i], Dd.xyz[3 * i + 1], Dd.xyz[3 * i + 2]];      // heliocentric galactic kpc
    const d = C.matVec(D.RG_GAL2GC, g);
    pos[3 * i] = SUN.x + d[0]; pos[3 * i + 1] = SUN.y + d[1]; pos[3 * i + 2] = SUN.z + d[2];
    const w = Dd.w[i];
    const [r, gg, b] = scales.dust.rgb(0.35 + 0.65 * w);
    col[3 * i] = r / 255; col[3 * i + 1] = gg / 255; col[3 * i + 2] = b / 255;
    sz[i] = 2.0 + 2.5 * w; al[i] = 0.10 + 0.55 * w;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('psize', new THREE.BufferAttribute(sz, 1));
  const alphaAttr = new THREE.BufferAttribute(al, 1);
  geo.setAttribute('alpha', alphaAttr);
  geo.alphaAttr = alphaAttr;
  dustPts = new THREE.Points(geo, makePointsMaterial());
  dustPts.frustumCulled = false;
  dustPts.userData = { kind: 'dust' };
  dustPts.visible = state.dust3dOn;
  scene.add(dustPts);
}

// camera flights: 'local' = a few kpc from the Sun (local dust / Kepler stars), 'halo' = default
let flight = null;
function flyTo(which, { resetDir = false } = {}) {
  const dir = resetDir ? CAM_DIR.clone() : camera.position.clone().sub(controls.target).normalize();
  const dist = which === 'local' ? 3.2 : which === 'tour' ? 48 : CAM_DIST;
  const p1 = SUN.clone().add(dir.multiplyScalar(dist));
  const p0 = camera.position.clone(), t0c = controls.target.clone();
  const start = performance.now(), dur = 900;
  if (flight) clearInterval(flight);
  // a timer, not rAF, so the flight also completes in an occluded window
  flight = setInterval(() => {
    const u = Math.min(1, (performance.now() - start) / dur);
    const t = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
    camera.position.lerpVectors(p0, p1, t);
    controls.target.lerpVectors(t0c, SUN, t);
    needsRender = true;
    if (u >= 1) { clearInterval(flight); flight = null; renderer.render(scene, camera); }
  }, 16);
}
window.addEventListener('v3-zoom', e => flyTo(e.detail));
// tour: reset to the default orientation; the 3D step closes in on the Sun with a bold arrow
export function tourCamera(mode) {
  if (mode === 'reset') { bold = 1; setDim(1); flyTo('halo', { resetDir: true }); }
  else if (mode === 'sun') { bold = 2.6; setDim(0.16); flyTo('tour', { resetDir: true }); }
  else { bold = 1; setDim(1); flyTo('halo'); }
  updatePointer();
  needsRender = true;
}

function tintCat(pts, cat, selIdx, selName = null, visFn = null) {
  const geo = pts.geometry;
  const col = geo.getAttribute('color').array;
  const al = geo.alphaAttr.array;
  const n = cat.lam.length;
  const [r, g, b] = hexToRgb01(pts.userData.colorHex);
  const [gr, gg, gb] = hexToRgb01(UI.greyStar);
  const active = selIdx !== null || selName !== null;
  for (let i = 0; i < n; i++) {
    if (visFn && !visFn(i)) { al[i] = 0; continue; }
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
  if (mem2Pts) mem2Pts.visible = state.dgOn && state.mem2On;
  if (tracerPts.halo) tracerPts.halo.visible = state.haloOn;
  if (tracerPts.kg) tracerPts.kg.visible = state.kgOn;
  if (tracerPts.bhb) tracerPts.bhb.visible = state.bhbOn;
  if (tracerPts.kep) tracerPts.kep.visible = state.kepOn;
  if (dustPts) dustPts.visible = state.dust3dOn;
  // the magnitude limit hides individual stars in 3D too (members + tracers; GCs/dwarfs
  // have no per-object G) — Matt 9-7-26
  const magOk = g => !state.hide || !Number.isFinite(g) || (g >= state.glo && g <= state.ghi);
  const dwVis = state.viaDwarfs ? i => Number.isFinite(D.DWF.dist[i]) && D.DWF.dist[i] < 300 : null;
  const memVis = i => magOk(D.MEM.G[i]) && (!state.viaDwarfs || (Number.isFinite(D.MEM.dist[i]) && D.MEM.dist[i] < 300));
  tintCat(gcPts, D.GCC, state.hlGC ? state.gcSel : null);
  tintCat(dwfPts, D.DWF, state.hlDwarf ? state.dwarfSel : null, null, dwVis);
  const dwName = (state.hlDwarf && state.dwarfSel !== null) ? D.DWF.name[state.dwarfSel] : null;
  tintCat(memPts, D.MEM, null, dwName, memVis);
  if (mem2Pts) tintCat(mem2Pts, D.MEM2, null, dwName, i => magOk(D.MEM2.G[i]) && (!state.viaDwarfs || D.MEM2.dist[i] < 300));
  for (const [key, cat] of [['halo', D.HALO], ['kg', D.KG], ['bhb', D.BHB], ['kep', D.KEP]]) {
    const pts = tracerPts[key];
    if (!pts || !cat) continue;
    const al = pts.geometry.alphaAttr.array, base = pts.userData.alpha ?? 0.8;
    for (let i = 0; i < cat.lam.length; i++) al[i] = magOk(cat.G[i]) ? base : 0;
    pts.geometry.alphaAttr.needsUpdate = true;
  }
}

// Via pointing directions on a 15 kpc shell (ring sprites, survey colors)
function buildViaPoints() {
  const V = D.VIA, n = V.svy.length;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const sz = new Float32Array(n), al = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const d = C.matVec(D.RG_GAL2GC, C.unitVector1(V.l[i], V.b[i]));
    pos[3 * i] = SUN.x + d[0] * ARROW_LEN; pos[3 * i + 1] = SUN.y + d[1] * ARROW_LEN; pos[3 * i + 2] = SUN.z + d[2] * ARROW_LEN;
    const [r, g, b] = hexToRgb01(SVY_COL[V.svy[i]] ?? '#888888');
    col[3 * i] = r; col[3 * i + 1] = g; col[3 * i + 2] = b;
    sz[i] = 5; al[i] = 0.8;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('psize', new THREE.BufferAttribute(sz, 1));
  const alphaAttr = new THREE.BufferAttribute(al, 1);
  geo.setAttribute('alpha', alphaAttr);
  geo.alphaAttr = alphaAttr;
  viaPts = new THREE.Points(geo, makePointsMaterial(RING_FS));
  viaPts.frustumCulled = false;
  viaPts.userData = { kind: 'via' };
  scene.add(viaPts);
}
function updateVia() {
  if (!viaPts) return;
  viaPts.visible = state.via3d;
  if (!viaPts.visible) return;
  const V = D.VIA, al = viaPts.geometry.alphaAttr.array;
  for (let i = 0; i < V.svy.length; i++) al[i] = state.viaSvy[V.svy[i]] ? 0.85 : 0;
  viaPts.geometry.alphaAttr.needsUpdate = true;
}

// active non-Via field lists on the same 15 kpc shell (list colors; no hover)
function updateListShell() {
  if (listPts) { scene.remove(listPts); listPts.geometry.dispose(); listPts = null; }
  if (!state.via3d) return;
  const items = LIST.items.filter(it => !it.src.startsWith('via:'));
  if (!items.length) return;
  const n = items.length;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), sz = new Float32Array(n), al = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const it = items[i];
    const d = C.matVec(D.RG_GAL2GC, C.unitVector1(it.l, it.b));
    pos[3 * i] = SUN.x + d[0] * ARROW_LEN; pos[3 * i + 1] = SUN.y + d[1] * ARROW_LEN; pos[3 * i + 2] = SUN.z + d[2] * ARROW_LEN;
    const [r, g, b] = hexToRgb01(sourceById(it.src)?.color ?? '#ffffff');
    col[3 * i] = r; col[3 * i + 1] = g; col[3 * i + 2] = b;
    sz[i] = 6; al[i] = 0.85;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('psize', new THREE.BufferAttribute(sz, 1));
  geo.setAttribute('alpha', new THREE.BufferAttribute(al, 1));
  listPts = new THREE.Points(geo, makePointsMaterial(RING_FS));
  listPts.frustumCulled = false;
  scene.add(listPts);
}

// ---- HI / dust shell -----------------------------------------------------------------
function hiTexture() {
  const w = 720, h = 360;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(w, h);
  const grid = bgGridFor(state.himap).gal;
  const scale = bgScale();
  const vals = [];
  for (let i = 0; i < grid.length; i += 7) if (Number.isFinite(grid[i])) vals.push(grid[i]);
  vals.sort((a, b) => a - b);
  const v0 = C.quantileSorted(vals, 0.05), v1 = C.quantileSorted(vals, 0.99);
  for (let y = 0; y < h; y++) {
    const bb = 90 - (y + 0.5) * 180 / h;
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
      pos[3 * k] = SUN.x + R * d[0]; pos[3 * k + 1] = SUN.y + R * d[1]; pos[3 * k + 2] = SUN.z + R * d[2];
      uv[2 * k] = il / nl; uv[2 * k + 1] = ib / nb;
      k++;
    }
  }
  const idx = [];
  for (let ib = 0; ib < nb; ib++) for (let il = 0; il < nl; il++) {
    const a = ib * (nl + 1) + il, b2 = a + nl + 1;
    idx.push(a, b2, a + 1, a + 1, b2, b2 + 1);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}
function updateHiSphere() {
  if (!state.hiSphere) { if (hiSphere) hiSphere.visible = false; return; }
  const key = state.himap + '|' + UI.themeName + '|' + !!D.DUST + '|' + !!D.DUST3D;
  if (!hiSphere || hiSphere.userData.key !== key) {
    if (hiSphere) { scene.remove(hiSphere); hiSphere.geometry.dispose(); hiSphere.material.map?.dispose(); }
    const mat = new THREE.MeshBasicMaterial({ map: hiTexture(), transparent: true, depthWrite: false, side: THREE.BackSide });
    hiSphere = new THREE.Mesh(hiShellGeometry(10), mat);
    hiSphere.userData.key = key;
    hiSphere.renderOrder = -5;
    mat.opacity = dimF;
    scene.add(hiSphere);
  }
  hiSphere.visible = true;
}

// ---- chrome (theme, box, disk) -----------------------------------------------------
function updateChrome() {
  gridGroup.visible = state.boxOn;
  gridGroup.userData.mat.color.set(UI.grid);
  disk.visible = state.diskOn;
  renderer.setClearColor(new THREE.Color(UI.scene));
}

// ---- colorbar overlay (upper-right of the 3D view) -----------------------------------
function buildColorbar(container) {
  cbarEl = document.createElement('canvas');
  cbarEl.id = 'cbar3d';
  container.appendChild(cbarEl);
}
function drawColorbar() {
  if (!cbarEl) return;
  const W = 64, H = 210;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  cbarEl.width = W * dpr; cbarEl.height = H * dpr;
  cbarEl.style.width = W + 'px'; cbarEl.style.height = H + 'px';
  const ctx = cbarEl.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const txt = UI.text;
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
  }[state.mode];
  if (!conf) { cbarEl.style.display = 'none'; return; }
  const bx = 8, by = 26, bw = 12, bh = H - by - 10;
  for (let k = 0; k < bh; k++) {
    ctx.fillStyle = conf.scale.css(1 - k / (bh - 1));
    ctx.fillRect(bx, by + k, bw, 1.2);
  }
  ctx.strokeStyle = UI.panelBorder;
  ctx.strokeRect(bx - 0.5, by - 0.5, bw + 1, bh + 1);
  ctx.font = '9.5px ui-monospace, Menlo, monospace';
  ctx.fillStyle = txt;
  ctx.textAlign = 'center';
  ctx.fillText(conf.lab, W / 2, 12);
  ctx.textAlign = 'left';
  for (let t = 0; t < 5; t++) {
    const v = conf.hi - (conf.hi - conf.lo) * t / 4;
    const y = by + bh * t / 4;
    ctx.fillRect(bx + bw, y - 0.5, 3, 1);
    const s = Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1);
    ctx.fillText(s, bx + bw + 5, y + 3);
  }
}

// ---- pinned object labels -------------------------------------------------------------
function buildPinLayer(container) {
  pinLayer = document.createElement('div');
  pinLayer.id = 'pin-layer';
  container.appendChild(pinLayer);
}
function pinKey(p) { return `${p.kind}:${p.i}`; }
function togglePin(p) {
  const key = pinKey(p);
  const at = pins.findIndex(q => pinKey(q) === key);
  if (at >= 0) { pins[at].el.remove(); pins.splice(at, 1); }
  else {
    const el = document.createElement('div');
    el.className = 'pin3d';
    el.innerHTML = objectHtml(p);
    el.addEventListener('click', () => togglePin(p));
    pinLayer.appendChild(el);
    pins.push({ ...p, el, pos: objectWorldPos(p) });
  }
  needsRender = true;
}
function srcOf(kind) {
  return { star: starPts, gc: gcPts, dwarf: dwfPts, member: memPts, member2: mem2Pts, halo: tracerPts.halo, kg: tracerPts.kg, bhb: tracerPts.bhb, kep: tracerPts.kep, via: viaPts }[kind];
}
function objectWorldPos(p) {
  const v = new THREE.Vector3();
  const src = srcOf(p.kind);
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
  const vIcrs = C.matTVec(D.M_SGR, C.unitVector1(state.lam0, state.bet0));
  const v = C.matVec(D.R_ICRS2GC, vIcrs);
  return new THREE.Vector3(...v).normalize();
}
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
  shaftGeo.translate(0, 0.5, 0);
  pointer.shaft = new THREE.Mesh(shaftGeo, mat);
  const tipGeo = new THREE.ConeGeometry(1, 1, 12);
  tipGeo.translate(0, 0.5, 0);
  pointer.tip = new THREE.Mesh(tipGeo, mat.clone());
  pointer.ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.08, 8, 64), new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff5050') }));
  pointer.hit = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ visible: false }));
  pointer.hit.userData.kind = 'pointerHit';
  scene.add(pointer.shaft, pointer.tip, pointer.ring, pointer.hit);
}
export function updatePointer() {
  const dir = fieldDir3();
  const len = pointerLen();
  const up = new THREE.Vector3(0, 1, 0);
  const tipLen = Math.max(0.44, len * 0.053) * Math.max(0.35, camThin) * (bold > 1 ? 1.4 : 1);
  const tipRad = tipLen * 0.34 * (bold > 1 ? 1.5 : 1);
  const shaftRad = Math.max(0.02, len * 0.0078 * camThin) * bold;
  const shaftLen = len - tipLen;
  pointer.shaft.position.copy(SUN);
  pointer.shaft.scale.set(shaftRad, shaftLen, shaftRad);
  pointer.shaft.quaternion.setFromUnitVectors(up, dir);
  pointer.tip.position.copy(SUN.clone().add(dir.clone().multiplyScalar(shaftLen)));
  pointer.tip.scale.set(tipRad, tipLen, tipRad);
  pointer.tip.quaternion.setFromUnitVectors(up, dir);
  const ringDist = len + 1;
  const rad = Math.max(0.05, ringDist * Math.tan((state.fov / 2) * Math.PI / 180));
  const tube = Math.min(0.10, Math.max(0.025, rad * 0.06));
  pointer.ring.geometry.dispose();
  pointer.ring.geometry = new THREE.TorusGeometry(rad, tube, 8, 64);
  const ringPos = SUN.clone().add(dir.clone().multiplyScalar(ringDist));
  pointer.ring.position.copy(ringPos);
  pointer.ring.scale.set(1, 1, 1);
  pointer.ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  pointer.hit.position.copy(ringPos);
  pointer.hit.scale.setScalar(Math.max(rad * 1.6, len * 0.14, 2.0));
  pointer.hit.updateMatrixWorld();
  pointer.userData = { len };
  syncConeLengths(ringDist);
  needsRender = true;
}
function syncConeLengths(ringDist) {
  if (!conesGroup) return;
  for (const m of conesGroup.children) {
    const cone = m.userData.cone;
    if (Math.abs((m.userData.curLen ?? cone.len) - ringDist) < 1e-6) continue;
    m.userData.curLen = ringDist;
    const a = cone.r * Math.PI / 180;
    const geo = new THREE.ConeGeometry(ringDist * Math.tan(a), ringDist, 40, 1, true);
    geo.translate(0, -ringDist / 2, 0);
    geo.rotateX(Math.PI);
    m.geometry.dispose();
    m.geometry = geo;
  }
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
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  };
  function pickPointer(e) {
    raycaster.setFromCamera(ndc(e), camera);
    return raycaster.intersectObject(pointer.hit, false).length > 0;
  }
  window.viasualPickTest = (clientX, clientY) => pickPointer({ clientX, clientY });
  function dragToField(e) {
    raycaster.setFromCamera(ndc(e), camera);
    dragSphere.center.copy(SUN);
    dragSphere.radius = dragRadius;
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectSphere(dragSphere, hit)) {
      raycaster.ray.closestPointToPoint(SUN, hit);
      if (hit.distanceToSquared(SUN) < 1e-9) return;
    }
    const d = hit.sub(SUN).normalize();
    const vIcrs = C.matTVec(D.R_ICRS2GC, [d.x, d.y, d.z]);
    const vSgr = C.matVec(D.M_SGR, vIcrs);
    const [lam, bet] = C.lonlatOf(vSgr);
    setField(lam, bet, { live: true });
  }
  el.addEventListener('pointerdown', (e) => {
    clearTimeout(clickTimer);
    downXY = [e.clientX, e.clientY];
    if (e.button === 0 && pickPointer(e)) {
      dragging = true;
      dragRadius = pointer.userData.len || ARROW_LEN;
      controls.enabled = false;
      try { el.setPointerCapture(e.pointerId); } catch {}
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
      setField(state.lam0, state.bet0);
      return;
    }
    if (downXY && Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]) < 5 && e.button === 0) {
      const p = pickAll(e);
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => { if (p) togglePin(p); }, 260);
    }
    downXY = null;
  });
  el.addEventListener('dblclick', (e) => {
    clearTimeout(clickTimer);
    const p = pickAll(e, { noHalo: true });
    if (p) { dblRecenter(p); return; }
    raycaster.setFromCamera(ndc(e), camera);
    const hits = raycaster.intersectObjects(conesGroup.children.filter(m => m.visible), false);
    if (hits.length) window.dispatchEvent(new CustomEvent('v2-goto-cone', { detail: hits[0].object.userData.cone.key }));
  });
  el.addEventListener('pointerleave', () => setHover(null));

  function pickAll(e, { noHalo = false } = {}) {
    raycaster.setFromCamera(ndc(e), camera);
    const targets = [];
    if (state.streamsOn) targets.push(starPts);
    if (state.gcOn) targets.push(gcPts);
    if (state.dgOn) targets.push(dwfPts);
    if (state.dgOn && state.memOn) targets.push(memPts);
    if (state.dgOn && state.mem2On && mem2Pts) targets.push(mem2Pts);
    if (!noHalo && state.haloOn && tracerPts.halo) targets.push(tracerPts.halo);
    if (state.kgOn && tracerPts.kg) targets.push(tracerPts.kg);
    if (state.bhbOn && tracerPts.bhb) targets.push(tracerPts.bhb);
    if (!noHalo && state.kepOn && tracerPts.kep) targets.push(tracerPts.kep);
    if (viaPts?.visible) targets.push(viaPts);
    const hits = raycaster.intersectObjects(targets, false);
    for (const h of hits) {
      const kind = h.object.userData.kind;
      const i = h.index;
      if (kind === 'star' && starGeom.alphaAttr.array[i] <= 0.01) continue;
      if (kind === 'via' && viaPts.geometry.alphaAttr.array[i] <= 0.01) continue;
      if (kind === 'dwarf' && dwfPts.geometry.alphaAttr.array[i] <= 0.01) continue;
      return { kind, i };
    }
    return null;
  }

  function dblRecenter(p) {
    let lam, bet, lock = null;
    const simple = (cat, name, kind = 'star') => { lam = cat.lam[p.i]; bet = cat.bet[p.i]; lock = { kind, id: p.i, name, dist: cat.dist[p.i] }; };
    if (p.kind === 'star') simple({ lam: D.s_lam, bet: D.s_bet, dist: D.s_dist_use }, D.streamName(p.i));
    else if (p.kind === 'gc') simple(D.GCC, D.GCC.name[p.i], 'gc');
    else if (p.kind === 'dwarf') simple(D.DWF, D.DWF.name[p.i], 'dwarf');
    else if (p.kind === 'member') simple(D.MEM, D.MEM.name[p.i]);
    else if (p.kind === 'member2') simple(D.MEM2, D.MEM2.name[p.i]);
    else if (p.kind === 'halo') simple(D.HALO, 'halo RRL');
    else if (p.kind === 'kg') simple(D.KG, 'K giant');
    else if (p.kind === 'bhb') simple(D.BHB, 'BHB');
    else if (p.kind === 'kep') simple(D.KEP, 'Kepler star');
    else if (p.kind === 'via') { window.dispatchEvent(new CustomEvent('v3-goto-via', { detail: p.i })); return; }
    else return;
    replaceLock(lock);
    slideField(lam, bet, { keepLock: true });
  }

  let hoverTimer = null;
  function hover(e) {
    if (hoverTimer) return;
    hoverTimer = setTimeout(() => { hoverTimer = null; }, 40);
    const p = pickAll(e);
    if (p) { setHover(p, e); return; }
    raycaster.setFromCamera(ndc(e), camera);
    const hits = raycaster.intersectObjects(conesGroup.children.filter(m => m.visible), false);
    if (hits.length) {
      const cone = hits[0].object.userData.cone;
      const tip = document.getElementById('tooltip3d');
      tip.innerHTML = `<b>${cone.name}</b> · ${cone.fov}° survey region<br><span style="opacity:.7">dbl-click to open</span>`;
      tip.style.display = 'block';
      placeTooltip(tip, e);
      document.body.style.cursor = 'pointer';
      return;
    }
    setHover(null, e);
  }
}

function objectHtml(p) {
  const i = p.i;
  if (p.kind === 'star') {
    const known = D.s_dist_known[i] ? '' : ' (geom.)';
    return `<b>${D.streamName(i)}</b>${D.viaMask[i] ? ' · Via core stream' : ''}<br>${D.s_dist_use[i].toFixed(1)} kpc${known}<br>G = ${D.s_G[i].toFixed(2)}`;
  }
  if (p.kind === 'gc') {
    const c = D.GCC;
    let html = `<b>${c.name[i]}</b> · GC<br>${c.dist[i].toFixed(1)} kpc`;
    if (Number.isFinite(c.mass?.[i])) html += `<br>${c.mass[i].toExponential(1)} M☉`;
    return html;
  }
  if (p.kind === 'dwarf') return `<b>${D.DWF.name[i]}</b> · dwarf<br>${D.DWF.dist[i].toFixed(1)} kpc<br><span style="opacity:.7">${D.DWF.src[i]}</span>`;
  if (p.kind === 'member') return `<b>${D.MEM.name[i]}</b> member<br>${D.MEM.dist[i].toFixed(0)} kpc (galaxy)<br>G = ${D.MEM.G[i].toFixed(2)}`;
  if (p.kind === 'member2') return `<b>${D.MEM2.name[i]}</b> member (Geha+26)<br>${D.MEM2.dist[i].toFixed(0)} kpc (galaxy)<br>G ≈ ${Number.isFinite(D.MEM2.G[i]) ? D.MEM2.G[i].toFixed(2) : '—'} (predicted)`;
  if (p.kind === 'halo') return `<b>halo ${D.HALO.clsNames[D.HALO.cls[i]] || 'RRL'}</b><br>${D.HALO.dist[i].toFixed(1)} kpc (±10%)<br>G = ${D.HALO.G[i].toFixed(2)}`;
  if (p.kind === 'kg') return `<b>K giant</b> (Chandra set ${D.KG.set[i]})<br>${D.KG.dist[i].toFixed(1)} kpc (isochrone)<br>G = ${D.KG.G[i].toFixed(2)}`;
  if (p.kind === 'bhb') return `<b>BHB star</b> (Xue+11)<br>${D.BHB.dist[i].toFixed(1)} kpc<br>g = ${D.BHB.G[i].toFixed(2)}`;
  if (p.kind === 'kep') return `<b>Kepler-field star</b><br>${D.KEP.dist[i].toFixed(2)} kpc (1/plx)<br>G = ${D.KEP.G[i].toFixed(2)}`;
  if (p.kind === 'via') {
    const V = D.VIA;
    return `<b>Via ${V.surveys[V.svy[i]]}</b>${V.sub[i] ? ` · ${V.sub[i]}` : ''}<br>${V.name[i] || 'tile ' + V.tile[i]}<br><span style="opacity:.7">direction on the 15 kpc shell · dbl-click to open</span>`;
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
