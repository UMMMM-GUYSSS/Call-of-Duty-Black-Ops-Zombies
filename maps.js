// One site, one page per map, one download per map (players never fetch both packs).
// Five keeps the original root URLs (/, /manifest.json, /pack/, OPFS pack/); every other map lives under /<slug>/
// with its own manifest, pack root and OPFS namespace. Pages name their map with <html data-map>; workers get ?map=.
// velgg: every URL derives from BASE, the directory this module is served from ('/' at the root, '/zombie/' on vel.gg),
// so the same files work at the root and under a path prefix. OPFS names stay per map (OPFS is per origin, not per path).
export const BASE = new URL('./', import.meta.url).pathname;
// The engine takes the OPFS root from "+set fs_b" (src/web/browser/pack_root.h).
// maps: THE list of maps the site serves. Adding a map (e.g. nacht = zombie_cod5_prototype):
//   1. one line below; 2. python tools/web/mksiteart.py --pack <game dir> --map <zone> (loadscreen art);
//   3. node tools/web/site/mkpages.mjs (writes <slug>.html); 4. landing.js ENTRIES: one line { id: '<slug>', ... } (the
//   row/panel art for every retail map is already in art/, tools/web/mapselect/mksupported.py); 5. upload the site and
//   the pack (deploy/cloudflare/upload.mjs --only site / --only <slug> --pack <slug>=<dir>). No Worker change.
// zone: the map's zone/devmap name (<html data-map>, ?map=). slug: its page /<slug> (site/<slug>.html, written by
// mkpages.mjs), its pack URLs /<slug>/manifest.json + /<slug>/pack/ (R2 packs/<slug>/, the Worker routes any slug),
// its OPFS namespace pack-<slug> and its Options key <slug>-settings. Five is the exception (the first map): page /five,
// pack at the root (/manifest.json, /pack/ = R2 packs/five/), OPFS 'pack' - unchanged so returning players keep their
// cache. horde: the pack also ships the horde overlay (pack/web-manifest-horde.json, tools/web/mkmodpack.mjs --manifest), so
// the page runs horde with ?horde=1 (the landing's HORDE MODE toggle; landing.js ENTRIES carries the same flag).
// hordetoggle tests (2026-10-04, round 100, 300 alive): Five, Kino, Der Riese, Nacht, Verr�ckt, Shi No Numa reach 300.
// Not yet: Moon (starts in No Man's Land, whose own spawning keeps ~20 alive; some perk clip stays) and Ascension (the page
// froze in 3 of 3 runs at 300; noperks unverified). Packs without the overlay: Call of the Dead, Shangri-La.
// engineS: engine seconds from start to map-loaded for the progress bar's ETA (play.js; default 27).
export const MAP_LIST = [
  { zone: 'zombie_pentagon', slug: 'five', name: 'Five', horde: true },
  { zone: 'zombie_theater', slug: 'kino', name: 'Kino der Toten', horde: true, engineS: 20 },
  { zone: 'zombie_cod5_factory', slug: 'riese', name: 'Der Riese', horde: true },
  { zone: 'zombie_cod5_prototype', slug: 'nacht', name: 'Nacht der Untoten', horde: true },
  { zone: 'zombie_cod5_asylum', slug: 'verruckt', name: 'Verrückt', horde: true },
  { zone: 'zombie_cod5_sumpf', slug: 'shinonuma', name: 'Shi No Numa', horde: true },
  { zone: 'zombie_cosmodrome', slug: 'ascension', name: 'Ascension' },
  { zone: 'zombie_coast', slug: 'cotd', name: 'Call of the Dead' },
  { zone: 'zombie_temple', slug: 'shangrila', name: 'Shangri-La' },
  { zone: 'zombie_moon', slug: 'moon', name: 'Moon' },
];
const FIRST = 'zombie_pentagon';
export const MAPS = Object.fromEntries(MAP_LIST.map(m => [m.zone, { ...m,
  root: m.zone === FIRST ? BASE : BASE + m.slug + '/', opfs: m.zone === FIRST ? 'pack' : 'pack-' + m.slug,
  programs: BASE + 'artifacts/' + m.slug + '-programs.json', art: BASE + 'art/loadscreen_' + m.zone + '.webp',
  settings: m.slug + '-settings' }]));
const requested = globalThis.document?.documentElement?.dataset.map ??
  new URLSearchParams(globalThis.location?.search ?? '').get('map');
export const mapId = Object.hasOwn(MAPS, requested ?? '') ? requested : FIRST;
export const map = MAPS[mapId];
// hordetoggle: a map page with ?horde=1 (the landing's HORDE MODE toggle; the old /five-horde and /kino-horde pages redirect
// there) or <html data-mode="horde"> runs the horde mod's fixed game (horde.js HORDE_GAME); its workers get ?mode=horde.
// Same pack root and OPFS namespace as the map; its manifest is the map's plus the mods' small boot files
// (pack/web-manifest-horde.json), so a player who has the map fetches only those. Maps without horde: true ignore it.
const query = new URLSearchParams(globalThis.location?.search ?? '');
const requestedMode = globalThis.document?.documentElement?.dataset.mode ?? query.get('mode') ??
  (query.get('horde') === '1' ? 'horde' : null);
export const horde = requestedMode === 'horde' && !!map.horde;
export const packBase = map.root + 'pack/';
export const manifestUrl = horde ? packBase + 'web-manifest-horde.json' : map.root + 'manifest.json';
// r2direct (orch/R2DIRECT-NOTES.md): PACK_ORIGIN = origin of an R2 custom domain on the same bucket (e.g.
// 'https://cdn.vel.gg'); download-worker.js then fetches pack bytes (Brotli parts as <path>.br/<k>, whole files with Range)
// straight from R2 keys packs/<slug>/..., without a Worker request; the manifest, pages and videos stay on the Worker.
// '' = everything same-origin (the Worker), as before. ?packOrigin=0 forces the Worker; ?packOrigin=<origin> is honoured
// only on a loopback page (local tests). Integrity does not depend on the origin: every file is SHA-256-checked.
// cdn.vel.gg allows only the https://vel.gg origin (bucket CORS + the "cdn cors" Transform Rule), so other origins (local
// tests, workers.dev) keep the Worker unless a loopback page asks for ?packOrigin=<origin>.
export const PACK_ORIGIN = 'https://cdn.vel.gg';
const PACK_ORIGIN_FOR = 'https://vel.gg';
const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(globalThis.location?.hostname);
const packOrigin = query.get('packOrigin') === '0' ? ''
  : loopback ? query.get('packOrigin') || ''
  : globalThis.location?.origin === PACK_ORIGIN_FOR ? PACK_ORIGIN : '';
export const packCdn = packOrigin ? packOrigin.replace(/\/+$/, '') + '/packs/' + map.slug + '/' : '';
export const opfsRoot = '/opfs/' + map.opfs + '/files';
// Worker URLs carry the map so their OPFS namespace and pack root match the page's.
export const workerUrl = url => {
  const query = [mapId === FIRST ? '' : 'map=' + mapId, horde ? 'mode=horde' : '',
    packOrigin !== PACK_ORIGIN ? 'packOrigin=' + encodeURIComponent(packOrigin || '0') : ''].filter(Boolean).join('&');
  return query ? url + '?' + query : url;
};
