import { map, packBase, workerUrl, BASE, horde as hordePage } from './maps.js';
import { createEngine, rendererRoute, rendererChoice, glslPack } from './engine.js';
import { checkCapabilities } from './capabilities.js';
import { sizeGameCanvas } from './canvas.js';
import { startTelemetry } from './telemetry.js';
import { hordeCount, hordeRound, hordeDefaults, HORDE_MIN, HORDE_MAX, HORDE_GAME } from './horde.js';

const $ = id => document.getElementById(id);
const canvas = $('game'), play = $('play');
const state = window.five = { timings: { pageLoad: performance.now() }, events: [], errors: [],
  console: [], consoleErrors: 0, scriptExceptions: 0, glErrors: 0,
  inputEvents: 0, inputDropped: 0, audioFrames: 0, interactive: false, rendererRoute };
const telemetry = startTelemetry(state);
// fpsui: ?perf=1 shows the performance readout (perf-overlay.js; not even fetched otherwise).
if (new URLSearchParams(location.search).get('perf') === '1') import('./perf-overlay.js').then(m => m.startPerfOverlay()).catch(() => {});
const mb = bytes => (bytes / 1e6).toFixed(1) + ' MB';
// What actually crosses the network: brotli/opus transport chunks (entry.br) where the pack has them, else the raw file.
// manifest.total_bytes is the unpacked size on disk (~2.8x larger for Five), which overstated the download.
const wireBytes = manifest => (manifest.files ?? []).reduce((sum, f) =>
  sum + (Array.isArray(f?.br) ? f.br.reduce((a, b) => a + b, 0) : f?.size ?? 0), 0) || manifest.total_bytes;
const PRESS = 'Click to start';
// hordetoggle: the horde game (?horde=1, maps.js) names itself, with the notice the old five-horde.html page showed.
if (hordePage) {
  if (!/: Hell mode$/.test(document.title)) document.title += ': Hell mode';
  const notice = Object.assign(document.createElement('p'), { className: 'notice',
    textContent: `Hell mode: up to ${HORDE_GAME.n} zombies at once, starting on round ${HORDE_GAME.round}, no perk machines.` });
  $('details').after(notice);
}
// loadvol: the loading screen's sound (the intro cinematic, also once the engine adopts it) plays at 10% gain (-20 dB, about a quarter of the loudness) unless the
// player has set Master Volume in Options (then at that volume); in game the cinematics are back to full (enter()).
const LOAD_VOLUME = 0.1; // ~-20 dB = about a quarter as loud as full (0.25 amplitude still sounded loud to the user)
let volumeChosen = false;
const testMuted = () => Boolean(globalThis.__kisakParity?.muted || globalThis.__kisakMuted);
const loadVolume = () => testMuted() ? 0 : volumeChosen ? Math.min(1, Number($('volume').value)) : LOAD_VOLUME;
// The engine's cinematic master (video_bridge.js kbVideoMaster: element volume = Bink gain x master).
function videoMaster(value) { state.videoMaster = value; engine?.videoMaster?.(value); }
// Pack root, as fetched by download-worker.js; streamed cinematics (manifest.streams) are range-requested from it.
state.packBase = packBase;
// Intro cinematic: the pack's "<map>_load" stream starts muted on the landing screen, restarts with sound on the
// start key/click (the user gesture), keeps playing while the pack downloads, and is then adopted by the engine's
// load cinematic (src/web/browser/video_bridge.js), which continues the same element from its current position.
let intro;
function introSetup(manifest) {
  if (intro || globalThis.__kisakNoIntro) return;
  const variants = (manifest?.streams ?? []).filter(s => s.kind === 'video' && /_load$/.test(s.name ?? ''));
  if (!variants.length) return;
  const video = document.createElement('video'), name = variants[0].name;
  video.id = 'intro'; Object.assign(video, { muted: true, playsInline: true, preload: 'auto', crossOrigin: 'anonymous' });
  for (const v of variants.filter(v => v.name === name)) {
    const source = document.createElement('source'); source.src = state.packBase + v.path; source.type = v.mime; video.append(source);
  }
  intro = globalThis.__kisakIntro = { name, video };
  state.timings.introSetup = performance.now();
  video.requestVideoFrameCallback(() => { state.timings.introFirstFrame = performance.now(); });
  $('overlay').before(video); document.body.classList.add('intro');
  video.addEventListener('ended', () => { if (intro.started) introFinish('ended'); });
  // Once finished, it stays silent and still, whoever asks it to play again (an engine loop/rewind, an old bridge).
  video.addEventListener('playing', () => { if (intro.finished) { video.muted = true; video.pause(); } });
  video.play().catch(() => {});
}
function introStart() {
  if (!intro || intro.started || intro.adopted) return;
  const video = intro.video, muted = globalThis.__kisakParity?.muted || globalThis.__kisakMuted;
  intro.started = true; state.timings.introStart = performance.now();
  // video2: from the start key the cinematic IS the picture (download, engine load, post-load), as native: the
  // element is above the engine canvas and nothing dims it (play.css body.cinematic) until it ends or is skipped.
  document.body.classList.add('cinematic');
  video.requestVideoFrameCallback(() => { state.timings.introStartFrame = performance.now(); });
  state.loadVolume = loadVolume(); videoMaster(state.loadVolume);
  video.currentTime = 0; video.volume = muted ? 0 : state.loadVolume; video.muted = !!muted;
  video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });
}
function introRetire() {
  if (!intro || intro.adopted || !intro.video.isConnected) return;
  intro.video.muted = true; intro.video.pause(); intro.video.remove(); document.body.classList.remove('intro', 'cinematic');
}
// End or skip: picture and sound stop at once (no fade, no tail) and whatever is below shows: the engine's frame,
// its native loadscreen, or the page's loadscreen art before the engine presents. The element jumps to its end, so
// the engine's adopted stream (video_bridge.js) reports "finished" and never restarts it.
function introFinish(reason) {
  if (!intro || intro.finished) return;
  const video = intro.video;
  intro.finished = reason; state.timings.introFinished = performance.now(); state.introFinish = { reason, t: video.currentTime, screen: state.screen };
  video.muted = true; video.volume = 0; video.pause();
  video.classList.add('finished'); document.body.classList.remove('cinematic', 'intro'); // ready: the art again
  engine?.introReady?.(); // intro6: the engine's held zombies intro may run now
  if (reason !== 'ended' && reason !== 'closed') {
    intro.skipped = true;
    if (Number.isFinite(video.duration) && !video.ended) try { video.currentTime = video.duration; } catch { /* not seekable yet */ }
  }
}
// The cinematic only ends early once the game has loaded: while it still downloads/loads, keys and clicks leave it
// playing (skipping would only show the loadscreen). Once loaded, the "Click to start" click/key (enter()) ends it and
// starts the game; a later key or click while it still plays (engine-adopted stream) ends it too.
function introSkip(event) {
  if (!intro?.started || intro.finished || event.repeat || /^(Control|Alt|Meta|Shift|Tab|F\d+)$/.test(event.key ?? '')) return;
  if (state.screen === 'playing' && intro.adopted) introFinish('skip');
}
document.addEventListener('keydown', introSkip, true);
document.addEventListener('mousedown', () => {
  if (intro?.started && !intro.finished && state.screen === 'playing') introFinish('skip');
}, true);
let downloader, engine, cacheStatus, downloading = false, locking = false, permissionToEvict = false;

