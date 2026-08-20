// Math core — direct port of viasual/py/core.py's numpy analysis to typed arrays.
// Formulas are kept identical so v2 reproduces v1/notebook numbers exactly.

const D2R = Math.PI / 180, R2D = 180 / Math.PI;

export function wrap180(x) { return ((x + 180) % 360 + 360) % 360 - 180; }

// unit vectors for arrays of lon/lat [deg] -> flat Float32Array [x0,y0,z0, x1,...]
// Mimics v1's numpy float32 pipeline (radians/cos/sin/multiply all rounded to f4)
// so field-membership decisions at the FOV boundary agree with v1 star-for-star.
const D2R_F = Math.fround(D2R);
const fr = Math.fround;
export function unitVectors(lon, lat) {
  const n = lon.length, out = new Float32Array(n * 3);
  const f32in = lon instanceof Float32Array;
  for (let i = 0; i < n; i++) {
    let lr, br;
    if (f32in) { lr = fr(fr(lon[i]) * D2R_F); br = fr(fr(lat[i]) * D2R_F); }
    else { lr = lon[i] * D2R; br = lat[i] * D2R; }
    const cb = f32in ? fr(Math.cos(br)) : Math.cos(br);
    out[3 * i] = f32in ? fr(cb * fr(Math.cos(lr))) : cb * Math.cos(lr);
    out[3 * i + 1] = f32in ? fr(cb * fr(Math.sin(lr))) : cb * Math.sin(lr);
    out[3 * i + 2] = f32in ? fr(Math.sin(br)) : Math.sin(br);
  }
  return out;
}

export function unitVector1(lon, lat) {
  const lr = lon * D2R, br = lat * D2R, cb = Math.cos(br);
  return [cb * Math.cos(lr), cb * Math.sin(lr), Math.sin(br)];
}

export function lonlatOf(v) {
  return [
    wrap180(Math.atan2(v[1], v[0]) * R2D),
    Math.asin(Math.max(-1, Math.min(1, v[2]))) * R2D,
  ];
}

// 3x3 matrix ops (matrices stored as [[..],[..],[..]] from meta.json)
export function matVec(M, v) {
  return [
    M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
    M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
    M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
  ];
}
export function matTVec(M, v) {
  return [
    M[0][0] * v[0] + M[1][0] * v[1] + M[2][0] * v[2],
    M[0][1] * v[0] + M[1][1] * v[1] + M[2][1] * v[2],
    M[0][2] * v[0] + M[1][2] * v[1] + M[2][2] * v[2],
  ];
}

// frame A (lon,lat) -> frame B: v_icrs = M_from^T v ; v_B = M_to v_icrs
export function convPoint(Mfrom, Mto, lon, lat) {
  return lonlatOf(matVec(Mto, matTVec(Mfrom, unitVector1(lon, lat))));
}

// vectorized frame conversion for arrays -> [lonArr, latArr]
export function convArr(Mfrom, Mto, lon, lat) {
  const n = lon.length, lo = new Float64Array(n), la = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const [a, b] = convPoint(Mfrom, Mto, lon[i], lat[i]);
    lo[i] = a; la[i] = b;
  }
  return [lo, la];
}

// indices within `radius` deg of (lon0,lat0), given flat unit-vector array UG.
// Same comparison as v1: degrees(arccos(clip(dot))) <= radius, dot in float64.
export function fieldIndices(lon0, lat0, UG, radius) {
  const [ux, uy, uz] = unitVector1(lon0, lat0);
  const n = UG.length / 3, out = [];
  for (let i = 0; i < n; i++) {
    const dot = UG[3 * i] * ux + UG[3 * i + 1] * uy + UG[3 * i + 2] * uz;
    const sep = Math.acos(Math.max(-1, Math.min(1, dot))) * R2D;
    if (sep <= radius) out.push(i);
  }
  return out;
}

// gnomonic projection of (lon,lat) about (lon0,lat0) -> arcmin offsets [xi, eta]
export function gnomonic(lon, lat, lon0, lat0) {
  const n = lon.length, xi = new Float64Array(n), eta = new Float64Array(n);
  const b0 = lat0 * D2R, l0 = lon0 * D2R, sb0 = Math.sin(b0), cb0 = Math.cos(b0);
  for (let i = 0; i < n; i++) {
    const br = lat[i] * D2R, dl = lon[i] * D2R - l0;
    const sb = Math.sin(br), cb = Math.cos(br), cdl = Math.cos(dl);
    const cosc = sb0 * sb + cb0 * cb * cdl;
    xi[i] = (cb * Math.sin(dl) / cosc) * R2D * 60;
    eta[i] = ((cb0 * sb - sb0 * cb * cdl) / cosc) * R2D * 60;
  }
  return [xi, eta];
}

