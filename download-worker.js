// Only this worker writes the cache. A cross-tab lock protects metadata and files.
import { map, manifestUrl, packBase, packCdn } from './maps.js';
import './sha256.js';
import { dxsInverse } from './dxs.js';
const encoder = new TextEncoder();
let metrics, root, cache, metadataHandle, lastProgress = 0;
let classTotal, classDone, currentClass, started, transportChunk = 0;
let directoryHandles;
let inspected = null; // load5: { manifest, at } from inspect(), reused by download()

// r2direct: pack bytes from the R2 custom domain (maps.js packCdn: R2 keys packs/<slug>/<path>, Brotli part k = the object
// <path>.br/<k>, stored with Content-Encoding: br so fetch decodes it exactly like the Worker's ?part=k). A local static
// mirror may opt selected entries into identity chunks at <path>.part/<k>; these avoid a custom `?part=` endpoint and do not
// depend on Content-Encoding support. For those entries, the same-origin split files are authoritative even when a CDN pack
// origin is configured: the listed BO1 .ff/.iwd packs are emitted as <path>.part/<k> or <path>.kop.part/<k>, not Source-engine
// container chunks and not R2 <path>.br/<k> objects. ?v= is the file's SHA-256 prefix, so a re-uploaded file gets a fresh
// edge-cache key. Any CDN failure (network/CORS error, HTTP error, bad length, SHA-256 mismatch) moves the rest of this
// download to the Worker (packBase, ?part=k), which remains the production fallback.
let cdnDown = false;
function cdnFailed(error) {
  if (!packCdn || cdnDown) return;
  cdnDown = true; metrics.cdnError = String(error?.message ?? error).slice(0, 160);
}
function localPartFailed(error) {
  metrics.localPartFailures = (metrics.localPartFailures ?? 0) + 1;
  metrics.localPartError = String(error?.message ?? error).slice(0, 160);
}
// dlstall: a pack request with no response for FETCH_STALL_MS, or a body that delivers no bytes for that long, is
// aborted; the callers' existing retry paths (local split part -> CDN -> Worker, up to 3 attempts, then an error screen)
// take over instead of the download waiting forever with no error.
const FETCH_STALL_MS = 30000;
async function stallFetch(url, init) {
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(new Error(`no response in ${FETCH_STALL_MS / 1000} s`)), FETCH_STALL_MS);
  try { return await fetch(url, { ...init, signal: abort.signal }); } finally { clearTimeout(timer); }
}
function readSoon(reader) {
  let timer;
  const stalled = new Promise((_, reject) => { timer = setTimeout(() => {
    reader.cancel().catch(() => {}); reject(new Error(`download stalled: no bytes for ${FETCH_STALL_MS / 1000} s`)); }, FETCH_STALL_MS); });
  return Promise.race([reader.read(), stalled]).finally(() => clearTimeout(timer));
}
async function closeResponse(response) {
  try { await response?.body?.cancel(); } catch {}
}
async function tryLocalPart(entry, rel, part, init) {
  if (part === null || !entry.local_parts) return null;
  metrics.localPartRequests = (metrics.localPartRequests ?? 0) + 1;
  try {
    const response = await stallFetch(packBase + rel + `.part/${part}`, { cache: 'no-store', ...init });
    if (response.ok) return response;
    localPartFailed(`${rel}.part/${part}: HTTP ${response.status}`);
    await closeResponse(response);
  } catch (error) { localPartFailed(error); }
  return null;
}
async function packFetch(entry, suffix, part, init = {}) {
  const rel = entry.path.split('/').map(encodeURIComponent).join('/') + suffix;
  const localPart = await tryLocalPart(entry, rel, part, init);
  if (localPart) return localPart;
  if (packCdn && !cdnDown) {
    try {
      const response = await stallFetch(packCdn + rel + (part === null ? '' : `.br/${part}`) + `?v=${entry.sha256.slice(0, 16)}`, { cache: 'no-store', ...init });
      if (response.ok) { metrics.cdnRequests = (metrics.cdnRequests ?? 0) + 1; return response; }
      cdnFailed(`${rel}: CDN HTTP ${response.status}`);
    } catch (error) { cdnFailed(error); }
  }
  metrics.workerPackRequests = (metrics.workerPackRequests ?? 0) + 1;
  return stallFetch(packBase + rel + (part === null ? '' : `?part=${part}`), { cache: 'no-store', ...init });
}

