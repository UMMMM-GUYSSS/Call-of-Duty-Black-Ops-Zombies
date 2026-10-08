// Landing page (index.html): the game's map-select screen, listing only the maps this site runs (ENTRIES below).
// Nothing of a map is fetched here. A pick loads that map's own page into this document (same document, so the
// click's user activation carries over to the intro cinematic's sound), points the URL at it and imports play.js
// with __kisakLandingPick set: play.js then starts the download + intro as if its start key had been pressed.
// Only the picked map's manifest and pack are ever requested (maps.js reads <html data-map> at import).
//
// One entry per list row, top to bottom; only rows whose page is live (players can open them) belong here.
// Art (tools/web/mapselect/mksupported.py, from native captures of the game's own menu) is found by convention:
//   art/mapselect-row-<id>.webp    the row unfocused (450x40 band, drawn over the base art at the row's place)
//   art/mapselect-hl-<id>.webp     the row focused (white band, black label)
//   art/mapselect-panel-<id>.webp  the right side of the menu for that map (title, preview, description)
// href defaults to the id (the clean page URL /bo1z/<id> = site/<id>.html, a play.js page loaded into this document).
// flag: only listed with ?<flag>=1. description is the hotspot's accessible description (the art carries the visible one).
// horde: the map's pack ships the horde overlay (same flag as maps.js MAP_LIST horde; landing.js must not import maps.js,
// which picks its map once, at import, from the page play.js runs on).
export const ENTRIES = [
  { id: 'kino', label: 'Kino der Toten', horde: true,
    description: `Battle the undead in this theatrical installment of "Zombies". New twists and clues could uncover the final plan. It's show time!` },
  { id: 'five', label: '"Five"', horde: true, description: 'The Pentagon is under attack! Washington is going to DEFCON 1 in this installment of "Zombies".' },
  { id: 'riese', label: 'Der Riese', horde: true, description: 'The Giant is rising. Face the might of the Nazi Zombies in their heartland. This is where the master plan took shape. Is this where it all ends?' },
  // mapsall: packs built and tested in wt-mapderiese; each row stays behind ?<id>=1 until its pack is uploaded.
  { id: 'nacht', label: 'Nacht der Untoten', horde: true, description: 'The original: hold out in a small bunker against endless waves.' },
  { id: 'verruckt', label: 'Verrückt', horde: true, description: 'Fight through an abandoned asylum, split from your squad at the start.' },
  { id: 'shinonuma', label: 'Shi No Numa', horde: true, description: 'A swamp outpost with huts to open and zip lines over the marsh.' },
  { id: 'ascension', label: 'Ascension', description: 'A Soviet launch facility with lunar landers, monkeys and a rocket.' },
  { id: 'cotd', label: 'Call of the Dead', description: 'A frozen lighthouse and a stranded ship, with George A. Romero on the prowl.' },
  { id: 'shangrila', label: 'Shangri-La', description: 'A jungle temple full of traps, geysers and a minecart.' },
  { id: 'moon', label: 'Moon', description: 'From Area 51 to a lunar base: low gravity and no air outside.' },
];
// 1920x1080 art geometry: first row's band (strips are 40 px at a 42 px pitch; hotspots cover the full pitch) and the
// menu's right side, which changes with the focused map (mksupported.py PANEL).
const ROW = { x: 352, y: 259, w: 450, h: 40, pitch: 42 }, PANEL = [850, 240, 750, 720];
// hordetoggle: the HORDE MODE toggle's band near the bottom of the list panel (mksupported.py TOGGLE_Y).
const TOGGLE = { x: 352, y: 889, w: 450, h: 40 };
const query = new URLSearchParams(location.search);
// The map pages read ?horde=1 (maps.js); the landing forwards its own query (?perf=1 etc.) without it and adds it per pick.
const forwarded = new URLSearchParams(query); forwarded.delete('horde');
const entries = ENTRIES.filter(entry => !entry.flag || query.get(entry.flag) === '1');
// bo1z: clean page URLs (/bo1z/kino, /bo1z/five; the Worker and serve.mjs serve <name>.html there), base-relative (velgg).
const PAGES = Object.fromEntries(entries.map(entry => [entry.id, new URL(entry.href ?? entry.id, import.meta.url).pathname]));
const pct = (value, total) => `${(value / total * 100).toFixed(3)}%`;
const rect = (x, y, w, h) => `--x:${pct(x, 1920)};--y:${pct(y, 1080)};--w:${pct(w, 1920)};--h:${pct(h, 1080)}`;
const stage = document.querySelector('.stage');
const image = (className, src, style) => Object.assign(document.createElement('img'), { className, src, alt: '', style: style ?? '' });
// hordetoggle: HORDE MODE: OFF/ON in the game's list font on a band like the rows (art/mapselect-{row,hl}-horde-{off,on}
// .webp, mksupported.py), a switch button (mouse, or Tab then Enter/Space). Off by default; the choice is kept in
// localStorage (?horde=1/0 on the landing sets it for that visit). On, a pick of a map with horde: true opens
// <page>?horde=1 (horde.js HORDE_GAME: round 100, up to 300 zombies, no perk machines); with a map without the horde
// overlay selected the toggle shows dimmed and that map starts normally.
const HORDE_KEY = 'bo1z-horde';
let horde = query.get('horde') === '1', selected = null;
if (!query.has('horde')) try { horde = localStorage.getItem(HORDE_KEY) === '1'; } catch { /* storage disabled: off */ }
function pageUrl(entry) {
  const params = new URLSearchParams(forwarded);
  if (horde && entry.horde) params.set('horde', '1');
  const search = params.toString();
  return PAGES[entry.id] + (search ? '?' + search : '');
}
const toggle = Object.assign(document.createElement('button'), { id: 'horde-toggle', type: 'button' });
toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-label', 'Hell mode');
toggle.style.cssText = rect(TOGGLE.x, TOGGLE.y, TOGGLE.w, TOGGLE.h);
for (const state of ['off', 'on']) for (const kind of ['row', 'hl'])
  toggle.append(image(`${kind} ${state}`, `art/mapselect-${kind}-horde-${state}.webp`));
