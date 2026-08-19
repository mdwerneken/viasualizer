// three.js scene: 80k catalog stars as GPU points (positions uploaded once; colour/
// size buffers rewritten in-place on state changes), object catalogs, galactic disk,
// Sun, HI shell, Kepler cone, and a mesh-based field pointer that can be dragged.
// No GL line primitives anywhere (macOS/ANGLE renders them unreliably).
import * as THREE from './vendor/three.module.min.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { D } from './data.js';
import { state, setField, on, galField } from './state.js';
import * as C from './compute.js';
import { UI, scales, streamColor, HEMI_COL, hexToRgb01 } from './colors.js';

let renderer, scene, camera, controls, raycaster;
let starPts, starGeom, colAttr, sizeAttr;
let gcPts, dwfPts, memPts, haloPts = null;
let pointer = {};            // shaft, tip, ring, hitProxy groups
let hiSphere = null, keplerCone = null, disk, sunMesh, gridGroup;
let SUN;
let needsRender = true;
let hoverInfo = null;
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

function makePointsMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: STAR_VS, fragmentShader: STAR_FS,
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
  camera.position.copy(SUN.clone().add(camDir.multiplyScalar(state.zoom * 2.6)));

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
  buildKepler();

  wirePicking(container);
  resize(container);
  new ResizeObserver(() => resize(container)).observe(container);

  on('field', () => { updatePointer(); needsRender = true; });
  on('ui', () => { restyle(); needsRender = true; });
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

// recolour + resize the star cloud from current state — typed-array writes only
export function restyle() {
  const n = D.N;
  const col = colAttr.array, sz = sizeAttr.array, al = starGeom.alphaAttr.array;
  const mode = state.mode, glo = state.glo, ghi = state.ghi;
  const distLo = D.DIST_MIN, distSpan = D.DIST_MAX - D.DIST_MIN;
  const densMax = D.DENS_CMAX;
  const grey = hexToRgb01(UI.greyStar), out = hexToRgb01(UI.outRange);
  const selCode = state.stream ? D.STREAM_NAMES.indexOf(state.stream) : -1;
  const hemiRgb = [hexToRgb01(HEMI_COL[0]), hexToRgb01(HEMI_COL[1]), hexToRgb01(HEMI_COL[2])];
  const palRgb = [];
  for (let c = 0; c < 20; c++) palRgb.push(hexToRgb01(streamColor(c)));

  for (let i = 0; i < n; i++) {
    const g = D.s_G[i];
    const inR = g >= glo && g <= ghi;
    const isVia = D.viaMask[i] === 1;
    const code = D.s_name_code[i];
    const isSel = selCode < 0 || code === selCode;
    let hide = false;
    if (state.via && !isVia) hide = true;
    if (state.isolate && selCode >= 0 && code !== selCode) hide = true;
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
  if (keplerCone) keplerCone.visible = state.kepler;
  updateHiSphere();
  updateChrome();
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
  // subtle box frame around the plotted volume (Sun-centred cube, +-MAXR)
  gridGroup = new THREE.Group();
  const R = D.MAXR;
  const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(UI.grid) });
  const edge = (a, b) => {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    const geo = new THREE.CylinderGeometry(0.06, 0.06, len, 5);
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

function buildKepler() {
  keplerCone = new THREE.Group();
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
    keplerCone.add(m);
  }
  scene.add(keplerCone);
}