async function fileAt(base, path, create = false) {
  const parts = path.split('/');
  let dir = base;
  let prefix = '';
  for (const name of parts.slice(0, -1)) {
    prefix += name + '/';
    if (!directoryHandles.has(prefix)) directoryHandles.set(prefix, dir.getDirectoryHandle(name, { create }));
    dir = await directoryHandles.get(prefix);
  }
  return dir.getFileHandle(parts.at(-1), { create });
}

function validate(manifest) {
  // size2 t3: Opus sounds need WebCodecs AudioDecoder + nested workers; otherwise use the original parts from the start.
  for (const f of manifest.files ?? []) if (f?.opus && f.fallback && (typeof AudioDecoder !== 'function' || typeof Worker !== 'function')) useFallback(f);
  if (manifest.schema !== 1 || !/^[a-f0-9]{64}$/.test(manifest.version) || !Array.isArray(manifest.files)) throw new Error('Unsupported manifest');
  const seen = new Set();
  for (const f of manifest.files) {
    if (typeof f.path !== 'string' || !f.path || f.path.startsWith('/') || /[\\:]/.test(f.path) || f.path.split('/').some(p => !p || p === '.' || p === '..') ||
        !Number.isSafeInteger(f.size) || f.size < 0 || !/^[a-f0-9]{64}$/.test(f.sha256) || !manifest.classes.includes(f.priority) || seen.has(f.path.toLowerCase())) throw new Error('Invalid manifest entry');
    seen.add(f.path.toLowerCase());
  }
  if (manifest.files.reduce((sum, f) => sum + f.size, 0) !== manifest.total_bytes) throw new Error('Invalid manifest total');
}

function saveMetadata() {
  // One worker owns this handle for the entire download under the cross-tab lock.
  // Reopening it for every entry stalled createSyncAccessHandle on the 1,858-file
  // Five pack. Sync writes serialize naturally on this worker's event loop.
  const snapshot = encoder.encode(JSON.stringify(cache));
  metadataHandle.truncate(0);
  let written = 0;
  while (written < snapshot.length) {
    const n = metadataHandle.write(snapshot.subarray(written), { at: written });
    if (!n) throw new Error('OPFS journal write made no progress');
    written += n;
  }
  metadataHandle.flush();
}

function progress(force = false) {
  const now = performance.now();
  if (!force && now - lastProgress < 100) return;
  lastProgress = now;
  const seconds = (now - started) / 1000;
  const rate = metrics.networkBytes / Math.max(seconds, .001);
  postMessage({ type: 'progress', priority: currentClass, completed: classDone, total: classTotal,
    bytes: metrics.networkBytes, mbps: rate / 1e6, eta: rate ? Math.max(0, classTotal - classDone) / rate : null });
}