export function gnomonicInv(xiAm, etaAm, lon0, lat0) {
  const xi = (xiAm / 60) * D2R, eta = (etaAm / 60) * D2R;
  const rho = Math.hypot(xi, eta);
  if (rho === 0) return [lon0, lat0];
  const c = Math.atan(rho), b0 = lat0 * D2R;
  const lat = Math.asin(Math.max(-1, Math.min(1,
    Math.cos(c) * Math.sin(b0) + eta * Math.sin(c) * Math.cos(b0) / rho))) * R2D;
  const lon = lon0 + Math.atan2(xi * Math.sin(c),
    rho * Math.cos(b0) * Math.cos(c) - eta * Math.sin(b0) * Math.sin(c)) * R2D;
  return [lon, lat];
}

// nearest neighbour by brute force over a subset's unit vectors.
// uv: flat Float64Array; returns {nn: Int32Array, sepAm: Float64Array} or null
export function nearestNeighbors(uv) {
  const n = uv.length / 3;
  if (n < 2) return null;
  const nn = new Int32Array(n), sep = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let best = -2, bj = -1;
    const x = uv[3 * i], y = uv[3 * i + 1], z = uv[3 * i + 2];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const d = x * uv[3 * j] + y * uv[3 * j + 1] + z * uv[3 * j + 2];
      if (d > best) { best = d; bj = j; }
    }
    nn[i] = bj;
    const chord = Math.sqrt(Math.max(0, 2 - 2 * best)) / 2;
    sep[i] = 2 * Math.asin(Math.min(1, chord)) * R2D * 60;
  }
  return { nn, sepAm: sep };
}

// Grid-accelerated nearest neighbour in the gnomonic plane (for large fields).
// xi/eta in arcmin about the field center; exact for the small angles involved.
export function nearestNeighborsGrid(xi, eta) {
  const n = xi.length;
  if (n < 2) return null;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    if (xi[i] < x0) x0 = xi[i]; if (xi[i] > x1) x1 = xi[i];
    if (eta[i] < y0) y0 = eta[i]; if (eta[i] > y1) y1 = eta[i];
  }
  const span = Math.max(x1 - x0, y1 - y0) || 1;
  const ncell = Math.max(4, Math.min(160, Math.floor(Math.sqrt(n / 2))));
  const cs = span / ncell;
  const gx = i => Math.min(ncell - 1, Math.max(0, Math.floor((xi[i] - x0) / cs)));
  const gy = i => Math.min(ncell - 1, Math.max(0, Math.floor((eta[i] - y0) / cs)));
  const cells = new Map();
  for (let i = 0; i < n; i++) {
    const key = gx(i) * ncell + gy(i);
    let arr = cells.get(key);
    if (!arr) { arr = []; cells.set(key, arr); }
    arr.push(i);
  }
  const nn = new Int32Array(n), sep = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const cx = gx(i), cy = gy(i);
    let best = Infinity, bj = -1;
    for (let ring = 0; ring < ncell; ring++) {
      for (let ax = cx - ring; ax <= cx + ring; ax++) {
        if (ax < 0 || ax >= ncell) continue;
        for (let ay = cy - ring; ay <= cy + ring; ay++) {
          if (ay < 0 || ay >= ncell) continue;
          if (Math.max(Math.abs(ax - cx), Math.abs(ay - cy)) !== ring) continue;
          const arr = cells.get(ax * ncell + ay);
          if (!arr) continue;
          for (const j of arr) {
            if (j === i) continue;
            const d = Math.hypot(xi[i] - xi[j], eta[i] - eta[j]);
            if (d < best) { best = d; bj = j; }
          }
        }
      }
      // done when the ring boundary is farther than the best match
      if (bj >= 0 && best <= ring * cs) break;
    }
    nn[i] = bj; sep[i] = best;
  }
  return { nn, sepAm: sep };
}

export function angSepAm(lam1, bet1, lam2, bet2) {
  const a = unitVector1(lam1, bet1), b = unitVector1(lam2, bet2);
  const d = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return Math.acos(d) * R2D * 60;
}

// visibility: transit altitude above ALT_MIN, declination-only rule
export function visibleFrom(siteLat, dec, altMin) {
  return (90 - Math.abs(siteLat - dec)) > altMin;
}

// sample a plate-carree grid (rows = b from -90, cols = l from -180, step deg) at (l, b)
export function hiSample(grid, ny, nx, step, l, b) {
  let li = Math.round((wrap180(l) + 180) / step);
  let bi = Math.round((b + 90) / step);
  if (li < 0) li = 0; else if (li > nx - 1) li = nx - 1;
  if (bi < 0) bi = 0; else if (bi > ny - 1) bi = ny - 1;
  return grid[bi * nx + li];
}