function button(label, action, secondary = false) {
  const element = secondary ? $('secondary') : play;
  element.textContent = label; element.hidden = !action; element.disabled = false;
  element.onclick = action ? () => Promise.resolve().then(action).catch(error => errorScreen('engine', error.message)) : null;
}
// Activation-sensitive actions must run directly within the event handler.
function activationButton(label) {
  play.textContent = label; play.hidden = false; play.disabled = false;
  play.onclick = enter;
}
function screen(name, title, detail = '') {
  state.screen = name; document.body.dataset.screen = name;
  $('status').textContent = title; $('details').textContent = detail;
  $('transfer').hidden = name !== 'download' && name !== 'loading'; $('loading').hidden = true; // onebar: one bar for both
  $('error-message').hidden = true; $('error-debug').hidden = true; $('secondary').hidden = true;
  $('resume-hint').hidden = true;
  if (name === 'ready' || name === 'playing' || name === 'error') introRetire();
  $('settings').hidden = ['download', 'loading', 'playing', 'error'].includes(name);
  if (name === 'loading' || name === 'download') { play.hidden = true; $('settings').open = false; }
}
function errorScreen(kind, message) {
  if (kind === 'engine') {
    document.exitPointerLock();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    engine?.stop().catch(() => {});
  }
  state.errorKind = kind;
  screen('error', { secure: 'Secure connection required', browser: 'Unsupported browser', mobile: 'Desktop required', gpu: 'Unsupported graphics',
    quota: 'Not enough storage', storage: 'Storage disabled', persistence: 'Save game data?',
    download: 'Download interrupted', engine: 'Error' }[kind] ?? 'Error');
  $('error-message').textContent = message; $('error-message').hidden = false;
  if (kind === 'persistence') {
    button('Continue', () => { permissionToEvict = true; begin(); });
    button('Try again', begin, true);
  } else if (kind === 'download') button('Resume', () => cacheStatus ? begin() : inspect());
  else if (kind === 'quota') button('Try again', begin);
  else button('Reload', () => location.reload());
}
function setBar(id, fraction) {
  if (fraction === null) $(id).removeAttribute('value');
  else $(id).value = fraction;
}
// onebar: ONE progress bar (#progress, where the download bar always was) for the whole wait from the start click to
// the "press any key" prompt: download and engine load together, a monotonic percentage and an estimated time left.
// Weighted model: P = wd * D + (1 - wd) * E. D = verified boot bytes; E = engine load phases (wasm, main, the fastfile
// zones weighted by size as the engine reports them, engine-initialized, map-loaded). wd is fixed at the first
// download progress from the expected download time at the calibration link (90 Mbit/s) vs ENGINE_S, so a cold
// visit is ~60% download / ~40% load and a warm visit is 100% load. ETA = boot bytes left / measured rate + (1 - E) *
// ENGINE_S, smoothed; ENGINE_S = engine time from start to map-loaded (warm Five ~30 s from the click; cold tail after boot-ready ~20-23 s at 90 Mbit).
const ENGINE_S = map.engineS ?? 27, REF_RATE = 90e6 / 8;
const bar = state.loadbar = { pct: 0, eta: null, phase: '', samples: [] };
let barRun = null;
function barStart() {
  if (barRun) return;
  barRun = { t0: performance.now(), shown: 0, eta: null, last: performance.now(), dl: null, rates: [], wd: 0, sizes: null, sampled: 0 };
  barTick(); barRun.timer = setInterval(barTick, 250);
}
function barDownload(data) {
  const run = barRun; if (!run) return; const now = performance.now();
  if (!run.dl) { run.dl = { c0: data.completed, total: data.total, t: now };
    run.wd = Math.max(0, Math.min(.85, (data.total - data.completed) / REF_RATE / ((data.total - data.completed) / REF_RATE + ENGINE_S))); }
  run.dl.completed = data.completed; run.dl.total = data.total;
  run.rates.push([now, data.completed]); while (run.rates.length > 2 && now - run.rates[0][0] > 8000) run.rates.shift();
}
function engineFraction() {
  const t = state.timings, run = barRun;
  if (!run.sizes && state.manifest) { run.sizes = new Map(state.manifest.files.filter(f => /\.ff$/i.test(f.path)).map(f => [f.path.split('/').pop().replace(/\.ff$/i, ''), f.size]));
    run.sizes.total = [...run.sizes.values()].reduce((a, b) => a + b, 0); }
  let e = t.engineStart ? .02 : 0; if (t.wasmReady) e = .08; if (t.callMain) e = .1;
  if (run.sizes?.total) { let done = 0; for (const z of Object.keys(state.zoneTimes ?? {})) done += run.sizes.get(z) ?? 0;
    if (done) e = Math.max(e, .1 + .8 * Math.min(1, done / run.sizes.total)); }
  if (t.engineInitialized) e = Math.max(e, .92);
  // warmgate: map loaded, the prompt waits for the GPU pipeline warm-up (engine.js warmGate): the last 8% follow it.
  if (t.mapLoaded && state.warmHolding) return .92 + .08 * warmFraction();
  return t.mapLoaded ? 1 : e;
}
// warmgate: the seeded warm-up is running (the prompt will wait for it), its progress (engines with the progress hook; 0
// otherwise) and its time left at the measured rate (null without the hook).
const warmPending = () => { const w = state.warm; return Boolean(w?.started && Number(w.seed) > 0 && w.rows > 0 && !w.finished); };
// Without the hook the held bar creeps with the clock towards the gate's cap (engine.js WARM_HOLD_MS).
function warmFraction() {
  const w = state.warm, of = w?.total || w?.rows, t = state.timings;
  if (w?.progress && of) return Math.min(1, (w.done + w.failed) / of);
  return state.warmHolding && state.warmHoldUntil ? .9 * Math.min(1, (performance.now() - t.mapLoaded) / (state.warmHoldUntil - t.mapLoaded)) : 0;
}
function warmEta() {
  const w = state.warm, of = w?.total || w?.rows, settled = (w?.done ?? 0) + (w?.failed ?? 0), since = state.timings.warmStart;
  if (!w?.progress || !of || !settled || !since) return null;
  const left = (of - settled) / (settled / Math.max(.1, (performance.now() - since) / 1000));
  return Math.max(0, state.warmHolding && state.warmHoldUntil ? Math.min(left, (state.warmHoldUntil - performance.now()) / 1000) : left);
}
function barTick() {
  const run = barRun; if (!run) return; const now = performance.now(), dt = (now - run.last) / 1000; run.last = now;
  const dl = run.dl, booted = Boolean(state.boot), e = engineFraction();
  const d = booted || !dl ? (dl || booted ? 1 : 0) : (dl.completed - dl.c0) / Math.max(1, dl.total - dl.c0);
  const model = run.wd * d + (1 - run.wd) * e;
  let rem = null;
  const span = run.rates.length > 1 ? run.rates.at(-1)[0] - run.rates[0][0] : 0;
  if (!booted && dl && span >= 2500) {
    // Recent rate (8 s), floored at 60% of the average so far: a short stall raises the ETA gently, not to minutes.
    const rate = Math.max((run.rates.at(-1)[1] - run.rates[0][1]) / (span / 1000), .6 * (dl.completed - dl.c0) / Math.max(1, (now - dl.t) / 1000));
    rem = (dl.total - dl.completed) / Math.max(rate, 1e5) + (1 - e) * ENGINE_S;
  } else if (booted || cacheStatus?.ready) rem = (1 - e) * ENGINE_S;
  const pending = warmPending(), warmLeft = pending ? warmEta() : null; // warmgate: the prompt waits for the slower of both
  if (warmLeft !== null) rem = Math.max(rem ?? 0, warmLeft);
  if (rem !== null && now - run.t0 >= 3000) {
    run.eta = run.eta === null ? rem : Math.max(0, run.eta - dt);
    // Smoothed: follows good news quickly, bad news slowly (at most +0.5 s per second net of the clock).
    run.eta += rem < run.eta ? .1 * (rem - run.eta) : Math.min(.05 * (rem - run.eta), 1.5 * dt);
  }
  // Creep with the clock inside long phases (a big zone loads with no event), never more than 12 points past the model.
  const elapsed = (now - run.t0) / 1000, timed = run.eta === null ? 0 : elapsed / (elapsed + run.eta);
  const holding = Boolean(state.timings.mapLoaded && state.warmHolding);
  if (holding && warmLeft === null) run.eta = null; // warmgate: unknown without the progress hook (no time shown)
  // warmgate: while the warm-up runs, the last 8% are its own (the bar never passes .92 + .08 x its progress).
  const cap = pending ? .92 + .08 * warmFraction() : .99;
  run.shown = Math.max(run.shown, Math.min(cap, Math.max(model, Math.min(timed, model + (holding ? 0 : .12)))));
  // The engine's native loadscreen draws its own load bar (UI_DrawLoadBar). Once it is visible (loading screen, the intro
  // cinematic ended or skipped, the engine presenting) our bar graphic steps aside and only the % / time text stays:
  // one bar on screen, and the game's own screen is left unchanged. Once the map is loaded that loadscreen is gone (warmgate).
  bar.native = state.screen === 'loading' && !document.body.classList.contains('cinematic') && Boolean(state.timings.firstPresent) && !state.timings.mapLoaded;
  $('progress').hidden = bar.native;
  const w = state.warm, of = w?.total || w?.rows;
  render(holding ? 'Preparing graphics' : booted || !dl ? 'Loading' : 'Downloading', Math.floor(run.shown * 100), run.eta,
    holding && w?.progress && of ? `${w.done + w.failed} / ${of}` : null);
  if (now - run.sampled >= 1000) { run.sampled = now; bar.samples.push({ t: +(elapsed).toFixed(1), pct: bar.pct, eta: bar.eta, phase: bar.phase, d: +d.toFixed(3), e: +e.toFixed(3) }); }
}
function render(phase, pct, eta, count = null) {
  Object.assign(bar, { phase, pct, eta: eta === null ? null : Math.round(eta) });
  const left = eta === null ? '' : eta < 8 ? ' · almost done' : eta < 60 ? ` · about ${Math.max(5, Math.round(eta / 5) * 5)} s left`
    : ` · about ${Math.round(eta / 60)} min left`;
  setBar('progress', pct / 100); $('transfer-details').textContent = `${phase} ${count ?? pct + '%'}${left}`;
}
function barDone() {
  $('progress').hidden = false; bar.native = false;
  if (!barRun) return; clearInterval(barRun.timer); render('Loading', 100, 0);
  bar.samples.push({ t: +((performance.now() - barRun.t0) / 1000).toFixed(1), pct: 100, eta: 0, phase: 'ready' }); barRun = null;
}
function progressText(data) {
  const eta = data.eta === null ? 'Verifying' : data.eta < 60 ? `${Math.ceil(data.eta)} s` : `${Math.ceil(data.eta / 60)} min`;
  return `${mb(data.completed)} / ${mb(data.total)} · ${eta}`;
}
function ready() {
  if (state.screen === 'error' && state.errorKind === 'engine') return;
  barDone(); screen('ready', '');
  activationButton(PRESS);
}
state.onProgress = data => {
  if (state.screen === 'error' && state.errorKind === 'engine') return;
  if (data.stage === 'ready' && data.fraction === 1) { ready(); return; }
  if (state.screen !== 'loading') return;
  $('load-details').textContent = data.label || data.stage; // detail only; the one bar is #progress (barTick)
};
// quitmenu: the in-game Quit / End Game menus return to the map select page (engine.js quit()).
state.onQuit = () => {
  document.exitPointerLock?.();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  engine?.stop().catch(() => {});
  location.assign(BASE);
};
state.onCrash = (message, detail = {}) => {
  if (state.quit) return; // teardown noise after a quit (engine.js quit())
  // Telemetry keeps secondary traps too; the page shows only the first failure.
  telemetry.crash(message, detail);
  if (state.screen === 'error' && state.errorKind === 'engine') return;
  state.crashScreen = state.screen;
  errorScreen('engine', /out of memory|\bOOM\b|allocat.*memory|memory.*allocat/i.test(message)
    ? `${map.name} could not reserve enough memory. Close other tabs and apps, then reload in a 64-bit desktop browser. The game needs a 1.5 GiB heap plus room for graphics and sound. Your verified download is saved.`
    : 'The game engine stopped unexpectedly. Reload to try again. Your verified download is saved. If it happens again, share the error details with the host.');
  showCrashReport(message, detail);
};
// wasmexc: a C++ exception or longjmp escaping a pthread reaches the page only as "[object WebAssembly.Exception]".
// The details show a full report instead: the engine's KISAK_FATAL cause (printed before it throws), the browser and
// renderer route, and the last 40 engine console lines, with a Copy button so players can paste the whole thing.
function crashReport(message, detail) {
  const lines = (state.console ?? []).slice(-40).map(row => (row.error ? '! ' : '  ') + String(row.message).slice(0, 400));
  const fatal = (state.console ?? []).findLast?.(row => /KISAK_FATAL|^ERROR:|Com_Error/.test(row.message));
  return [
    fatal ? 'Cause: ' + String(fatal.message).replace(/^KISAK_FATAL\s*/, '') : null,
    'Error: ' + message,
    detail.source ? 'Source: ' + detail.source : null,
    `Page: ${location.pathname}${location.search}`,
    `Browser: ${navigator.userAgent}`,
    `Renderer: ${state.renderer ?? '?'} (route ${state.rendererRoute ?? '?'}${state.rendererDetail ? ', ' + state.rendererDetail : ''})`,
    `Screen before error: ${state.crashScreen ?? '?'}; time ${Math.round(performance.now() / 1000)} s`,
    detail.stack && detail.stack !== message ? 'Stack: ' + String(detail.stack).slice(0, 1500) : null,
    `Engine console (last ${lines.length}):`, ...lines,
  ].filter(line => line !== null).join('\n');
}
function showCrashReport(message, detail) {
  const render = () => { state.crashReport = crashReport(message, detail); $('error-debug-message').textContent = state.crashReport; };
  render();
  // Console lines posted by the throwing worker just before its error event may still be in flight.
  setTimeout(render, 750);
  let copy = $('error-copy');
  if (!copy) {
    copy = document.createElement('button');
    copy.id = 'error-copy'; copy.type = 'button'; copy.className = 'option'; copy.textContent = 'Copy error report';
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(state.crashReport); copy.textContent = 'Copied'; }
      catch { getSelection().selectAllChildren($('error-debug-message')); copy.textContent = 'Press Ctrl+C to copy'; }
    };
    $('error-debug').append(copy);
  }
  $('error-debug').hidden = false;
}
window.addEventListener('error', event => state.onCrash(event.error?.message ?? event.message,
  { stack: event.error?.stack ?? null, source: `window-error ${event.filename ?? ''}:${event.lineno ?? ''}:${event.colno ?? ''}` }));