// DXS transport (mksizepack.mjs --dxs, size2): <path>.dxs?part=k are Brotli parts of the DXT-stream-split IWD.
// Whole file in memory (no resume), inverted to the stored IWD, hashed against entry.sha256, then written once.
let dxsSlot = Promise.resolve();
async function fetchDxs(entry, handle) {
  cache.files[entry.path] = { sha256: entry.sha256, size: entry.size, verified: false };
  await saveMetadata();
  for (let attempt = 1; ; ++attempt) {
    let credited = 0;
    try {
      const blob = new Uint8Array(entry.dxs); let at = 0;
      for (let k = 0; k < entry.br.length; ++k) {
        const response = await packFetch(entry, '.dxs', k);
        if (!response.ok) throw new Error(`${entry.path}: HTTP ${response.status}`);
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await readSoon(reader);
          if (done) break;
          if (at + value.length > entry.dxs) throw new Error('File exceeds manifest size');
          blob.set(value, at); at += value.length; metrics.networkBytes += value.length;
          const c = Math.floor(at * entry.size / entry.dxs) - credited; credited += c; classDone += c; progress();
        }
        if (at !== Math.min(entry.dxs, (k + 1) * transportChunk)) throw new Error('Truncated part');
      }
      // One inverse+hash+write at a time bounds the transient copies (blob + stored IWD) held by this worker.
      const turn = dxsSlot; let release; dxsSlot = new Promise(r => { release = r; });
      await turn;
      try {
        const t0 = performance.now(), bytes = dxsInverse(blob, entry.size);
        metrics.dxsMs = (metrics.dxsMs ?? 0) + performance.now() - t0;
        const h0 = performance.now(), hasher = new StreamingSHA256();
        for (let p = 0; p < bytes.length; p += 1 << 20) hasher.update(bytes.subarray(p, p + (1 << 20)));
        const digest = hasher.hex(); metrics.digestMs += performance.now() - h0;
        if (digest !== entry.sha256) throw new Error(`SHA-256 mismatch: ${entry.path}`);
        const access = await handle.createSyncAccessHandle();
        try {
          access.truncate(0);
          for (let w = 0; w < bytes.length;) {
            const n = access.write(bytes.subarray(w), { at: w });
            if (!n) throw new Error('OPFS write made no progress');
            w += n; metrics.opfsWrites++;
          }
          access.flush();
        } finally { access.close(); }
      } finally { release(); }
      classDone += entry.size - credited;
      metrics.verifiedFiles++; metrics.verifiedBytes += entry.size; metrics.dxsFiles = (metrics.dxsFiles ?? 0) + 1;
      break;
    } catch (error) {
      classDone -= credited;
      if (error.name !== 'QuotaExceededError') cdnFailed(error);
      if (error.name === 'QuotaExceededError' || attempt >= 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * attempt));
    }
  }
  cache.files[entry.path].verified = true;
  await saveMetadata();
}
// size2 t3 Opus transport (tools/web/mkopuspack.mjs): <path>.kop?part=k are Brotli parts of the KOP1 container; entry.sha256
// is the SHA-256 of the .kop bytes (checked before decoding), entry.size the rebuilt KSPK sounds.pack. 4 opus-worker.js
// decode/resample clips to their original rate and frame count; records are written at precomputed offsets, the index
// (with recomputed per-record SHA-256s) last. No AudioDecoder or any decode failure: original parts (entry.fallback).
function useFallback(entry) {
  const { size, sha256, br } = entry.fallback;
  Object.assign(entry, { size, sha256, br });
  delete entry.opus;
  // local_parts describes optimized .kop chunks, never the whole original fallback file.
  delete entry.local_parts;
}
// reqcut: opus-worker.js is fetched once per download and every pool worker starts from a blob: URL of it. Each
// new Worker(url) used to refetch the script (no-store): 4 per .kop file, ~60 Worker requests per first map load.
// opus-worker.js has no imports, so the blob URL needs no base. A failed fetch is not kept (the next file retries).
let opusWorkerPromise = null;
const OPUS_STALL_MS = 15000, OPUS_RESTARTS = 3;
function opusWorkerUrl() {
  return opusWorkerPromise ??= fetch(new URL('./opus-worker.js', import.meta.url), { cache: 'no-store' })
    .then(response => { if (!response.ok) throw new Error(`opus-worker.js HTTP ${response.status}`); return response.text(); })
    .then(text => URL.createObjectURL(new Blob([text], { type: 'text/javascript' })))
    .catch(error => { opusWorkerPromise = null; throw error; });
}
async function fetchOpus(entry, handle, base) {
  cache.files[entry.path] = { sha256: entry.sha256, size: entry.size, verified: false };
  await saveMetadata();
  const blob = new Uint8Array(entry.opus); let at = 0, credited = 0;
  try {
    for (let k = 0; k < entry.br.length; ++k) {
      const response = await packFetch(entry, '.kop', k);
      if (!response.ok) throw new Error(`${entry.path}: HTTP ${response.status}`);
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await readSoon(reader);
        if (done) break;
        if (at + value.length > entry.opus) throw new Error('File exceeds manifest size');
        blob.set(value, at); at += value.length; metrics.networkBytes += value.length;
        const c = Math.floor(at * entry.size / entry.opus / 2) - credited; credited += c; classDone += c; progress();
      }
      if (at !== Math.min(entry.opus, (k + 1) * transportChunk)) throw new Error('Truncated part');
    }
    const h0 = performance.now(), digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', blob))].map(x => x.toString(16).padStart(2, '0')).join('');
    metrics.digestMs += performance.now() - h0;
    if (digest !== entry.sha256) throw new Error(`SHA-256 mismatch: ${entry.path}.kop`);
    const view = new DataView(blob.buffer), jsonLen = view.getUint32(4, true);
    if (String.fromCharCode(...blob.subarray(0, 4)) !== 'KOP1') throw new Error('Invalid KOP1');
    const meta = JSON.parse(new TextDecoder().decode(blob.subarray(8, 8 + jsonLen)));
    const head = Uint8Array.from(atob(meta.head), ch => ch.charCodeAt(0)), hv = new DataView(head.buffer);
    const totalPackets = meta.recs.reduce((s, r) => s + (r.np ?? 0), 0), lens = new Uint16Array(totalPackets);
    for (let i = 0; i < totalPackets; ++i) lens[i] = view.getUint16(8 + jsonLen + i * 2, true);
    let src = 8 + jsonLen + totalPackets * 2, dst = head.length, lensAt = 0;
    // size3 mode 'zip' (tools/web/mksize3.mjs): a stored IWD whose MS-ADPCM streamed sounds ship as Opus. No KSPK head/index:
    // records cover the whole file; an Opus record carries its 2096-byte stream header (hn) and tail (tn) around the packets,
    // the worker re-encodes MS-ADPCM into exactly ab bytes, and its zip CRC32 is patched at r.crc (local + central header).
    const zip = meta.mode === 'zip', outLen = r => zip ? r.hn + r.ab + r.tn : 44 + r.frames * r.ch * 2;
    const jobs = [], raws = [];
    meta.recs.forEach((r, id) => {
      if (r.t === 'raw') { raws.push({ id, off: dst, bytes: blob.subarray(src, src + r.n) }); src += r.n; dst += r.n; return; }
      const l = lens.subarray(lensAt, lensAt + r.np), n = l.reduce((s, x) => s + x, 0) + (zip ? r.hn + r.tn : 0);
      jobs.push({ ...r, id, off: dst, lens: l, at: src, len: n });
      lensAt += r.np; src += n; dst += outLen(r);
    });
    if (dst !== entry.size) throw new Error('KOP1 layout size mismatch');
    const access = await handle.createSyncAccessHandle();
    try {
      access.truncate(entry.size);
      const write = (bytes, off) => { for (let w = 0; w < bytes.length;) { const n = access.write(bytes.subarray(w), { at: off + w }); if (!n) throw new Error('OPFS write made no progress'); w += n; metrics.opfsWrites++; } };
      // KSPK index record i: offset +0, length +4, format +8, name length +12, SHA-256 +16..47, name.
      const recordAt = []; for (let i = 0, o = 24; !zip && i < meta.recs.length; ++i) { recordAt.push(o); o += 48 + hv.getUint32(o + 12, true); }
      const setRecord = (id, off, len, sha) => { if (zip) return; const o = recordAt[id]; hv.setUint32(o, off, true); hv.setUint32(o + 4, len, true); head.set(new Uint8Array(sha), o + 16); };
      for (const r of raws) { write(r.bytes, r.off); if (!zip) setRecord(r.id, r.off, r.bytes.length, await crypto.subtle.digest('SHA-256', r.bytes)); }
      const workerUrl = await opusWorkerUrl();
      // dlstall: a clip decodes in milliseconds, but Firefox 157 occasionally never answers one (seen as a boot download
      // stuck at 100% network with sounds.pack in this pool for minutes, no error). A job with no answer for OPUS_STALL_MS
      // gets a fresh worker and is sent again (the clip's bytes are sliced again from blob); after OPUS_RESTARTS restarts
      // the file falls back to the original parts below. A throw while handling an answer (OPFS write) also rejects.
      const t0 = performance.now(), byId = new Map(jobs.map(j => [j.id, j]));
      const slots = Array.from({ length: Math.min(4, navigator.hardwareConcurrency || 4) }, () => ({ worker: null, job: null, sent: 0 }));
      let next = 0, doneBytes = 0, restarts = 0, watchdog = 0;
      try {
        await new Promise((resolve, reject) => {
          const fail = error => { clearInterval(watchdog); reject(error); };
          const send = slot => {
            const { lens: l, at, len, ...job } = slot.job, data = blob.slice(at, at + len).buffer;
            slot.sent = performance.now(); slot.worker.postMessage({ ...job, lens: l, data }, [data]);
          };
          const feed = slot => {
            slot.job = next < jobs.length ? jobs[next++] : null;
            if (slot.job) return send(slot);
            if (slots.every(s => !s.job)) { clearInterval(watchdog); resolve(); }
          };
          const spawn = slot => {
            const worker = slot.worker = new Worker(workerUrl);
            worker.onerror = e => { if (worker === slot.worker) fail(new Error('opus-worker: ' + (e.message ?? 'error'))); };
            worker.onmessage = ({ data: m }) => {
              if (worker !== slot.worker || m.id !== slot.job?.id) return; // a replaced worker's late answer
              try {
                if (m.error) throw new Error('opus decode: ' + m.error);
                const job = meta.recs[m.id], off = byId.get(m.id).off, wav = new Uint8Array(m.wav);
                if (wav.length !== outLen(job)) throw new Error('opus clip size mismatch');
                write(wav, off); setRecord(m.id, off, wav.length, m.sha);
                if (zip) { const c = new Uint8Array(4); new DataView(c.buffer).setUint32(0, m.crc >>> 0, true); for (const at of job.crc) write(c, at); }
                doneBytes += wav.length; const c = Math.floor(entry.size / 2 + doneBytes / 2) - credited; credited += c; classDone += c; progress();
                feed(slot);
              } catch (error) { fail(error); }
            };
          };
          watchdog = setInterval(() => {
            for (const slot of slots) {
              if (!slot.job || performance.now() - slot.sent < OPUS_STALL_MS) continue;
              if (++restarts > OPUS_RESTARTS) return fail(new Error(`opus-worker stalled on clip ${slot.job.id}`));
              metrics.opusRestarts = restarts; slot.worker.terminate(); spawn(slot); send(slot);
            }
          }, 1000);
          for (const slot of slots) { spawn(slot); feed(slot); }
        });
      } finally { clearInterval(watchdog); slots.forEach(s => s.worker?.terminate()); }
      metrics.opusMs = (metrics.opusMs ?? 0) + performance.now() - t0; metrics.opusClips = (metrics.opusClips ?? 0) + jobs.length;
      if (!zip) { hv.setUint32(16, entry.size, true); write(head, 0); }
      access.flush();
    } finally { access.close(); }
  } catch (error) {
    classDone -= credited;
    if (error.name === 'QuotaExceededError') throw error;
    metrics.opusFallback = String(error.message ?? error).slice(0, 200);
    useFallback(entry); return fetchFile(entry, base);
  }
  classDone += entry.size - credited;
  metrics.verifiedFiles++; metrics.verifiedBytes += entry.size;
  cache.files[entry.path].verified = true;
  await saveMetadata();
}