// mean/peak of a linear grid inside a spherical cap; gridUG built lazily by caller
export function hiStatsInField(linGrid, gridL, gridB, ny, nx, l0, b0, radius) {
  const [ux, uy, uz] = unitVector1(l0, b0);
  const cosr = Math.cos(radius * D2R);
  let sum = 0, cnt = 0, peak = -Infinity;
  // grid cells: iterate only the lat band that can intersect the cap
  const bLo = Math.max(0, Math.floor((b0 - radius + 90) / (gridB[1] - gridB[0])));
  const bHi = Math.min(ny - 1, Math.ceil((b0 + radius + 90) / (gridB[1] - gridB[0])));
  for (let bi = bLo; bi <= bHi; bi++) {
    const br = gridB[bi] * D2R, cb = Math.cos(br), sb = Math.sin(br);
    for (let li = 0; li < nx; li++) {
      const lr = gridL[li] * D2R;
      const dot = cb * Math.cos(lr) * ux + cb * Math.sin(lr) * uy + sb * uz;
      if (dot < cosr) continue;
      const v = linGrid[bi * nx + li];
      if (!Number.isFinite(v)) continue;
      sum += v; cnt++;
      if (v > peak) peak = v;
    }
  }
  if (!cnt) return null;
  return { peak, mean: sum / cnt };
}

// ---- Mollweide (same -l flip + Newton iteration as core.py) --------------------
export const SQ2 = Math.SQRT2;

export function mollTheta(phi) {
  let th = phi;
  for (let k = 0; k < 7; k++) {
    const f = 2 * th + Math.sin(2 * th) - Math.PI * Math.sin(phi);
    const df = 2 + 2 * Math.cos(2 * th);
    th -= df > 1e-9 ? f / df : 0;
  }
  if (Math.abs(phi) >= Math.PI / 2 - 1e-9) return Math.sign(phi) * Math.PI / 2;
  return th;
}

export function mollXY(lDeg, bDeg) {
  const lam = -wrap180(lDeg) * D2R, phi = bDeg * D2R;
  const th = mollTheta(phi);
  return [(2 * SQ2 / Math.PI) * lam * Math.cos(th), SQ2 * Math.sin(th)];
}

export function mollInvert(x, y) {
  const sth = Math.max(-1, Math.min(1, y / SQ2));
  const th = Math.asin(sth);
  const phi = Math.asin(Math.max(-1, Math.min(1, (2 * th + Math.sin(2 * th)) / Math.PI)));
  const denom = 2 * SQ2 * Math.cos(th);
  if (Math.abs(denom) < 1e-9) return null;
  const lam = Math.PI * x / denom;
  if (Math.abs(lam) > Math.PI) return null;
  return [wrap180(-lam * R2D), phi * R2D];
}

// small circle of angular radius `radiusDeg` around (lg0,bg0) -> [lArr, bArr]
export function skyCircleLB(lg0, bg0, radiusDeg, n = 180) {
  const c = unitVector1(lg0, bg0);
  const [u, w] = perpBasis(c);
  const r = radiusDeg * D2R, cr = Math.cos(r), sr = Math.sin(r);
  const lArr = new Float64Array(n), bArr = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = 2 * Math.PI * i / (n - 1), ct = Math.cos(t), st = Math.sin(t);
    const d = [
      cr * c[0] + sr * (ct * u[0] + st * w[0]),
      cr * c[1] + sr * (ct * u[1] + st * w[1]),
      cr * c[2] + sr * (ct * u[2] + st * w[2]),
    ];
    lArr[i] = Math.atan2(d[1], d[0]) * R2D;
    bArr[i] = Math.asin(Math.max(-1, Math.min(1, d[2]))) * R2D;
  }
  return [lArr, bArr];
}

export function perpBasis(v) {
  const n = Math.hypot(v[0], v[1], v[2]);
  const vv = [v[0] / n, v[1] / n, v[2] / n];
  const t = Math.abs(vv[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let u = [vv[1] * t[2] - vv[2] * t[1], vv[2] * t[0] - vv[0] * t[2], vv[0] * t[1] - vv[1] * t[0]];
  const un = Math.hypot(u[0], u[1], u[2]);
  u = [u[0] / un, u[1] / un, u[2] / un];
  const w = [vv[1] * u[2] - vv[2] * u[1], vv[2] * u[0] - vv[0] * u[2], vv[0] * u[1] - vv[1] * u[0]];
  return [u, w];
}

// histogram helper: values -> {edges, counts} with nb bins over [lo,hi]
export function histogram(values, nb, lo, hi) {
  const counts = new Int32Array(nb);
  const w = (hi - lo) / nb;
  if (w <= 0) return { lo, hi, counts, w: 1 };
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    let k = Math.floor((v - lo) / w);
    if (k === nb && v === hi) k = nb - 1;
    if (k >= 0 && k < nb) counts[k]++;
  }
  return { lo, hi, counts, w };
}

export function arrMax(a) { let m = -Infinity; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; }
export function arrMin(a) { let m = Infinity; for (let i = 0; i < a.length; i++) if (a[i] < m) m = a[i]; return m; }

export function finiteMinMax(values) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo <= hi ? [lo, hi] : null;
}

export function quantileSorted(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function nanPercentiles(arr, qs) {
  const fin = [];
  for (let i = 0; i < arr.length; i++) if (Number.isFinite(arr[i])) fin.push(arr[i]);
  fin.sort((a, b) => a - b);
  return qs.map(q => quantileSorted(fin, q / 100));
}

export function median(values) {
  const fin = [];
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) fin.push(values[i]);
  fin.sort((a, b) => a - b);
  return quantileSorted(fin, 0.5);
}
