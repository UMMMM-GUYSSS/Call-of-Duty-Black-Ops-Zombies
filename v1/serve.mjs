

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { join, resolve, extname, sep } from 'node:path';

const argv = process.argv.slice(2);
// Both `--name value` and `--name=value`.
const option = (name, fallback) => {
  const inline = argv.find(argument => argument.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const at = argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const value = argv[at + 1];
  return value === undefined || value.startsWith('--') ? true : value;
};

const ROOT = resolve(String(option('root', process.cwd())));
const HOST = String(option('host', '127.0.0.1'));
const PORT = Number(option('port', 8080));
const QUIET = option('quiet', false) === true;
let PREFIX = String(option('path', '/bo1z/'));
if (!PREFIX.startsWith('/')) PREFIX = '/' + PREFIX;
if (!PREFIX.endsWith('/')) PREFIX += '/';

// ES modules need a JavaScript MIME type and the engine needs application/wasm; a wrong one is a hard error, not a
// warning. Everything else (iwd/ff/kop/pack/dxs, the extension-less <path>.part/<k> chunks) is opaque bytes.
const TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.webm': 'video/webm', '.mp4': 'video/mp4', '.ogg': 'audio/ogg',
}));
const typeOf = file => TYPES.get(extname(file).toLowerCase()) ?? 'application/octet-stream';

// Code and manifests must never be stale (a re-served manifest with an old version would skip every pack file); the
// pack bytes are SHA-256 checked anyway, and the client asks for them with cache:'no-store'. Only art may be cached.
const cacheFor = file => /\.(html|js|mjs|css|json|wasm|webmanifest)$/i.test(file) ? 'no-store'
  : /\.(webp|png|jpe?g|gif|svg|ico|webm|mp4)$/i.test(file) ? 'public, max-age=3600' : 'no-store';

const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
};