// ---- object catalogs (GCs, dwarfs, members) ---------------------------------------
function catPoints(cat, colorHex, sizePx, kind) {
  const n = cat.lam.length;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const sz = new Float32Array(n), al = new Float32Array(n);
  const [r, g, b] = hexToRgb01(colorHex);
  const R = D.MAXR;
  for (let i = 0; i < n; i++) {
    // park objects beyond the box on the box edge along the sightline (v1 behaviour)
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
    sz[i] = s; al[i] = 0.95;
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
  pts.userData.kind = kind;
  scene.add(pts);
  return pts;
}

function buildObjectCatalogs() {
  gcPts = catPoints(D.GCC, UI.gc, 6.5, 'gc');
  dwfPts = catPoints(D.DWF, UI.dwarf, 6.5, 'dwarf');
  memPts = catPoints(D.MEM, UI.member, 2.4, 'member');
}

function restyleObjects() {
  gcPts.visible = state.gcOn;
  dwfPts.visible = state.dgOn;
  memPts.visible = state.memOn;
  if (haloPts) haloPts.visible = state.haloOn;
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
    // texture v: 0 at top = +90 lat; equirect sphere map
    const bb = 90 - (y + 0.5) * 180 / h;
    for (let x = 0; x < w; x++) {
      // sphere u wraps: u=0 at lon 180 going through -180.. standard three.js sphere:
      // u=0.5 -> -z.. we align via mesh rotation; here use l = -180 + x*step
      const ll = -180 + (x + 0.5) * 360 / w;
      const v = C.hiSample(grid, D.HI_NY, D.HI_NX, D.HI_STEP, ll, bb);
      const p = 4 * (y * w + x);
      if (!Number.isFinite(v) || Math.abs(bb) < 15) { img.data[p + 3] = 0; continue; }
      const t = Math.max(0, Math.min(1, (v - v0) / (v1 - v0 || 1)));
      const [r, g, b] = scale.rgb(t);
      img.data[p] = r; img.data[p + 1] = g; img.data[p + 2] = b;
      img.data[p + 3] = 150;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function updateHiSphere() {
  if (!state.hiSphere) {
    if (hiSphere) hiSphere.visible = false;
    return;
  }
  const key = state.himap;
  if (!hiSphere || hiSphere.userData.key !== key) {
    if (hiSphere) { scene.remove(hiSphere); hiSphere.geometry.dispose(); hiSphere.material.map?.dispose(); }
    const geo = new THREE.SphereGeometry(10, 72, 36);
    const mat = new THREE.MeshBasicMaterial({
      map: hiTexture(), transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    hiSphere = new THREE.Mesh(geo, mat);
    hiSphere.userData.key = key;
    // three.js sphere UV: u=0 at +x?? Actually u wraps with atan2(z, x); we need
    // galactic frame: build rotation taking the sphere's native frame to GC frame.
    // Native sphere: lat from +y axis?? — three sphere: y = cos(phi), equator in xz.
    // We remap: galactic z_gal -> +y (poles), l=0 -> ... Compose from RG_GAL2GC.
    const M = D.RG_GAL2GC;
    const m4 = new THREE.Matrix4().set(
      // columns are images of gal x,y,z axes; sphere native: lon around y-up.
      // map sphere axes (x_s, y_s, z_s) so that: y_s -> gal z, x_s -> gal l=180, z_s -> gal l=-90
      M[0][0], M[0][2], M[0][1], 0,
      M[1][0], M[1][2], M[1][1], 0,
      M[2][0], M[2][2], M[2][1], 0,
      0, 0, 0, 1);
    hiSphere.setRotationFromMatrix(m4);
    hiSphere.position.copy(SUN);
    scene.add(hiSphere);
  }
  hiSphere.visible = true;
}

// ---- chrome (clean mode) -----------------------------------------------------------
function updateChrome() {
  const showChrome = !state.clean;
  gridGroup.visible = showChrome;
  renderer.setClearColor(new THREE.Color(state.clean ? '#ffffff' : UI.bg));
}

// ---- field pointer -------------------------------------------------------------------
function fieldDir3() {
  // Sgr (lam,bet) -> ICRS -> galactocentric direction (v1's _field_dir)
  const vIcrs = C.matTVec(D.M_SGR, C.unitVector1(state.lam0, state.bet0));
  const v = C.matVec(D.R_ICRS2GC, vIcrs);
  return new THREE.Vector3(...v).normalize();
}

function pointerTipDist() {
  // distance of nearest Sgr star in field (>=10), like v1's dtip
  const idx = C.fieldIndices(state.lam0, state.bet0, D.UG_SGR, state.fov / 2);
  let best = Infinity;
  for (const i of idx) {
    if (D.streamName(i) !== 'Sagittarius') continue;
    const dx = D.s_X[i] - SUN.x, dy = D.s_Y[i] - SUN.y, dz = D.s_Z[i] - SUN.z;
    const r = Math.hypot(dx, dy, dz);
    if (r < best) best = r;
  }
  if (!Number.isFinite(best)) best = 14;
  return Math.max(best, 12);
}

function buildPointer() {
  const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff4545') });
  const shaftGeo = new THREE.CylinderGeometry(0.26, 0.26, 1, 8);
  shaftGeo.translate(0, 0.5, 0);        // base at origin, extends +y
  pointer.shaft = new THREE.Mesh(shaftGeo, mat);
  const tipGeo = new THREE.ConeGeometry(0.9, 2.6, 12);
  tipGeo.translate(0, 0.8, 0);
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
  const dtip = pointerTipDist();
  const up = new THREE.Vector3(0, 1, 0);
  pointer.shaft.position.copy(SUN);
  pointer.shaft.scale.set(1, dtip * 0.96, 1);
  pointer.shaft.quaternion.setFromUnitVectors(up, dir);
  const tipPos = SUN.clone().add(dir.clone().multiplyScalar(dtip * 0.96));
  pointer.tip.position.copy(tipPos);
  pointer.tip.quaternion.setFromUnitVectors(up, dir);
  const rad = dtip * Math.tan((state.fov / 2) * Math.PI / 180);
  const ringPos = SUN.clone().add(dir.clone().multiplyScalar(dtip));
  pointer.ring.position.copy(ringPos);
  pointer.ring.scale.set(rad, rad, 1);
  pointer.ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  pointer.hit.position.copy(ringPos);
  pointer.hit.scale.setScalar(Math.max(rad * 1.6, dtip * 0.14, 2.5));
  pointer.userData = { dtip };
  needsRender = true;
}

// ---- picking: hover tooltips, click-to-recenter, drag-the-pointer --------------------
function wirePicking(container) {
  const el = renderer.domElement;
  let dragging = false;
  let downXY = null;
  const dragSphere = new THREE.Sphere(new THREE.Vector3(), 1);

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
    dragSphere.radius = pointer.userData.dtip || 25;
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
    downXY = [e.clientX, e.clientY];
    if (e.button === 0 && pickPointer(e)) {
      dragging = true;
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
    // click-to-recenter: only if it wasn't an orbit drag
    if (downXY && Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]) < 5 && e.button === 0) {
      clickRecenter(e);
    }
    downXY = null;
  });
  el.addEventListener('pointerleave', () => setHover(null));

  function pickAll(e) {
    raycaster.setFromCamera(ndc(e), camera);
    const targets = [starPts];
    if (state.gcOn) targets.push(gcPts);
    if (state.dgOn) targets.push(dwfPts);
    if (state.memOn) targets.push(memPts);
    const hits = raycaster.intersectObjects(targets, false);
    for (const h of hits) {
      const kind = h.object.userData.kind;
      const i = h.index;
      if (kind === 'star') {
        if (starGeom.alphaAttr.array[i] <= 0.01) continue;
        return { kind, i };
      }
      if (kind === 'gc' && !state.gcOn) continue;
      return { kind, i };
    }
    return null;
  }

  let hoverTimer = null;
  function hover(e) {
    if (hoverTimer) return;
    hoverTimer = setTimeout(() => { hoverTimer = null; }, 40);
    setHover(pickAll(e), e);
  }

  function clickRecenter(e) {
    const p = pickAll(e);
    if (!p) return;
    if (p.kind === 'star') setField(D.s_lam[p.i], D.s_bet[p.i]);
    else if (p.kind === 'gc') setField(D.GCC.lam[p.i], D.GCC.bet[p.i]);
    else if (p.kind === 'dwarf') setField(D.DWF.lam[p.i], D.DWF.bet[p.i]);
    else if (p.kind === 'member') setField(D.MEM.lam[p.i], D.MEM.bet[p.i]);
  }
}

function setHover(p, e) {
  const tip = document.getElementById('tooltip3d');
  if (!p) { tip.style.display = 'none'; document.body.style.cursor = ''; return; }
  let html = '';
  if (p.kind === 'star') {
    const known = D.s_dist_known[p.i] ? '' : ' (geom.)';
    html = `<b>${D.streamName(p.i)}</b><br>${D.s_dist_use[p.i].toFixed(1)} kpc${known}<br>G = ${D.s_G[p.i].toFixed(2)}`;
  } else if (p.kind === 'gc') {
    const c = D.GCC;
    html = `<b>${c.name[p.i]}</b> · GC<br>${c.dist[p.i].toFixed(1)} kpc`;
    if (Number.isFinite(c.mass?.[p.i])) html += `<br>${c.mass[p.i].toExponential(1)} M☉`;
  } else if (p.kind === 'dwarf') {
    const c = D.DWF;
    html = `<b>${c.name[p.i]}</b> · dwarf<br>${c.dist[p.i].toFixed(1)} kpc`;
  } else if (p.kind === 'member') {
    const c = D.MEM;
    html = `<b>${c.name[p.i]}</b> member<br>${c.dist[p.i].toFixed(0)} kpc (galaxy)<br>G = ${c.G[p.i].toFixed(2)}`;
  }
  tip.innerHTML = html;
  tip.style.display = 'block';
  tip.style.left = (e.clientX + 14) + 'px';
  tip.style.top = (e.clientY + 10) + 'px';
  document.body.style.cursor = 'pointer';
}

export function setZoomDistance(halfBox) {
  const dir = camera.position.clone().sub(controls.target).normalize();
  camera.position.copy(controls.target.clone().add(dir.multiplyScalar(halfBox * 2.6)));
  needsRender = true;
}

export function requestRender() { needsRender = true; }