window.addEventListener('unhandledrejection', event => state.onCrash(event.reason?.message ?? String(event.reason),
  { stack: event.reason?.stack ?? null, source: 'unhandledrejection' }));

// webmods: the mods a map's pack ships (manifest paths mods/<name>/..., plus mods/_stack, the shared hook files the
// engine adds under any fs_mods) get an Options checkbox; the ticked ones start the engine with fs_mods (engine.js).
// Only mods named here are offered; a pack without a mod never shows it, so the engine is never asked for a missing one.
const MODS = { horde: 'Hell mode: more zombies at once', zinfo: 'Tab: zombie counter' };
let savedMods = [], modBoxes = null, savedHorde = { ...hordeDefaults }, hordeFields = null;
function packMods(manifest) {
  const files = manifest?.files ?? [];
  if (!files.some(f => /^mods\/_stack\//i.test(f.path))) return [];
  return Object.keys(MODS).filter(name => files.some(f => f.path.toLowerCase().startsWith(`mods/${name.toLowerCase()}/`)));
}
function showMods(manifest) {
  if (modBoxes || hordePage) return; // webhorde: the horde page's mods are fixed (engine.js)
  modBoxes = packMods(manifest).map(name => {
    const label = document.createElement('label'), box = document.createElement('input');
    label.className = 'check'; box.type = 'checkbox'; box.dataset.mod = name; box.checked = savedMods.includes(name);
    box.addEventListener('input', saveSettings);
    label.append(box, ' ' + MODS[name]); $('settings-note').before(label);
    if (name === 'horde') hordeOptions(box);
    return box;
  });
}
// horde: max zombies alive at once (24..1024; the mod's unlimited) and the round to start on, under its checkbox.
function hordeOptions(box) {
  const field = (label, value, min, max, clamp) => {
    const row = document.createElement('label'), input = document.createElement('input');
    row.className = 'horde-field'; input.type = 'number'; input.min = min; input.max = max; input.step = 1; input.value = value;
    input.addEventListener('change', () => { input.value = clamp(input.value); saveSettings(); });
    row.append(label, input); $('settings-note').before(row);
    return input;
  };
  hordeFields = { n: field('Max zombies', savedHorde.n, HORDE_MIN, HORDE_MAX, hordeCount),
    round: field('Start round', savedHorde.round, 1, 255, hordeRound) };
  const show = () => { for (const input of Object.values(hordeFields)) input.parentElement.hidden = !box.checked; };
  box.addEventListener('input', show); show();
}
function hordeSettings() {
  return hordeFields ? { n: hordeCount(hordeFields.n.value), round: hordeRound(hordeFields.round.value) } : savedHorde;
}
function settings() {
  return { sensitivity: Number($('sensitivity').value), volume: Number($('volume').value), fullscreen: $('fullscreen').checked,
    mods: modBoxes ? modBoxes.filter(box => box.checked).map(box => box.dataset.mod) : savedMods, horde: hordeSettings() };
}
try {
  const saved = JSON.parse(localStorage.getItem(map.settings));
  if (saved && Number.isFinite(saved.sensitivity)) $('sensitivity').value = saved.sensitivity;
  // volume50: a saved volume only counts if the player moved the slider (older saves stored the 0.8 default with every setting).
  if (saved?.volumeChosen === true && Number.isFinite(saved.volume)) $('volume').value = saved.volume;
  $('fullscreen').checked = saved?.fullscreen === true;
  if (Array.isArray(saved?.mods)) savedMods = saved.mods.filter(name => Object.hasOwn(MODS, name));
  if (saved?.horde) savedHorde = { n: hordeCount(saved.horde.n), round: hordeRound(saved.horde.round) };
  volumeChosen = saved?.volumeChosen === true;
} catch { /* Site storage may be disabled; defaults remain usable. */ }
function saveSettings() {
  $('sensitivity-value').value = Number($('sensitivity').value).toFixed(1);
  $('volume-value').value = Math.round(Number($('volume').value) * 100) + '%';
  try { localStorage.setItem(map.settings, JSON.stringify({ ...settings(), volumeChosen })); } catch { /* Optional preference cache. */ }
}
for (const id of ['sensitivity', 'volume', 'fullscreen']) $(id).addEventListener('input', saveSettings);
$('volume').addEventListener('input', () => { volumeChosen = true; saveSettings(); }); // loadvol: the player's own choice
saveSettings();

// size2: manifest "lazy" files the worker fetches with boot: the GLSL pack only when WebGL2 is chosen.
// load4: ?dlorder=b1 = previous boot order (A/B); ?bgHold=0 = background download right after boot (A/B).
const loadParams = new URLSearchParams(location.search);
const post = (worker, type) => rendererChoice().then(choice => worker.postMessage({ type, order: overlapB0 ? 'b0' : (loadParams.get('dlorder') || globalThis.__kisakDlOrder || 'b3'),
  holdBackground: overlap && (loadParams.get('bgHold') ?? globalThis.__kisakBgHold ?? '1') !== '0', want: state.want = choice.renderer === 'webgl2' ? [glslPack] : [], delay: dlDelay }));
// overlap: start the engine as soon as the manifest is known; it opens each boot file only after the worker reports it
// verified (file-ready -> KB_PackReady, src/web/browser/pack_gate.cpp). ?overlap=0 keeps the old start at boot-ready.
// bootfix (test only): ?dlDelay=<path>:<ms> (or globalThis.__kisakDlDelay) delays one pack file in the download worker.
const dlDelay = (raw => { const m = /^(.+):(\d+)$/.exec(raw ?? ''); return m ? { path: m[1], ms: Number(m[2]) } : null; })(
  loadParams.get('dlDelay') ?? globalThis.__kisakDlDelay);
const overlap = new URLSearchParams(location.search).get('overlap') !== '0' && !globalThis.__kisakNoOverlap;
// integ12 A/B: ?overlap=b0 = first overlap variant (root+main before shaders, no early zone stat); default = b1.
const overlapB0 = new URLSearchParams(location.search).get('overlap') === 'b0';
function packGate(manifest) {
  let resolve; const bootReady = new Promise(r => { resolve = r; });
  const want = state.want ?? [];
  const paths = manifest.files.filter(f => f.priority === 'boot' || (f.priority === 'lazy' && want.includes(f.path))).map(f => f.path);
  // Zone sizes are final (no fallback variant): the gate may answer a stat of a pending zone without waiting.
  const sizes = overlapB0 ? new Map() : new Map(manifest.files.filter(f => paths.includes(f.path) && /\.ff$/i.test(f.path) && !f.fallback).map(f => [f.path, f.size]));
  const gate = { paths, sizes, ready: new Set(), bootReady, resolve, done: false };
  // The Emscripten module (2 GiB heap views) stays off the enumerable state: window.five is JSON-serialized by tools
  // (test-play snapshotEngine), and stringifying the heap threw "RangeError: Invalid array length" on every cold run.
  Object.defineProperty(gate, 'module', { value: null, writable: true, enumerable: false });
  // bootfix: callbacks run on every file-ready and on boot-ready (engine.js waits for root files before callMain).
  Object.defineProperty(gate, 'waiters', { value: new Set(), enumerable: false });
  return gate;
}
function gateCall(name, path) {
  const module = state.packGate?.module; if (!module?.[name]) return;
  const bytes = new TextEncoder().encode(path ?? ''), address = module._malloc(bytes.length + 1);
  if (!address) return;
  const heap = new Uint8Array(module.HEAPF32.buffer, address, bytes.length + 1); heap.set(bytes); heap[bytes.length] = 0;
  module[name](address); module._free(address);
}
let idleDownloader = null; // load5: the inspect worker, reusable by begin()
function newDownloader() {
  idleDownloader = null; downloader?.terminate();
  downloader = new Worker(workerUrl(BASE + 'engine-download-worker.js'), { type: 'module' });
  downloader.onerror = event => { event.preventDefault(); downloadError(event.message || 'The download worker could not start. Reload this page and allow site storage.', ''); };
  downloader.onmessage = ({ data }) => {
    if (data.type !== 'progress' && data.type !== 'file-ready') state.events.push(data);
    if (data.type === 'manifest' && overlap && downloading && !state.boot) {
      state.manifest = data.manifest; state.timings.manifest = performance.now();
      if (!state.packGate) state.packGate = packGate(data.manifest);
      if (!engine) loadEngine();
    } else if (data.type === 'file-ready') {
      const gate = state.packGate; if (!gate) return;
      gate.ready.add(data.path); (state.fileReady ??= {})[data.path] = Math.round(performance.now());
      if (gate.module) gateCall('_KB_PackReady', data.path);
      for (const waiter of [...gate.waiters]) waiter();
    }
    if (data.type === 'cache-status') {
      cacheStatus = data; state.manifest = data.manifest; idleDownloader = downloader;
      introSetup(data.manifest); showMods(data.manifest);
      state.timings.playAvailable = performance.now();
      screen('landing', '', data.ready ? (data.missingBytes ? `Music and voices: ${mb(data.missingBytes)}` : '')
        : `Download ${mb(wireBytes(data.manifest))}`);
      button('Press any key to start', begin);
      // Map pick on the landing page (index.html, landing.js): that click is the start key, so start at once.
      if (globalThis.__kisakLandingPick) { delete globalThis.__kisakLandingPick; begin(); }
    } else if (data.type === 'progress') {
      if (data.priority === 'boot' && !state.boot) {
        barDownload(data);
      } // onebar: music/voices continue silently after boot (no second bar); #background only shows a pause + Retry.
    } else if (data.type === 'boot-ready') {
      state.boot = data.metrics; state.timings.bootReady = performance.now(); state.manifest = data.manifest;
      // Show the pending sound transfer before its first network progress event.
      // Slow connections can otherwise leave an invisible background download.
      if (state.packGate && !state.packGate.done) {
        state.packGate.done = true; state.packGate.resolve();
        if (state.packGate.module?._KB_PackReleaseAll) state.packGate.module._KB_PackReleaseAll();
        state.packGate.module = null;
        for (const waiter of [...state.packGate.waiters]) waiter();
        if (state.screen === 'download') screen('loading', '');
      }
      if (!engine) loadEngine();
    } else if (data.type === 'complete') {
      state.result = data.metrics; downloading = false; $('background').hidden = true; downloader.terminate();
      engine?.lateIwds?.(); // music/voice IWDs that landed after the engine indexed main/
    } else if (data.type === 'error') downloadError(data.message, data.name);
  };
}
function downloadError(message, name) {
  telemetry.error('download', `${name ?? ''} ${message}`);
  downloading = false; idleDownloader = null; downloader?.terminate(); state.errors.push(message);
  if (state.boot) {
    $('background').hidden = false; $('background-label').textContent = `Music and voices paused: ${message}`;
    $('background-retry').hidden = false; return;
  }
  const kind = name === 'QuotaExceededError' ? 'quota' : /SecurityError|NotAllowedError/.test(name) ? 'storage' : 'download';
  if (barRun) { clearInterval(barRun.timer); barRun = null; }
  // verifyfix: OPFS read/write failures are local storage trouble, not the connection.
  errorScreen(kind, kind === 'quota' ? 'Browser storage is full. Free disk space or remove unused site data in your browser settings, then retry. Saved partial files will resume.'
    : kind === 'storage' ? 'Allow this site to save files in your browser settings, then reload.'
    : /^OPFS /.test(message) ? `${message}\nYour browser could not read or write the saved game files. Close other tabs of this site, free some disk space and retry. If it happens again, clear this site's data (the icon left of the address, then Site settings, Delete data) and retry.`
    : `${message}\nCheck your connection and retry. Saved partial files will resume.`);
}
function inspect() {
  screen('landing', ''); play.textContent = 'Loading'; play.hidden = false; play.disabled = true;
  newDownloader(); post(downloader, 'inspect');
}
async function begin() {
  if (downloading) return;
  introStart();
  play.disabled = true;
  try {
    if (cacheStatus.missingBytes) {
      const estimate = await navigator.storage.estimate();
      state.storage = estimate;
      if ((estimate.quota ?? Infinity) - (estimate.usage ?? 0) < cacheStatus.missingBytes) {
        errorScreen('quota', `${map.name} needs up to ${mb(cacheStatus.missingBytes)} of browser storage. Free disk space or remove unused site data in your browser settings, then check again.`); return;
      }
      // Ask silently; if the browser declines, keep going without persistent storage (no prompt screen).
      try { state.persist = await navigator.storage.persist(); } catch { state.persist = false; }
    }
    downloading = true;
    if (state.videoMaster === undefined) videoMaster(loadVolume()); // loadvol: also with no intro element
    screen(cacheStatus.ready ? 'loading' : 'download', '');
    setBar('progress', 0); $('transfer-details').textContent = cacheStatus.ready ? 'Loading 0%' : 'Downloading 0%';
    barStart();
    // load5: keep the worker that just inspected the cache (it holds the manifest, see download-worker.js) instead of
    // terminating it and starting a new one; any other path (retry, error) still starts a fresh worker.
    if (!idleDownloader || idleDownloader !== downloader) newDownloader();
    idleDownloader = null; post(downloader, 'download');
  } catch (error) { play.disabled = false; downloadError(error.message, error.name); }
}
async function loadEngine() {
  state.timings.loadEngine = performance.now();
  if (state.screen !== 'download' || state.boot) screen('loading', ''); // overlap: keep the download bar until boot-ready
  setBar('load-progress', null);
  $('sensitivity').disabled = $('volume').disabled = true;
  for (const box of modBoxes ?? []) box.disabled = true;
  for (const input of Object.values(hordeFields ?? {})) input.disabled = true;
  $('settings-note').textContent = 'Reload to change.';
  state.canvas = sizeGameCanvas(canvas);
  engine = state.engine = createEngine(canvas, state);
  // webmods: only mods this pack ships (a saved choice from another pack version is dropped)
  const chosen = settings(), shipped = packMods(state.manifest);
  chosen.mods = chosen.mods.filter(name => shipped.includes(name)); state.mods = chosen.mods;
  try { await engine.load(chosen); } catch (error) { state.onCrash(error.message, { stack: error.stack ?? null, source: 'engine-load' }); }
}
async function enter() {
  if (locking || !engine) return;
  locking = true; play.disabled = true;
  // Fullscreen is optional. Start all activation calls in this click, before await.
  const full = $('fullscreen').checked && !document.fullscreenElement
    ? document.documentElement.requestFullscreen().then(lockEscape, () => {
      $('notice').textContent = 'Fullscreen unavailable.'; $('notice').hidden = false;
    }) : Promise.resolve();
  const playing = engine.play();
  try {
    await Promise.all([full, playing]);
    if (document.pointerLockElement !== canvas) throw new Error('The mouse was not captured.');
    screen('playing', ''); state.timings.playing = performance.now();
    if (intro?.started && !intro.finished) introFinish('skip'); // loaded: the start click/key also ends the cinematic
    videoMaster(testMuted() ? 0 : Math.min(1, Number($('volume').value))); // volume50: in-game cinematics follow Master Volume (default 50%)
  } catch (error) {
    document.exitPointerLock(); engine.pause();
    ready(); $('notice').hidden = false;
    $('notice').textContent = `Mouse or sound access was declined: ${error.message}`;
  } finally { locking = false; play.disabled = false; }
}
// webmenu: Escape opens the game's own pause menu, as on desktop. Fullscreen:
// Keyboard Lock hands Escape to the game (hold Esc to leave fullscreen).
// Otherwise the browser's Escape releases the mouse and input.js forwards it.
function lockEscape() {
  state.keyboardLock = 'unsupported';
  return navigator.keyboard?.lock?.(['Escape']).then(() => { state.keyboardLock = 'locked'; },
    error => { state.keyboardLock = error.name; });
}
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && state.keyboardLock === 'locked') { navigator.keyboard.unlock(); state.keyboardLock = 'released'; }
});
// Re-capture needs a click (a user gesture): input.js calls this from a canvas
// click while the game is in gameplay without the mouse.
state.onRelock = () => {
  if (state.screen !== 'playing') return;
  Promise.resolve(engine.input.lock()).catch(error => { state.relockError = error.message; });
};
function followGame() {
  // The engine closed the adopted stream (post-load end or its own key skip): it removed the element.
  if (intro?.started && !intro.finished && intro.adopted && !intro.video.isConnected) introFinish('closed');
  if (state.screen === 'playing') {
    const menu = engine.uiState(), locked = document.pointerLockElement === canvas;
    // A game menu draws its own cursor: free the browser pointer for absolute
    // coordinates and hide the system arrow over the canvas.
    if (menu & 1 && locked) engine.input.unlock();
    canvas.classList.toggle('menu-cursor', Boolean(menu & 2));
    $('resume-hint').hidden = locked || Boolean(menu & 1);
    state.uiState = menu;
  }
  requestAnimationFrame(followGame);
}
requestAnimationFrame(followGame);
// Browser-required steps read like the game's own prompts: any key or a click anywhere continues.
// The activation-sensitive work still runs inside this key/click handler (play.onclick).
function prompt() {
  if (!['landing', 'ready'].includes(state.screen) || play.hidden || play.disabled) return false;
  play.click(); return true;
}
document.addEventListener('keydown', event => {
  if (event.repeat || event.ctrlKey || event.altKey || event.metaKey || /^(Escape|Tab|Shift|Control|Alt|Meta|F\d+)$/.test(event.key)) return;
  if (event.target.closest?.('#settings, button, input')) return;
  // intro5: the key that dismisses the prompt is consumed here, so the engine (input.js, a later document listener,
  // just enabled by engine.play) never sees it as a key that skips the load movie.
  if (prompt()) { event.preventDefault(); event.stopImmediatePropagation(); }
});
$('overlay').addEventListener('click', event => { if (!event.target.closest('#settings, button, details')) prompt(); });
$('background-retry').onclick = () => {
  if (downloading) return;
  $('background-retry').hidden = true; downloading = true;
  newDownloader(); post(downloader, 'download');
};
addEventListener('kisak-map-loaded', () => downloader?.postMessage({ type: 'resume-background' }));
window.addEventListener('pagehide', () => { downloader?.terminate(); engine?.stop().catch(() => {}); });
try {
  const unsupported = await checkCapabilities();
  if (!document.documentElement.requestFullscreen || !document.exitFullscreen || document.fullscreenEnabled === false) {
    $('fullscreen').checked = false; $('fullscreen').disabled = true;
    $('notice').textContent = 'Fullscreen unavailable.'; $('notice').hidden = false;
  }
  if (unsupported) errorScreen(unsupported.kind, unsupported.message); else inspect();
} catch (error) { errorScreen('browser', error.message); }