function send(req, res, status, headers, body = '') {
  const bytes = Buffer.byteLength(body);
  res.writeHead(status, { ...ISOLATION, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': String(bytes), 'Cache-Control': 'no-store', ...headers });
  res.end(req.method === 'HEAD' ? undefined : body);
  log(req, status, bytes);
}

const mb = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(0)} kB` : `${bytes} B`;
function log(req, status, bytes, extra = '') {
  if (QUIET) return;
  const ms = `${(performance.now() - req.__t0).toFixed(0)}ms`;
  console.log(`${String(status)} ${mb(bytes).padStart(9)} ${ms.padStart(6)}  ${req.method} ${req.url}${extra}`);
}

// `bytes=N-`, `bytes=N-M` and `bytes=-N`. null: not a range this server understands (ignore the header, answer 200).
// 'unsatisfiable': a valid range that lies outside the file (answer 416).
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return null;
  const [, from, to] = match;
  if (from === '' && to === '') return null;
  let start, end;
  if (from === '') {
    const length = Number(to);
    if (!length) return null;
    start = Math.max(0, size - length); end = size - 1;
  } else {
    start = Number(from);
    end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

// <rel> -> a file on disk. Extension-less requests first get the exact name (the <path>.part/<k> chunks), then
// <rel>.html (the clean page URLs), then index.html for a directory. Anything escaping ROOT is refused.
async function resolveTarget(rel) {
  if (rel.split('/').includes('..')) return null;
  for (const candidate of rel.endsWith('/') ? [rel + 'index.html'] : [rel, rel + '.html']) {
    const abs = resolve(ROOT, candidate);
    if (abs !== ROOT && !abs.startsWith(ROOT + sep)) continue;
    try {
      const info = await stat(abs);
      if (info.isFile()) return { abs, size: info.size, mtime: info.mtime };
      if (info.isDirectory()) {
        const index = await stat(join(abs, 'index.html')).catch(() => null);
        if (index?.isFile()) return { abs: join(abs, 'index.html'), size: index.size, mtime: index.mtime };
      }
    } catch {}
  }
  return null;
}

// ?part=<k> needs the transport chunk the pack was split at. It is the map's own manifest transport.chunk (8 MiB), and
// it is a fact about the pack, not something to guess: without it the whole file would be answered and the download
// would fail, so an unknown chunk is a 404 and not a 200.
const chunks = new Map();
async function transportChunk(rel) {
  const segments = rel.split('/');
  const at = segments.indexOf('pack');
  if (at < 0) return 0;
  const mapRoot = segments.slice(0, at).join('/');
  if (chunks.has(mapRoot)) return chunks.get(mapRoot);
  let chunk = 0;
  for (const manifest of ['manifest.json', 'pack/web-manifest-horde.json']) {
    try {
      const transport = JSON.parse(await readFile(join(ROOT, mapRoot, manifest), 'utf8'))?.transport;
      if (transport?.encoding === 'br' && Number.isSafeInteger(transport.chunk) && transport.chunk > 0) { chunk = transport.chunk; break; }
    } catch {}
  }
  chunks.set(mapRoot, chunk);
  return chunk;
}

const server = createServer(async (req, res) => {
  req.__t0 = performance.now();
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, { Allow: 'GET, HEAD' }, 'Only GET and HEAD are served.\n');

  let url, pathname;
  try { url = new URL(req.url, `http://${req.headers.host || HOST}`); pathname = decodeURIComponent(url.pathname); }
  catch { return send(req, res, 400, {}, 'Bad request.\n'); }

  if (PREFIX !== '/' && (pathname === '/' || pathname === PREFIX.slice(0, -1))) {
    return send(req, res, 308, { Location: PREFIX + (url.search || '') }, `The site is mounted at ${PREFIX}\n`);
  }
  if (!pathname.startsWith(PREFIX)) return send(req, res, 404, {}, `Not found. The site is mounted at ${PREFIX}\n`);

  const rel = pathname.slice(PREFIX.length);
  const target = await resolveTarget(rel);
  if (!target) return send(req, res, 404, {}, `Not found: ${pathname}\n`);

  let status = 200, start = 0, end = target.size - 1;
  const range = req.headers.range;
  const part = url.searchParams.get('part');
  if (range) {
    const parsed = parseRange(range, target.size);
    if (parsed === 'unsatisfiable') return send(req, res, 416, { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${target.size}` }, '');
    if (parsed) { start = parsed.start; end = parsed.end; status = 206; }
  } else if (part !== null) {
    const chunk = /^\d+$/.test(part) ? await transportChunk(rel) : 0;
    if (!chunk) return send(req, res, 404, {}, `No ?part= transport for ${rel} (missing manifest transport.chunk); this pack reads its <path>.part/<k> split files instead.\n`);
    start = Number(part) * chunk;
    if (start >= target.size) return send(req, res, 404, {}, `Part ${part} is past the end of ${rel}.\n`);
    end = Math.min(target.size, start + chunk) - 1;
  }

  const length = end - start + 1;
  const headers = {
    ...ISOLATION,
    'Content-Type': typeOf(target.abs),
    'Content-Length': String(length),
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheFor(rel),
    'Last-Modified': target.mtime.toUTCString(),
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${target.size}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || !length) { res.end(); log(req, status, length); return; }

  try { await pipeline(createReadStream(target.abs, { start, end }), res); log(req, status, length, status === 206 ? ` [${start}-${end}]` : part !== null ? ` [part ${part}]` : ''); }
  catch (error) {
    // The player closed the tab or the client aborted a stalled part; that is normal, not a server error.
    if (!res.destroyed) res.destroy();
    if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error(`${req.method} ${req.url}: ${error.message}`);
  }
});

server.on('clientError', (error, socket) => { if (!socket.destroyed) socket.destroy(); });
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Pass --port <n>.` : `Server error: ${error.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST.includes(':') ? `[${HOST}]` : HOST;
  console.log(`Serving ${ROOT}`);
  console.log(`  http://${shown}:${PORT}${PREFIX}          the landing (map select)`);
  console.log(`  http://${shown}:${PORT}${PREFIX}kino       a map page, no .html`);
  if (HOST === '0.0.0.0') console.log(`  Another device: the LAN address works for the pages, but plain http://<lan-ip> is NOT a secure context, so\n    capabilities.js stops at "Open the HTTPS link" (no SharedArrayBuffer). Use an HTTPS tunnel for real play.`);
  console.log(`crossOriginIsolated is required (SharedArrayBuffer): check self.crossOriginIsolated in the console, it must be true.`);
  if (PREFIX === '/') console.log(`--path / : the map pages work, but index.html's <base href="/bo1z/"> breaks the landing page. Use --path /bo1z/ for that.`);
  console.log(`First load downloads that map's pack (0.9-1.3 GB) into OPFS, once per origin+map; later loads are local.`);
  console.log(`Ctrl-C stops the server.`);
});
