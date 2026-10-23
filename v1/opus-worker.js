// size2 t3: decodes one Opus clip (KOP1 record from tools/web/mkopuspack.mjs) per message with WebCodecs AudioDecoder,
// resamples 48 kHz -> the clip's original rate (Catmull-Rom) to exactly its original frame count, and returns the PCM16
// RIFF WAV (44-byte header) plus its SHA-256 for the rebuilt KSPK index. Spawned 4x by download-worker.js.
self.onmessage = async ({ data: job }) => {
  try {
    const head = new Uint8Array(19), v = new DataView(head.buffer);
    head.set([79, 112, 117, 115, 72, 101, 97, 100, 1, job.ch]); v.setUint16(10, job.pre, true); v.setUint32(12, 48000, true);
    const planes = Array.from({ length: job.ch }, () => new Float32Array(job.sf)); let got = 0, failure = null;
    const decoder = new AudioDecoder({
      output: audio => {
        const n = Math.min(audio.numberOfFrames, job.sf - got);
        for (let c = 0; c < job.ch && n > 0; ++c) audio.copyTo(planes[c].subarray(got, got + n), { planeIndex: c, format: 'f32-planar', frameCount: n });
        got += Math.max(n, 0); audio.close();
      },
      error: e => { failure = e; },
    });
    decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: job.ch, description: head });
    const bytes = new Uint8Array(job.data); let at = job.hn ?? 0, ts = 0;
    for (const len of job.lens) {
      decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: ts, data: bytes.subarray(at, at + len) }));
      at += len; ts += 20000;
    }
    await decoder.flush(); decoder.close();
    if (failure) throw failure;
    // Decoders that honour OpusHead pre-skip return sf - pre frames; others return sf (skip pre here).
    const skip = got >= job.sf ? job.pre : 0, valid = Math.max(0, Math.min(got - skip, job.g - job.pre));
    const step = 48000 / job.rate, frames = job.frames, out = new Int16Array(frames * job.ch);
    for (let c = 0; c < job.ch; ++c) {
      const x = planes[c], last = skip + valid - 1, s = k => x[Math.min(Math.max(k, skip), last)] ?? 0;
      for (let i = 0; i < frames; ++i) {
        const t = skip + i * step, k = Math.floor(t), f = t - k;
        let y;
        if (f === 0) y = s(k);
        else { const p0 = s(k - 1), p1 = s(k), p2 = s(k + 1), p3 = s(k + 2);
          y = p1 + 0.5 * f * (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0))); }
        if (k > last) y = 0;
        out[i * job.ch + c] = Math.round(Math.max(-1, Math.min(1, y)) * 32767);
      }
    }
    if (job.ab != null) { // size3 zip mode: MS-ADPCM entry (stream header + blocks + tail) and its zip CRC32
      const entry = new Uint8Array(job.hn + job.ab + job.tn), body = at;
      entry.set(bytes.subarray(0, job.hn)); entry.set(bytes.subarray(body, body + job.tn), job.hn + job.ab);
      adpcmEncode(out, job.ch, job.ab / (262 * job.ch), entry, job.hn);
      self.postMessage({ id: job.id, wav: entry.buffer, crc: crc32(entry), decoded: got }, [entry.buffer]);
      return;
    }
    const wav = new Uint8Array(44 + out.byteLength), w = new DataView(wav.buffer), tag = (o, t) => [...t].forEach((ch, j) => wav[o + j] = ch.charCodeAt(0));
    tag(0, 'RIFF'); w.setUint32(4, wav.length - 8, true); tag(8, 'WAVEfmt '); w.setUint32(16, 16, true); w.setUint16(20, 1, true);
    w.setUint16(22, job.ch, true); w.setUint32(24, job.rate, true); w.setUint32(28, job.rate * job.ch * 2, true);
    w.setUint16(32, job.ch * 2, true); w.setUint16(34, 16, true); tag(36, 'data'); w.setUint32(40, out.byteLength, true);
    wav.set(new Uint8Array(out.buffer), 44);
    const sha = await crypto.subtle.digest('SHA-256', wav);
    self.postMessage({ id: job.id, wav: wav.buffer, sha, decoded: got }, [wav.buffer, sha]);
  } catch (error) {
    self.postMessage({ id: job.id, error: String(error?.message ?? error) });
  }
};

// size3: MS-ADPCM encoder matching src/web/snd/software_mixer.cpp DecodeAdpcm (512 frames per 262*ch-byte block, the
// standard 7 coefficient pairs). Per block and channel: predictor with the least residual, delta from its mean residual.
const COEF = [[256, 0], [512, -256], [0, 0], [192, 64], [240, 0], [460, -208], [392, -232]];
const ADAPT = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230];
function adpcmEncode(pcm, ch, blocks, dst, base) {
  const frames = pcm.length / ch, S = (i, c) => (i < frames ? pcm[i * ch + c] : 0), dv = new DataView(dst.buffer);
  // Encodes 510 frames of channel c after the two header samples; returns the squared error (writes nibbles if o >= 0).
  const trial = (f0, c, j, d0, o) => {
    let s2 = S(f0, c), s1 = S(f0 + 1, c), dl = d0, e2 = 0; const c0 = COEF[j][0], c1 = COEF[j][1];
    for (let t = 0; t < 510; ++t) {
      const x = S(f0 + 2 + t, c), pr = Math.trunc((s1 * c0 + s2 * c1) / 256), err = x - pr;
      let n = err >= 0 ? Math.floor(err / dl + 0.5) : -Math.floor(-err / dl + 0.5); n = n < -8 ? -8 : n > 7 ? 7 : n;
      let y = pr + n * dl; y = y < -32768 ? -32768 : y > 32767 ? 32767 : y; e2 += (x - y) * (x - y);
      s2 = s1; s1 = y; const nib = n & 15; dl = Math.max(16, Math.floor(dl * ADAPT[nib] / 256));
      if (o >= 0) { const i = t * ch + c, at = o + ch * 7 + (i >> 1); dst[at] = (i & 1) ? (dst[at] | nib) : nib << 4; }
    }
    return e2;
  };
  for (let k = 0; k < blocks; ++k) {
    const f0 = k * 512, o = base + k * 262 * ch;
    for (let c = 0; c < ch; ++c) {
      // Rank predictors by open-loop residual; trial-encode the best 3 with 2 start deltas each, keep the least error.
      const rank = COEF.map(([a, b], j) => { let e = 0; for (let i = 2; i < 512; i += 2) e += Math.abs(S(f0 + i, c) - (S(f0 + i - 1, c) * a + S(f0 + i - 2, c) * b) / 256); return [e, j]; }).sort((x, y) => x[0] - y[0]);
      let best = null;
      for (const [e, j] of rank.slice(0, 3)) for (const div of [2, 4]) {
        const d0 = Math.min(65535, Math.max(16, Math.round(e / 255 / div))), err = trial(f0, c, j, d0, -1);
        if (!best || err < best[0]) best = [err, j, d0];
      }
      dst[o + c] = best[1]; dv.setUint16(o + ch + c * 2, best[2], true); dv.setInt16(o + ch * 3 + c * 2, S(f0 + 1, c), true); dv.setInt16(o + ch * 5 + c * 2, S(f0, c), true);
      trial(f0, c, best[1], best[2], o);
    }
  }
}
let CRC_T = null;
function crc32(b) {
  if (!CRC_T) { CRC_T = new Int32Array(256); for (let n = 0; n < 256; ++n) { let c = n; for (let k = 0; k < 8; ++k) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c; } }
  let c = -1; for (let i = 0; i < b.length; ++i) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