const note = Object.assign(document.createElement('span'), { id: 'horde-note', className: 'sr-only' });
toggle.setAttribute('aria-describedby', note.id);
function showToggle() {
  toggle.dataset.state = horde ? 'on' : 'off'; toggle.setAttribute('aria-checked', String(horde));
  const unavailable = Boolean(selected && !selected.horde);
  toggle.classList.toggle('unavailable', unavailable);
  note.textContent = unavailable ? `Hell mode is not available on ${selected.label} yet: it starts normally.`
    : 'Start on round 100 with up to 300 zombies at once and no perk machines.';
  toggle.title = note.textContent;
  for (const link of stage.querySelectorAll('a[data-pick]')) link.href = pageUrl(entries.find(entry => entry.id === link.dataset.pick));
}
toggle.addEventListener('click', () => {
  if (picked) return;
  horde = !horde; showToggle();
  try { localStorage.setItem(HORDE_KEY, horde ? '1' : '0'); } catch { /* not kept */ }
});
let picked = false;
entries.forEach((entry, index) => {
  const y = ROW.y + index * ROW.pitch, band = rect(ROW.x, y, ROW.w, ROW.h);
  stage.append(image('row', `art/mapselect-row-${entry.id}.webp`, band));
  // ids are pick-*: an element id "five" would shadow window.five (play.js state) on this page.
  const link = Object.assign(document.createElement('a'), { id: `pick-${entry.id}`, href: pageUrl(entry) });
  link.dataset.pick = entry.id; link.style.cssText = rect(ROW.x, y, ROW.w, ROW.pitch);
  link.setAttribute('aria-label', entry.label); link.setAttribute('aria-description', entry.description);
  const focus = Object.assign(document.createElement('div'), { className: 'focus' });
  focus.append(image('row', `art/mapselect-hl-${entry.id}.webp`, band),
    image('row', `art/mapselect-panel-${entry.id}.webp`, rect(...PANEL)));
  stage.append(link, focus);
  // The selection follows the pointer/keyboard and stays on the last row (no flicker between rows or when the
  // pointer leaves the list); the menu opens with the first row (Kino) focused, as the game does.
  const select = () => {
    for (const other of stage.querySelectorAll('.focus.selected')) other.classList.remove('selected');
    focus.classList.add('selected'); selected = entry; showToggle();
  };
  link.addEventListener('mouseenter', select); link.addEventListener('focus', select);
  if (index === 0) select();
});
stage.append(toggle, note); // after the rows: Tab reaches it after the maps
// fpsui: ?perf=1 shows the performance readout (perf-overlay.js; not even fetched otherwise).
if (new URLSearchParams(location.search).get('perf') === '1') import('./perf-overlay.js').then(m => m.startPerfOverlay()).catch(() => {});
async function pick(name) {
  if (picked) return;
  picked = true; document.body.classList.add('picked');
  const entry = entries.find(e => e.id === name), url = pageUrl(entry);
  try {
    const response = await fetch(PAGES[name]);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const page = new DOMParser().parseFromString(await response.text(), 'text/html'), root = document.documentElement;
    if (page.documentElement.dataset.map) root.dataset.map = page.documentElement.dataset.map; else delete root.dataset.map;
    if (horde && entry.horde) root.dataset.mode = 'horde'; else delete root.dataset.mode; // maps.js: the horde game
    document.title = page.title + (root.dataset.mode === 'horde' ? ': Hell mode' : '');
    const sheets = [];
    for (const element of page.head.querySelectorAll('link[rel=stylesheet], link[rel=preload], style')) {
      const node = document.importNode(element, true);
      if (node.rel === 'stylesheet') sheets.push(new Promise(resolve => { node.onload = node.onerror = resolve; }));
      document.head.append(node);
    }
    await Promise.all(sheets);
    for (const element of document.head.querySelectorAll('[data-landing]')) element.remove();
    for (const script of page.body.querySelectorAll('script')) script.remove();
    document.body.replaceWith(document.importNode(page.body, true));
    history.pushState(null, '', url); // perf7: keep ?dumpPipelines=1 etc. (the pipe reads the page query); ?horde=1
    globalThis.__kisakLandingPick = name;
    await import('./play.js');
  } catch (error) {
    console.error('landing pick failed, opening the map page', error);
    location.assign(url);
  }
}
// Back from a map returns to a fresh landing page (the engine cannot be unloaded in place).
addEventListener('popstate', () => location.reload());
for (const link of document.querySelectorAll('a[data-pick]')) {
  link.addEventListener('click', event => {
    if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); pick(link.dataset.pick);
  });
}
