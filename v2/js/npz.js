// Minimal reader for numpy .npz archives (zip of .npy, stored or deflate entries).
// Reads the same files v1's Pyodide/numpy loads, so the two apps share inputs byte-for-byte.

const DTYPES = {
  '<f4': Float32Array, '<f8': Float64Array,
  '<i1': Int8Array, '|i1': Int8Array, '<i2': Int16Array, '<i4': Int32Array,
  '|u1': Uint8Array, '<u1': Uint8Array, '<u2': Uint16Array, '<u4': Uint32Array,
};

function parseNpy(buf) {
  const dv = new DataView(buf);
  const u8m = new Uint8Array(buf, 0, 6);
  if (u8m[0] !== 0x93 || String.fromCharCode(...u8m.subarray(1, 6)) !== 'NUMPY') {
    throw new Error('not an npy file');
  }
  const major = dv.getUint8(6);
  const headerLen = major >= 2 ? dv.getUint32(8, true) : dv.getUint16(8, true);
  const headerStart = major >= 2 ? 12 : 10;
  const header = new TextDecoder().decode(new Uint8Array(buf, headerStart, headerLen));
  const descr = /'descr':\s*'([^']+)'/.exec(header)[1];
  const shape = (/'shape':\s*\(([^)]*)\)/.exec(header)[1].match(/\d+/g) || []).map(Number);
  const dataStart = headerStart + headerLen;
  if (descr.startsWith('<U') || descr.startsWith('|S')) {
    const w = parseInt(descr.slice(2), 10);
    const n = shape.length ? shape[0] : 1;
    const out = [];
    if (descr.startsWith('<U')) {
      const u32 = new Uint32Array(buf.slice(dataStart, dataStart + n * w * 4));
      for (let i = 0; i < n; i++) {
        let s = '';
        for (let j = 0; j < w; j++) { const c = u32[i * w + j]; if (c) s += String.fromCodePoint(c); }
        out.push(s);
      }
    } else {
      const u8 = new Uint8Array(buf, dataStart, n * w);
      const td = new TextDecoder();
      for (let i = 0; i < n; i++) out.push(td.decode(u8.subarray(i * w, (i + 1) * w)).replace(/\0+$/, ''));
    }
    return { data: out, shape, descr };
  }
  const T = DTYPES[descr];
  if (!T) throw new Error('unsupported dtype ' + descr);
  const n = shape.reduce((a, b) => a * b, 1) || 1;
  const bytes = buf.slice(dataStart, dataStart + n * T.BYTES_PER_ELEMENT);
  return { data: new T(bytes), shape, descr };
}

async function inflateRaw(u8) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([u8]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function loadNpz(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch ${url}: ${resp.status}`);
  const buf = await resp.arrayBuffer();
  const dv = new DataView(buf);
  // find End Of Central Directory (no zip comment in numpy output, but scan anyway)
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 65536); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip EOCD not found in ' + url);
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const out = {};
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('bad central directory');
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const cmtLen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(buf, off + 46, nameLen));
    // local header: variable name/extra lengths of its own
    const lNameLen = dv.getUint16(lho + 26, true);
    const lExtraLen = dv.getUint16(lho + 28, true);
    const dataOff = lho + 30 + lNameLen + lExtraLen;
    let raw = new Uint8Array(buf, dataOff, csize);
    if (method === 8) raw = await inflateRaw(raw);
    else if (method !== 0) throw new Error('unsupported zip method ' + method);
    const key = name.replace(/\.npy$/, '');
    // copy into an aligned standalone buffer
    const aligned = raw.byteOffset === 0 && raw.buffer.byteLength === raw.byteLength
      ? raw.buffer : raw.slice().buffer;
    out[key] = parseNpy(aligned);
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}