async function fetchFile(entry, base) {
  // Static mirrors can use explicitly provided identity chunks; production keeps using CDN/Worker Brotli parts.
  const partTransport = Boolean(transportChunk && (packCdn || entry.local_parts));
  // Without either transport, an Opus container is not usable: fetch its already-present original fallback directly.
  if (!partTransport && entry.opus && entry.fallback) useFallback(entry);
  const handle = await fileAt(base, entry.path, true);
  const existing = cache.files[entry.path];
  const same = existing?.sha256 === entry.sha256 && existing?.size === entry.size;
  if (same && existing.verified && (await handle.getFile()).size === entry.size) {
    metrics.cachedFiles++; classDone += entry.size; progress(); return;
  }
  if (partTransport && entry.opus && entry.fallback && Array.isArray(entry.br)) return fetchOpus(entry, handle, base);
  if (partTransport && entry.dxs && Array.isArray(entry.br) && entry.br.length === Math.ceil(entry.dxs / transportChunk)) return fetchDxs(entry, handle);
  let access = await handle.createSyncAccessHandle();
  const size = access.getSize();
  let offset = same && size <= entry.size ? size : 0;
  // Chunk transports resume at a part boundary; the prefix is still re-hashed below.
  const parts = partTransport && Array.isArray(entry.br) && entry.br.length === Math.ceil(entry.size / transportChunk);
  if (parts && offset % transportChunk) { offset -= offset % transportChunk; access.truncate(offset); }
  cache.files[entry.path] = { sha256: entry.sha256, size: entry.size, verified: false };
  try {
    await saveMetadata(); // Persist the expected hash before downloading; byte length is the resume cursor.
    if (!offset) access.truncate(0);
    classDone += offset;
    let failures = 0, hashFailures = 0, verifyResets = 0;
    while (true) {
      let hasher = new StreamingSHA256();
      const batch = new Uint8Array(1024 * 1024);
      const hash = bytes => {
        const start = performance.now(); hasher.update(bytes);
        metrics.digestMs += performance.now() - start;
      };
      // Resume includes the on-disk prefix in the same digest; never trust it by size.
      const verifyStart = performance.now();
      let unreadable = false;
      for (let read = 0; read < offset;) {
        let n = 0;
        try { n = access.read(batch.subarray(0,Math.min(batch.length,offset-read)), { at: read }); } catch {}
        if (!n) { unreadable = true; break; }
        hash(batch.subarray(0,n)); read += n;
      }
      metrics.verifyMs += performance.now() - verifyStart;
      // verifyfix: a saved prefix that can't be read back (browser closed mid-write, disk trouble) is discarded, not
      // fatal: this file restarts from byte 0 once. Players reported "OPFS verification read made no progress".
      if (unreadable) {
        if (verifyResets++) throw new Error('OPFS verification read made no progress');
        metrics.verifyResets = (metrics.verifyResets ?? 0) + 1;
        access.truncate(0); classDone -= offset; offset = 0; progress(); continue;
      }
      let pending = 0;
      const writeBatch = () => {
        if (!pending) return;
        hash(batch.subarray(0,pending));
        let written = 0;
        while (written < pending) {
          const n = access.write(batch.subarray(written,pending), { at: offset+written });
          if (!n) throw new Error('OPFS write made no progress');
          written += n; metrics.opfsWrites++;
        }
        offset += written; classDone += written; pending = 0; progress();
      };
      try {
        const pump = async (response, end) => {
          const reader = response.body.getReader();
          try {
            while (true) {
              const { done, value } = await readSoon(reader);
              if (done) break;
              if (offset + pending + value.length > end) throw new Error('File exceeds manifest size');
              metrics.networkBytes += value.length;
              for (let pos = 0; pos < value.length;) {
                const n = Math.min(batch.length-pending,value.length-pos);
                batch.set(value.subarray(pos,pos+n),pending); pending+=n; pos+=n;
                if (pending === batch.length) writeBatch();
              }
            }
          } finally { reader.releaseLock(); writeBatch(); access.flush(); }
        };
        if (parts) {
          // Each part decodes (Content-Encoding: br, done by fetch) to exactly one identity chunk.
          while (offset < entry.size) {
            const end = Math.min(entry.size, offset + transportChunk);
            const response = await packFetch(entry, '', offset / transportChunk);
            if (!response.ok) throw new Error(`${entry.path}: HTTP ${response.status}`);
            await pump(response, end);
            if (offset !== end) throw new Error('Truncated part');
          }
        } else if (offset < entry.size) {
          const response = await packFetch(entry, '', null, { headers: offset ? { Range: `bytes=${offset}-` } : {} });
          if (!response.ok) throw new Error(`${entry.path}: HTTP ${response.status}`);
          if (offset && response.status === 200) { classDone -= offset; offset = 0; access.truncate(0); hasher = new StreamingSHA256(); }
          if (response.status === 206 && response.headers.get('Content-Range') !== `bytes ${offset}-${entry.size - 1}/${entry.size}`) throw new Error('Invalid resume response');
          if (Number(response.headers.get('Content-Length')) !== entry.size - offset) throw new Error('Invalid download length');
          await pump(response, entry.size);
          if (offset !== entry.size) throw new Error('Truncated download');
        }
      } catch (error) {
        if (error.name !== 'QuotaExceededError') cdnFailed(error);
        if (error.name === 'QuotaExceededError' || ++failures >= 3) throw error;
        // A part that failed midway resumes from its start (?part=k takes whole parts only); the prefix is re-hashed.
        if (parts && offset % transportChunk) { classDone -= offset % transportChunk; offset -= offset % transportChunk; access.truncate(offset); }
        await new Promise(resolve => setTimeout(resolve, 500 * failures));
        continue;
      }
      access.flush();
      access.close(); access = null;
      const digestStart = performance.now();
      const digest = hasher.hex();
      metrics.digestMs += performance.now() - digestStart;
      if (digest !== entry.sha256) {
        cdnFailed(`SHA-256 mismatch: ${entry.path}`);
        if (++hashFailures >= 2) throw new Error(`SHA-256 mismatch: ${entry.path}`);
        classDone -= offset; offset = 0;
        access = await handle.createSyncAccessHandle(); access.truncate(0); continue;
      }
      metrics.verifiedFiles++; metrics.verifiedBytes += entry.size;
      break;
    }
  } finally { access?.close(); }
  cache.files[entry.path].verified = true;
  await saveMetadata();
}

