// Incremental SHA-256: bounded storage for streamed downloads and resumed prefixes.
// FIPS 180-4 compression with big-endian message words and length padding.
globalThis.StreamingSHA256 = class {
  constructor() {
    this.state = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    this.block = new Uint8Array(64); this.words = new Int32Array(64);
    this.used = 0; this.length = 0;
  }
  compress(bytes, offset) { this.blocks(bytes, offset, offset + 64); }
  // load5: all whole blocks of [offset, end) in one call, state in locals (no per-block typed-array destructuring or
  // state load/store): ~2-3x the old per-block compress in V8, same FIPS 180-4 result (checked against node:crypto).
  blocks(bytes, offset, end) {
    const k = this.constructor.k32, w = this.words, s = this.state;
    let h0 = s[0] | 0, h1 = s[1] | 0, h2 = s[2] | 0, h3 = s[3] | 0, h4 = s[4] | 0, h5 = s[5] | 0, h6 = s[6] | 0, h7 = s[7] | 0;
    for (let p = offset; p < end; p += 64) {
      for (let i = 0, q = p; i < 16; i++, q += 4) w[i] = (bytes[q] << 24) | (bytes[q+1] << 16) | (bytes[q+2] << 8) | bytes[q+3];
      for (let i = 16; i < 64; i++) {
        const x = w[i-15], y = w[i-2];
        const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const t1 = (h + S1 + ((e & f) ^ (~e & g)) + k[i] + w[i]) | 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }
    s[0] = h0; s[1] = h1; s[2] = h2; s[3] = h3; s[4] = h4; s[5] = h5; s[6] = h6; s[7] = h7;
  }
  update(bytes) {
    this.length += bytes.length;
    let offset = 0;
    if (this.used) {
      const count = Math.min(64-this.used,bytes.length);
      this.block.set(bytes.subarray(0,count),this.used); this.used += count; offset += count;
      if (this.used === 64) { this.compress(this.block,0); this.used=0; }
    }
    const whole = offset + ((bytes.length - offset) & ~63);
    if (whole > offset) { this.blocks(bytes,offset,whole); offset = whole; }
    if (offset < bytes.length) { this.block.set(bytes.subarray(offset),0); this.used=bytes.length-offset; }
    return this;
  }
  hex() {
    const length = this.length;
    this.block[this.used++] = 0x80;
    if (this.used > 56) { this.block.fill(0,this.used); this.compress(this.block,0); this.used=0; }
    this.block.fill(0,this.used,56);
    const view = new DataView(this.block.buffer);
    view.setUint32(56,Math.floor(length/0x20000000)); view.setUint32(60,(length*8)>>>0);
    this.compress(this.block,0);
    return Array.from(this.state,x=>x.toString(16).padStart(8,'0')).join('');
  }
  static k = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  static k32 = new Int32Array(this.k.buffer);
};
