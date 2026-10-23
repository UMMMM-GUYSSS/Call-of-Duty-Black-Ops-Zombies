// DXS: lossless DXT stream split for stored IWD zips (size2 lane). Shared by the download worker (inverse)
// and tools/web/mksizepack.mjs (forward). A byte permutation plus a region table:
//   'DXS1' u32 origLen, u32 n, n x (u32 off, u32 len, u32 fmt), rest (all bytes outside regions, in order),
//   then streams 0..6 (concatenated over every region of the file, in file order).
// Region = the mip data (after the 48-byte v13 header) of a stored .iwi entry in format DXT1/3/5/DXN.
// Streams: 0 colour endpoints, 1 colour indices, 2 alpha endpoints, 3 alpha indices, 4 DXT3 alpha,
// 5/6 DXN second-channel endpoints/indices. Brotli then sees homogeneous data (smaller wire).
export const FIELDS = {
  11: [[0, 0, 4], [1, 4, 4]],
  12: [[4, 0, 8], [0, 8, 4], [1, 12, 4]],
  13: [[2, 0, 2], [3, 2, 6], [0, 8, 4], [1, 12, 4]],
  14: [[2, 0, 2], [3, 2, 6], [5, 8, 2], [6, 10, 6]],
};
const NSTREAM = 7, MAGIC = 0x31535844;
const blockSize = f => f.reduce((s, x) => s + x[2], 0);

export function dxsRegions(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let e = b.length - 22; while (e > 0 && dv.getUint32(e, true) !== 0x06054b50) --e;
  if (e <= 0) return [];
  const n = dv.getUint16(e + 10, true), regs = []; let o = dv.getUint32(e + 16, true);
  for (let i = 0; i < n; ++i) {
    const nl = dv.getUint16(o + 28, true), xl = dv.getUint16(o + 30, true), cl = dv.getUint16(o + 32, true);
    const method = dv.getUint16(o + 10, true), cs = dv.getUint32(o + 20, true), us = dv.getUint32(o + 24, true);
    const lo = dv.getUint32(o + 42, true);
    let name = ''; for (let k = Math.max(0, nl - 4); k < nl; ++k) name += String.fromCharCode(b[o + 46 + k] | 0x20);
    o += 46 + nl + xl + cl;
    if (method !== 0 || cs !== us || name !== '.iwi' || cs <= 48) continue;
    const d = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
    if (b[d] !== 0x49 || b[d + 1] !== 0x57 || b[d + 2] !== 0x69 || b[d + 3] !== 13) continue;
    const f = FIELDS[b[d + 4]]; if (!f || (cs - 48) % blockSize(f)) continue;
    regs.push([d + 48, cs - 48, b[d + 4]]);
  }
  regs.sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < regs.length; ++i) if (regs[i][0] < regs[i - 1][0] + regs[i - 1][1]) throw new Error('DXS overlap');
  return regs;
}

function layout(regs, origLen, head) {
  const ss = new Array(NSTREAM).fill(0); let regBytes = 0;
  for (const [, l, f] of regs) { const fl = FIELDS[f], nb = l / blockSize(fl); for (const [s, , len] of fl) ss[s] += nb * len; regBytes += l; }
  const so = []; let p = head + origLen - regBytes; for (let s = 0; s < NSTREAM; ++s) { so[s] = p; p += ss[s]; }
  return so;
}

// Copies each region's fields between the original (orig) and the stream area (t); fwd: orig -> t.
function shuffle(orig, t, regs, so, head, fwd) {
  let rp = head, cur = 0;
  for (const [o, l, f] of regs) {
    if (fwd) t.set(orig.subarray(cur, o), rp); else orig.set(t.subarray(rp, rp + o - cur), cur);
    rp += o - cur;
    const fl = FIELDS[f], bs = blockSize(fl), e = o + l;
    for (const [s, fo, len] of fl) {
      let w = so[s];
      if (fwd) for (let q = o + fo; q < e; q += bs) { for (let k = 0; k < len; ++k) t[w + k] = orig[q + k]; w += len; }
      else for (let q = o + fo; q < e; q += bs) { for (let k = 0; k < len; ++k) orig[q + k] = t[w + k]; w += len; }
      so[s] = w;
    }
    cur = e;
  }
  if (fwd) t.set(orig.subarray(cur), rp); else orig.set(t.subarray(rp, rp + orig.length - cur), cur);
}

export function dxsForward(b) {
  const regs = dxsRegions(b), head = 12 + 12 * regs.length;
  const t = new Uint8Array(head + b.length), tv = new DataView(t.buffer);
  tv.setUint32(0, MAGIC, true); tv.setUint32(4, b.length, true); tv.setUint32(8, regs.length, true);
  regs.forEach(([o, l, f], i) => { tv.setUint32(12 + 12 * i, o, true); tv.setUint32(16 + 12 * i, l, true); tv.setUint32(20 + 12 * i, f, true); });
  shuffle(b, t, regs, layout(regs, b.length, head), head, true);
  return { t, regions: regs.length };
}

export function dxsInverse(t, expectLen) {
  const tv = new DataView(t.buffer, t.byteOffset, t.byteLength);
  if (tv.getUint32(0, true) !== MAGIC) throw new Error('DXS magic');
  const origLen = tv.getUint32(4, true), n = tv.getUint32(8, true), head = 12 + 12 * n;
  if (expectLen !== undefined && origLen !== expectLen) throw new Error('DXS length');
  if (head + origLen !== t.length) throw new Error('DXS size');
  const regs = [];
  for (let i = 0; i < n; ++i) {
    const r = [tv.getUint32(12 + 12 * i, true), tv.getUint32(16 + 12 * i, true), tv.getUint32(20 + 12 * i, true)];
    const f = FIELDS[r[2]];
    if (!f || r[1] % blockSize(f) || r[0] + r[1] > origLen || (i && r[0] < regs[i - 1][0] + regs[i - 1][1])) throw new Error('DXS region');
    regs.push(r);
  }
  const orig = new Uint8Array(origLen);
  shuffle(orig, t.subarray(0), regs, layout(regs, origLen, head), head, false);
  return orig;
}