let resumeBackground = null;
async function download({ bootOnly = false, parallel = 3, want = [], order = 'b2', holdBackground = false, delay = null } = {}) {
  started = performance.now();
  metrics = { networkBytes: 0, cachedFiles: 0, verifiedFiles: 0, verifiedBytes: 0, verifyMs: 0, digestMs: 0, opfsWrites: 0 };
  directoryHandles = new Map();
  // load5: the landing's inspect pass in this same worker fetched and validated the manifest moments ago; reuse it
  // (saves a worker start + a no-store manifest round trip before the first boot byte). Older than 60 s: refetch.
  let manifest = inspected && performance.now() - inspected.at < 60000 ? inspected.manifest : null; inspected = null;
  if (!manifest) {
    const response = await fetch(manifestUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Manifest HTTP ${response.status}`);
    manifest = await response.json(); validate(manifest);
  }
  transportChunk = manifest.transport?.encoding === 'br' && Number.isSafeInteger(manifest.transport.chunk) && manifest.transport.chunk > 0 ? manifest.transport.chunk : 0;
  root = await (await navigator.storage.getDirectory()).getDirectoryHandle(map.opfs, { create: true });
  const base = await root.getDirectoryHandle('files', { create: true });
  metadataHandle = await (await root.getFileHandle('cache.json', { create: true })).createSyncAccessHandle();
  try {
    try {
      const bytes = new Uint8Array(metadataHandle.getSize());
      let read = 0;
      while (read < bytes.length) {
        const n = metadataHandle.read(bytes.subarray(read), { at: read });
        if (!n) throw new Error('OPFS journal read made no progress');
        read += n;
      }
      cache = JSON.parse(new TextDecoder().decode(bytes));
    } catch { cache = { files: {} }; }
    if (!cache?.files || typeof cache.files !== 'object' || Array.isArray(cache.files)) cache = { files: {} };
    let changed = cache.version !== manifest.version;
    postMessage({ type: 'manifest', manifest, changed });
    for (const priority of manifest.classes) {
      if (bootOnly && priority !== 'boot') break;
      if (priority === 'lazy') continue; // size2: lazy files ride with boot only when asked for (want)
      // load4: music/voices (background) wait until play.js reports map-loaded (or 120 s): during the cold tail of the map
      // load their fetch + digest + OPFS writes shared the link, CPU and the OPFS backend with the engine's zone reads.
      if (priority !== 'boot' && holdBackground) await new Promise(resolve => { resumeBackground = resolve; setTimeout(resolve, 120000); });
      currentClass = priority; classDone = 0;
      const files = manifest.files.filter(f => f.priority === priority || (priority === 'boot' && f.priority === 'lazy' && want.includes(f.path)));
      // overlap: the engine starts during the boot download and waits per file (src/web/browser/pack_gate.cpp), so fetch
      // boot files in the order it needs them. Shader packs go first: the link rate is shared, so a shader pack started
      // after the IWDs got a third of it and the engine waited 6.5-9.5 s at renderer init; first, it lands while the IWDs
      // (FS_Startup indexes every one) still stream. Then root + main/, small zones (code/patch), sounds.pack (sound init),
      // common_* zones, map zones (last: the gate answers their stat early, the open waits). Stable otherwise.
      if (priority === 'boot') {
        const rank = f => { const p = f.path.toLowerCase();
          if (p.startsWith('web/shaders/')) return order === 'b0' ? 1 : 0; // ?overlap=b0 (A/B only): root+main first
          // load4 (b2): sounds.pack (Opus, ~24 MB wire + decode) next: it lands during wasm start-up, before FS_Startup
          // needs the IWDs; after the IWDs it shared the link with the big zones and sound init waited 1-13 s.
          if ((order === 'b2' || order === 'b3') && p.startsWith('web/sound/')) return 0.5;
          if (!p.includes('/') || p.startsWith('main/')) return order === 'b0' ? 0 : 1;
          if (p.startsWith('zone/') && f.size < 8e6) return 2;
          if (p.startsWith('web/')) return 3;
          // load5 (b3): the map zone before common_*. The loading screen opens zone/Common/<map>.ff (pack-gate "early stat",
          // then "waited ... (open)": 2.7-4.4 s at 90 Mbit, 2.9 s live) about 2 s before DB_SyncXAssets needs common_zombie.ff;
          // with common first the engine idled on the map zone while common had already landed. Same bytes, same end time.
          if (/^zone\/[^/]+\/common_/.test(p)) return order === 'b3' ? 5 : 4;
          return order === 'b3' ? 4 : 5; };
        files.sort((a, b) => rank(a) - rank(b));
      }
      classTotal = files.reduce((sum, f) => sum + f.size, 0);
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(Math.max(1, parallel), 4) }, async () => {
        while (cursor < files.length) {
          const entry = files[cursor++];
          // bootfix (test only, ?dlDelay=<path>:<ms>): hold one file back to reproduce a slow disk/link for that file.
          if (delay && delay.path === entry.path) await new Promise(resolve => setTimeout(resolve, delay.ms));
          await fetchFile(entry, base);
          // Verified, written, flushed and closed: the engine's pack gate may open it now.
          if (priority === 'boot') postMessage({ type: 'file-ready', path: entry.path, t: performance.now() - started });
        }
      }));
      progress(true);
      if (priority === 'boot') { metrics.bootMs = performance.now() - started; postMessage({ type: 'boot-ready', metrics: { ...metrics }, manifest }); }
    }
    cache.version = manifest.version;
    await saveMetadata();
    metrics.totalMs = performance.now() - started;
  } finally { metadataHandle.close(); metadataHandle = null; }
  postMessage({ type: 'complete', metrics, manifest });
}

// Return-visit inspection opens no write handles and starts no transfers. The
// existing downloader remains responsible for verification and partial resume.
async function inspect({ want = [] } = {}) {
  const response = await fetch(manifestUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Manifest HTTP ${response.status}`);
  const manifest = await response.json(); validate(manifest);
  let saved = { files: {} }, base;
  try {
    const pack = await (await navigator.storage.getDirectory()).getDirectoryHandle(map.opfs);
    base = await pack.getDirectoryHandle('files');
    saved = JSON.parse(await (await (await pack.getFileHandle('cache.json')).getFile()).text());
  } catch (error) { if (error.name !== 'NotFoundError' && !(error instanceof SyntaxError)) throw error; }
  directoryHandles = new Map();
  let missingBootBytes = 0, missingBytes = 0;
  await Promise.all(manifest.files.map(async entry => {
    if (entry.priority === 'lazy' && !want.includes(entry.path)) return;
    const cached = saved?.files?.[entry.path];
    let valid = cached?.verified && cached.sha256 === entry.sha256 && cached.size === entry.size;
    if (valid) {
      try { valid = (await (await fileAt(base, entry.path)).getFile()).size === entry.size; }
      catch (error) { if (error.name !== 'NotFoundError') throw error; valid = false; }
    }
    if (!valid) { missingBytes += entry.size; if (entry.priority === 'boot' || entry.priority === 'lazy') missingBootBytes += entry.size; }
  }));
  inspected = { manifest, at: performance.now() };
  postMessage({ type: 'cache-status', manifest, ready: missingBootBytes === 0, missingBootBytes, missingBytes });
}

onmessage = event => {
  if (event.data.type === 'resume-background') { resumeBackground?.(); return; }
  if (!['download', 'inspect'].includes(event.data.type)) return;
  navigator.locks.request('five-pack-download', () => event.data.type === 'inspect' ? inspect(event.data) : download(event.data)).catch(error => {
    postMessage({ type: 'error', message: error.message, name: error.name });
  });
};
