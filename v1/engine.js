// The Emscripten UI runtime transfers #game directly to its main pthread.
// Never create a context here or transfer it to the shell's 2D probe worker.
import { map, mapId, opfsRoot, BASE, horde as hordePage } from './maps.js';
import { captureInput } from './input.js';
import { hordeArguments, HORDE_GAME } from './horde.js';

// Firefox 157 exposes every required worker API but the backend-owner route
// produces black frames. Its existing main-pthread owner yields through rAF
// and passes Five's render/input/audio gates. Keep Chromium's parallel route.
// Same list as src/web/gpu/webgpu_backend.cpp InitializeWebGPU.
const webGPUFeatures = ['texture-compression-bc', 'depth32float-stencil8', 'float32-filterable', 'float32-blendable'];
async function chooseRenderer(param) {
  if (param === 'webgl2') return { renderer: 'webgl2', reason: 'override' };
  // The pipelined executor blocks its recording thread (Atomics.wait): backend pthread route only.
  const pipeline = rendererRoute === 'backend-pthread' ? 1 : 0;
  if (param === 'webgpu') return { renderer: 'webgpu', reason: 'override', pipeline };
  try {
    const adapter = await globalThis.navigator?.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { renderer: 'webgl2', reason: 'no-webgpu-adapter' };
    const missing = webGPUFeatures.filter(feature => !adapter.features.has(feature));
    if (missing.length) return { renderer: 'webgl2', reason: 'missing-' + missing.join('+') };
    if (!pipeline) return { renderer: 'webgl2', reason: 'route-' + rendererRoute };
    return { renderer: 'webgpu', reason: 'default', pipeline };
  } catch (error) { return { renderer: 'webgl2', reason: 'adapter-error ' + error.message }; }
}
// size2: the renderer is chosen once, before the download, so the WebGPU path can skip the GLSL pack (manifest
// class "lazy"; play.js asks the worker for it only when WebGL2 is chosen). If the engine itself falls back to
// WebGL2 after a WebGPU choice, the page reloads once with a per-tab override (sessionStorage kisak-renderer).
export const glslPack = 'web/shaders/shaders.pack';
let choicePromise = null;
export function rendererChoice() {
  return choicePromise ??= chooseRenderer(globalThis.sessionStorage?.getItem('kisak-renderer') ?? new URLSearchParams(location.search).get('renderer'));
}
export const rendererRoute = /Firefox\//.test(globalThis.navigator?.userAgent ?? '') ? 'main-pthread' : 'backend-pthread';

export const fiveArguments = [
  '+set', 'fs_b', opfsRoot, '+set', 'fs_h', '/opfs/user',
  '+set', 'kisak_zombies', '1', '+set', 'zombiemode', '1',
  '+set', 'kisak_testclient', '0', '+set', 'kisak_scripterrors', '100',
  '+set', 'r_fullscreen', '0', '+set', 'r_aaSamples', '1',
  // strobe: r_clear defaults to 2 (blink: light blue / orange every 512 ms), a dev aid; retail never shows it. Clear to black.
  '+set', 'r_clear', '0',
  // The owning canvas worker schedules frames with rAF. An integer engine cap
  // would quantize 60 to 16 ms and prevent reaching a 120 Hz display.
  '+set', 'r_vsync', '0', '+set', 'com_maxfps', '0',
  '+set', 'snd_softwaremixer', '1', '+set', 'snd_softwarewav', '0',
  '+set', 'snd_softwaretable', opfsRoot + '/web/sound',
  ...(rendererRoute === 'main-pthread' ? ['+set', 'r_smp_backend', '0'] : []),
  '+devmap', mapId,
];

export function writeStereo(ring, capacity, frames, timestamps, times) {
  const control = new Int32Array(ring, 0, 4), samples = new Float32Array(ring, 16);
  let write = Atomics.load(control, 1);
  const read = Atomics.load(control, 0);
  let written = 0;
  for (let i = 0; i + 1 < frames.length; i += 2) {
    const next = (write + 1) % capacity;
    if (next === read) { Atomics.add(control, 3, 1); break; }
    samples[write * 2] = frames[i]; samples[write * 2 + 1] = frames[i + 1];
    if (timestamps) timestamps[write] = times[i / 2];
    write = next; written++;
  }
  Atomics.store(control, 1, write);
  return written;
}

export function audioViews(module, pointer, frames, timePointer = 0) {
  // A pthread may grow memory without refreshing the UI's exported views.
  module.refreshAudioViews?.();
  const stereo = module.HEAPF32.subarray(pointer / 4, pointer / 4 + frames * 2);
  const times = timePointer ? module.HEAPF64.subarray(timePointer / 8, timePointer / 8 + frames) : null;
  if (stereo.length !== frames * 2 || (times && times.length !== frames))
    throw new Error('Audio transfer is outside the current WASM memory view');
  return { stereo, times };
}

export function createEngine(canvas, state) {
  const capacity = 8192, ring = new SharedArrayBuffer(16 + capacity * 8);
  const control = new Int32Array(ring, 0, 4);
  const timesRing = new SharedArrayBuffer(capacity * 8), timestamps = new Float64Array(timesRing);
  const captures = new Map();
  let captureId = 0, timePointer = 0;
  let nativeAudio, nativeRunning = false, audioConfigured = false, audioGeneration = 0;
  let context, audioNode, module, pointer, pump;
  let pausedDrainAt = performance.now();
  let starting, audioReady, stopped = false;
  let mouseX = 0, mouseY = 0;
  const zones = new Set(), opened = new Set();
  let startupConsoleLines = null;
  function progress(stage, fraction = null, label = '') {
    if (stopped) return;
    if (stage === 'ready' && startupConsoleLines === null) startupConsoleLines = state.console.length;
    const value = typeof fraction === 'number' && Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : null;
    state.load = { stage: String(stage), fraction: value, label: String(label) };
    state.onProgress?.(state.load);
  }
  // quitmenu: the in-game Quit / End Game menus leave the game; they must not show the crash screen. A local disconnect
  // ends in Com_Error(ERR_DISCONNECT, "PLATFORM_DISCONNECTED_FROM_SERVER") (CL_DisconnectLocalClient; native then drops to
  // its main menu, which the browser build doesn't ship); "quit" prints "quitting..." (Com_Quit_f) and exits with code 0.
  // The page goes to map select.
  function quit(how) {
    if (stopped || state.quit) return;
    state.quit = how;
    state.onQuit?.(how);
  }
  function crash(reason) {
    if (stopped || state.quit) return;
    const message = String(reason?.message ?? reason);
    state.errors.push(message);
    state.onCrash?.(message, { stack: reason?.stack ?? null, source: 'engine' });
  }
  // warmgate: the "Click to start" prompt (progress 'ready' -> play.js ready()) waits for the GPU pipeline warm-up
  // (webgpu_pipe.js pipewarm: the map's seeded pipelines, <base>/artifacts/<map>-pipelines.json, created off-thread from
  // engine start). Spawning while they still compile skips their draws: parts of the map missing for the first seconds,
  // worst for a returning player, whose cached pack loads faster than the warm-up. Meanwhile the world stays paused on its
  // first frame (engine intro-hold, cl_paused, until the player is in), so only the prompt moves. Signals, relayed from the
  // executor worker over BroadcastChannel 'kisak-page-query' (start()):
  //   WEB_GPU_WARM map=M seed=N session=S rows=R           started: wait only if the shipped seed has rows (seed=none: the
  //                                                         session rows carry no shaders and may never queue)
  //   WEB_GPU_WARM ready queued=Q done=D failed=F of=R      finished
  //   {warm:{rows,queued,done,failed,end,pend}} (channel)   progress, engines with the warmgate hook (optional); then the
  //                                                         prompt also waits for pend=0 (compiles in flight); the page
  //                                                         answers {warmDone:1} when it lets the player in
  // On the WebGPU pipeline route without a start line by map load (seed still downloading) wait WARM_START_MS for it.
  // Bounded: never more than WARM_HOLD_MS after map load.
  const WARM_HOLD_MS = 45000, WARM_START_MS = 10000;
  const warm = state.warm = { started: false, seed: null, rows: 0, queued: 0, done: 0, failed: 0, finished: false };
  let warmTimer = null;
  function warmLog(message) {
    if (!message.startsWith('WEB_GPU_WARM ')) return;
    const start = /^WEB_GPU_WARM map=(\S+) seed=(\S+)(?: session=(\S+))? rows=(\d+)/.exec(message);
    if (start && !warm.started) {
      Object.assign(warm, { started: true, map: start[1], seed: start[2], session: start[3] ?? null, rows: Number(start[4]) });
      state.timings.warmStart = performance.now();
    }
    const done = /^WEB_GPU_WARM ready queued=(\d+) done=(\d+) failed=(\d+)(?: of=(\d+))?(?: ms=(\d+))?/.exec(message);
    if (done) {
      Object.assign(warm, { queued: Number(done[1]), done: Number(done[2]), failed: Number(done[3]), finished: true,
        ms: done[5] === undefined ? null : Number(done[5]) });
      state.timings.warmReady ??= performance.now();
    }
    if (start || done) warmGate();
  }
  function warmProgress(p) {
    if (!p || typeof p !== 'object') return;
    for (const key of ['rows', 'queued', 'done', 'failed', 'pend']) if (Number.isFinite(p[key])) warm[key] = p[key];
    warm.progress = true; warm.at = performance.now();
    // Pipelines this warm-up will build: built + compiling + still queued (queued counts only the started ones, at most
    // 4 in flight). Rows whose shaders are not registered yet never count; without the queue length, all rows.
    warm.total = Number.isFinite(p.waiting) ? warm.done + warm.failed + (p.inflight || 0) + p.waiting : warm.rows;
    if (p.end && !warm.finished) { warm.finished = true; state.timings.warmReady ??= performance.now(); }
    warmGate();
  }
  function warmGate() {
    const t = state.timings;
    if (!t.mapLoaded || state.readyFired || stopped) return;
    const now = performance.now(), held = now - t.mapLoaded;
    const route = state.renderer === 'webgpu-pipeline' && !/[?&]pipelineWarm=0/.test(location.search);
    const seeded = warm.started && Number(warm.seed) > 0 && warm.rows > 0;
    // With the progress hook, also let the first (paused) frames' own compiles settle: pipelines the seed lacks, which the
    // spawn view needs, compile while the prompt waits instead of being skipped in the player's first seconds.
    const settled = !warm.progress || (warm.pend === 0 && warm.at - t.mapLoaded >= 250);
    let reason = null;
    if (held >= WARM_HOLD_MS) reason = 'timeout';
    else if (warm.started) reason = !seeded ? 'nothing-to-warm' : warm.finished && settled ? 'warm-ready' : null;
    else reason = !route ? 'no-warm' : held >= WARM_START_MS ? 'no-warm-start' : null;
    if (!reason) {
      state.warmHolding = true; t.warmHold ??= now; state.warmHoldUntil = t.mapLoaded + WARM_HOLD_MS; // play.js bar/ETA
      warmTimer ??= setInterval(warmGate, 250);
      const of = warm.total || warm.rows;
      progress('world', 1, warm.started ? `Preparing graphics${warm.progress && of ? ` · ${warm.done + warm.failed} / ${of}` : ''}…`
        : 'Preparing graphics…');
      return;
    }
    if (warmTimer) { clearInterval(warmTimer); warmTimer = null; }
    state.warmHolding = false; state.readyFired = true; t.readyShown = now;
    state.warmGate = { reason, holdMs: Math.round(held), seed: warm.seed, rows: warm.rows, queued: warm.queued, done: warm.done,
      failed: warm.failed, warmMs: warm.ms ?? null, progress: Boolean(warm.progress) };
    if (reason === 'timeout') state.warmHoldTimedOut = true;
    try { globalThis.__kisakQueryChannel?.postMessage({ warmDone: 1 }); } catch { /* the hook's progress then stops on its own */ }
    progress('ready', 1, `${map.name} is ready`);
  }
  function log(message, error = false) {
    // Test-only (size2): ?forceWebgpuFail=1 turns the engine's WebGPU init result into a failure report at the same
    // message boundary, so the WEB_GPU_FALLBACK -> one-time reload -> WebGL2 (+ lazy GLSL fetch) path runs for real.
    if (/^WEB_GPU_DEVICE_READY/.test(String(message)) && new URLSearchParams(location.search).get('forceWebgpuFail') === '1')
      message = 'WEB_GPU_FALLBACK forceWebgpuFail';
    if (/^WEB_GPU_(DEVICE_READY|FALLBACK)/.test(String(message))) {
      state.renderer = String(message).startsWith('WEB_GPU_DEVICE_READY')
        ? (/owner=pipeline/.test(message) ? 'webgpu-pipeline' : 'webgpu') : 'webgl2';
      state.rendererDetail = String(message);
      if (String(message).startsWith('WEB_GPU_FALLBACK') && state.rendererRequested === 'webgpu' && !globalThis.sessionStorage?.getItem('kisak-renderer')) {
        sessionStorage.setItem('kisak-renderer', 'webgl2'); location.reload(); // GLSL pack was not downloaded
      }
    }
    if (/KISAK_BROWSER webgpu-device-lost/.test(String(message))) {
      state.telemetry?.error?.('engine-worker', String(message));
      crash('The WebGPU graphics device was lost. Reload the page to restart; if it repeats, open play.html?renderer=webgl2.');
    }
    if (String(message).startsWith('KISAK_FLUSH_ROWS ')) {
      // Keep bounded startup trace chunks out of the live DevTools console.
      // They remain available in the integration report after activation.
      (state.flushTrace ??= []).push(String(message));
      return;
    }
    state.console.push({ ms: performance.now(), error, message: String(message) });
    // Keep startup evidence and a bounded recent gameplay history. Raw output
    // still reaches console/CDP below; long sessions must not retain every wait
    // diagnostic in the player page. Error counters include discarded records.
    if (startupConsoleLines !== null && state.console.length > startupConsoleLines + 2048) {
      const excess = state.console.length - startupConsoleLines - 2048;
      state.console.splice(startupConsoleLines, excess);
      state.consoleDiscarded = (state.consoleDiscarded ?? 0) + excess;
    }
    if (error) state.consoleErrors++;
    // Engine fatal errors can be printed to stdout by a worker without a JS
    // exception. Treat them as failures even when Chrome itself stays alive.
    if (/Com_ERROR:\s*PLATFORM_DISCONNECTED_FROM_SERVER/.test(message)) quit('disconnect');
    else if (/^quitting\.\.\.\s*$/.test(message)) quit('quit'); // Com_Quit_f; its shutdown can assert before onExit(0)
    else if (/Com_ERROR:|KISAK_HEADLESS Sys_Error:|KISAK_BROWSER worker-error|Aborted\(|RuntimeError:/.test(message))
      crash({ message, stack: message.includes('\n    at ') ? message : null });
    // Non-fatal worker diagnostics (pthread stacks, GPU context loss) for telemetry.
    if (/KISAK_BROWSER (worker-stack|webgl-context-(lost|restored))/.test(message))
      state.telemetry?.error?.('engine-worker', String(message));
    if (/script runtime error|script exception/i.test(message)) state.scriptExceptions++;
    if (/GL_INVALID|WebGL.*error|GL error/i.test(message)) state.glErrors++;
    if (/KISAK_BROWSER engine-initialized/.test(message)) {
      state.timings.engineInitialized = performance.now();
      progress('world', null, `Engine initialized. Starting ${map.name}…`);
    }
    if (/KISAK_BROWSER intro-(hold|release)/.test(message)) state.timings[/hold/.test(message) ? 'introHeld' : 'introRun'] ??= performance.now();
    if (/KISAK_BROWSER first-present/.test(message)) state.timings.firstPresent = performance.now();
    const zone = /Loaded fastfile '([^']+)'/.exec(message);
    if (zone) {
      zones.add(zone[1]); (state.zoneTimes ??= {})[zone[1]] ??= Math.round(performance.now());
      const total = state.manifest?.files.filter(file => /\.ff$/i.test(file.path)).length;
      const label = `${zones.size}${total ? ' / ' + total : ''} fastfiles loaded · ${zone[1]}`;
      if (total && zones.size >= total) progress('world', null, label + ` · Starting ${map.name}…`);
      else progress('zones', total ? zones.size / total : null, label);
    }
    const file = /(?:KISAK_BROWSER file-open|KISAK_FILE_OPEN)\s+(.+)/.exec(message);
    if (file) { opened.add(file[1]); progress('files', null, `${opened.size} files opened · ${file[1]}`); }
    if (new RegExp('KISAK_BROWSER map-loaded\\s+' + mapId + '\\b').test(message)) {
      if (startupConsoleLines === null) startupConsoleLines = state.console.length;
      state.timings.mapLoaded = performance.now();
      globalThis.dispatchEvent?.(new Event('kisak-map-loaded')); // load4: play.js releases the held background download
      // webregress: a build without KISAK_WEBGPU prints neither READY nor FALLBACK; by map load the
      // renderer is up, so a still-pending WebGPU choice means the engine is on WebGL2.
      if (state.renderer === 'webgpu-pending') Object.assign(state, { renderer: 'webgl2',
        rendererDetail: 'no WEB_GPU_DEVICE_READY by map load (engine built without KISAK_WEBGPU)' });
      warmGate();
    }
    warmLog(message);
    const view = /KISAK_BROWSER view ms=(\d+) angles=([^\s]+)(?: origin=([^\s]+) cmd=(\d+) move=([^\s]+) input=(\d+) catchers=(\d+))?/.exec(message);
    if (view) (state.views ??= []).push({ms:performance.now(), engineMs:Number(view[1]),
      angles:view[2].split(',').map(Number), origin:view[3]?.split(',').map(Number),
      cmd:Number(view[4]), move:view[5]?.split(',').map(Number), input:Number(view[6]), catchers:Number(view[7]),
      flags:parseInt(/flags=([0-9a-f]+)/.exec(message)?.[1] ?? '0', 16),
      weaponstate:Number(/weaponstate=(\d+)/.exec(message)?.[1] ?? 0),
      paused:Number(/ paused=(\d+)/.exec(message)?.[1] ?? 0), sndPaused:Number(/sndpaused=(\d+)/.exec(message)?.[1] ?? 0)});
    const menu = /KISAK_BROWSER menu name=(\S*) catchers=(\d+)/.exec(message);
    if (menu) (state.menus ??= []).push({ name: menu[1], catchers: Number(menu[2]), items: [] });
    const item = /KISAK_BROWSER menu-item (\d+) x=(-?\d+) y=(-?\d+) name=(\S*)(?: type=(\d+) w=(\d+) dvar=(\S+) val=(\S+))? text=(.*)/.exec(message);
    if (item && state.menus?.length) state.menus.at(-1).items.push({ index: Number(item[1]), x: Number(item[2]), y: Number(item[3]), name: item[4],
      type: Number(item[5] ?? -1), w: Number(item[6] ?? 0), dvar: item[7] === '-' ? '' : item[7] ?? '', value: item[8] === '-' ? '' : item[8] ?? '', text: item[9] });
    if (state.views?.length > 512) state.views.splice(0, state.views.length - 512);
    (error ? console.error : console.log)(message);
  }
  const input = captureInput(canvas, event => {
    if (!module || !state.interactive) return;
    if (event.kind === 'cursor') { state.inputEvents++; if (!module._KB_Input(4, event.x, event.y)) state.inputDropped++; return; }
    let accepted = 1;
    if (event.kind === 'key') accepted = module._KB_Input(0, event.key, Number(event.down));
    else if (event.kind === 'char') accepted = module._KB_Input(1, event.char, 0);
    else if (event.kind === 'mouse') {
      mouseX += event.dx; mouseY += event.dy;
      const dx = Math.trunc(mouseX), dy = Math.trunc(mouseY);
      mouseX -= dx; mouseY -= dy;
      accepted = module._KB_Input(2, dx, dy);
    }
    else if (event.kind === 'pointer-lock') accepted = module._KB_Input(3, Number(event.locked), 0);
    state.inputEvents++;
    if (!accepted) state.inputDropped++;
  }, { menuOpen: () => Boolean(module && (module._KB_UIState() & 1)),
    size: () => state.canvas ?? canvas, relock: () => state.onRelock?.() });
  function prepareAudio() {
    if (!audioReady) {
      context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      if (context.sampleRate !== 48000) throw new Error('Five requires a 48 kHz audio context');
      // The first click loads the map; output starts on the later Play gesture.
      audioReady = Promise.all([context.suspend(), context.audioWorklet.addModule(BASE + 'audio-worklet.js')]).then(() => {
        if (stopped) return;
        audioNode = new AudioWorkletNode(context, 'five-audio', { numberOfInputs: 0,
          numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { ring, capacity, times: timesRing } });
        audioNode.port.onmessage = ({ data }) => {
          if (data.type === 'discarded') state.audioDiscardedFrames = (state.audioDiscardedFrames ?? 0) + data.frames;
          if (data.type === 'capture' && captures.has(data.id)) {
            const resolve = captures.get(data.id); captures.delete(data.id); resolve(data);
          }
        };
        // A trapped worklet goes silent; the engine keeps running. Record it.
        audioNode.onprocessorerror = event => {
          log('KISAK_BROWSER audio-worklet processorerror ' + (event?.message ?? ''), true);
          state.telemetry?.error?.('audio-worklet', 'processorerror ' + (event?.message ?? ''));
        };
        audioNode.connect(context.destination);
      });
    }
    return audioReady;
  }
  async function start(settings) {
    // pipewarm: the WebGPU pipe starts in the engine pthread, which cannot see location.search; answer its query (webgpu_pipe.js).
    if (!globalThis.__kisakQueryChannel && typeof BroadcastChannel === 'function') {
      const bc = globalThis.__kisakQueryChannel = new BroadcastChannel('kisak-page-query');
      // integ11: also answer the page's map (<html data-map>, set by kino.html/five.html and by the landing swap) and path: the
      // pthread's location is /artifacts/KisakBlack-web.mjs, so webgpu_pipe.js could not tell Kino from Five and warmed five-pipelines.json.
      // warmgate: {warm:{...}} = pipeline warm-up progress (engines with the hook; see warmGate).
      bc.onmessage = e => { if (e.data && typeof e.data.log === 'string') { log(e.data.log); return; }
        if (e.data && e.data.warm) { warmProgress(e.data.warm); return; } if (e.data && e.data.ask) bc.postMessage({search:location.search, path:location.pathname, map:document.documentElement.dataset.map || ''}); };
    }
    progress('wasm', null, 'Loading the game engine…');
    const { default: createKisakBrowser } = await import(BASE + 'artifacts/KisakBlack-web.mjs');
    if (stopped) return;
    state.timings.engineStart = performance.now();
    module = await createKisakBrowser({ canvas, noInitialRun: true,
      locateFile: name => BASE + 'artifacts/' + name,
      print: message => log(message), printErr: message => log(message, true),
      kisakProgress: progress,
      kisakFileOpened: path => { opened.add(String(path)); progress('files', null, `${opened.size} files opened`); },
      monitorRunDependencies: count => { if (count) progress('wasm', null, 'Preparing engine resources…'); },
      onAbort: crash,
      onExit: code => { state.exitCode = code; if (stopped) return; if (code === 0) quit('exit'); else crash(`The engine stopped (code ${code}).`); },
    });
    if (stopped) { module.PThread?.terminateAllThreads(); return; }
    state.timings.wasmReady = performance.now();
    if (globalThis.__kisakParity?.drawMerge === false) {
      if (!module._KB_DrawMerge) throw new Error('Draw-merge diagnostic export unavailable');
      module._KB_DrawMerge(0);
    }
    if (globalThis.__kisakParity?.streamBudget === false) {
      if (!module._KB_StreamBudget) throw new Error('Stream-budget diagnostic export unavailable');
      module._KB_StreamBudget(0);
    }
    // Streamed cinematics (manifest.streams, fetched by <video> range requests while the engine loads, never OPFS).
    if (module.kbVideo && module._KB_RegisterVideo && state.manifest?.streams?.length) {
      module.kbVideoBase = globalThis.__kisakVideoBase ?? state.packBase; // play.js: the pack root download-worker.js uses
      // loadvol: play.js sets the master to the loading volume (state.videoMaster, 0.25 by default) until the player is in game.
      module.kbVideoMaster = globalThis.__kisakParity?.muted || globalThis.__kisakMuted ? 0 : state.videoMaster ?? 1;
      module.kbVideo.register(state.manifest.streams);
    }
    if (module._KB_SetProgramManifest && !globalThis.__kisakParity?.noProgramManifest) {
      const response = await fetch(map.programs);
      if (response.ok) {
        const bytes = new TextEncoder().encode(await response.text()), address = module._malloc(bytes.length);
        if (!address) throw new Error('Cannot allocate program manifest');
        new Uint8Array(module.HEAPF32.buffer,address,bytes.length).set(bytes);
        module._KB_SetProgramManifest(address,bytes.length); module._free(address);
      } else if (response.status !== 404) throw new Error('Cannot load program manifest');
    }
    pointer = module._malloc(4096 * 8);
    if (!pointer) throw new Error('Cannot allocate audio transfer buffer');
    if (module._KB_AudioRing) {
      module.refreshAudioViews();
      const layout = new Uint32Array(module.HEAPF32.buffer, module._KB_AudioRing(), 7);
      const [capacity, samples, read, write, times, mixTimes, demand] = layout;
      nativeAudio = { capacity, samples, read, write, times, mixTimes, demand, buffer: module.HEAPF32.buffer };
    }
    pump = setInterval(() => {
      const now = performance.now(), pausedFrames = Math.floor((now - pausedDrainAt) * 48);
      pausedDrainAt += pausedFrames / 48;
      if (nativeRunning) {
        state.audioFrames = Atomics.load(control, 0) >>> 0;
        state.audioUnderruns = Atomics.load(control, 2); state.audioOverruns = Atomics.load(control, 3);
        return;
      }
      if (nativeAudio) {
        // Only after context suspension completes does the UI regain ownership.
        // A demand-driven producer would otherwise advance paused voices as
        // fast as this UI timer drains the ring (60 ms on every 8-ms tick).
        // Consume muted output at the same 48-kHz rate as the running worklet.
        const frames = module._KB_AudioRead(pointer, Math.min(pausedFrames, 4096), 0);
        state.audioDiscardedFrames = (state.audioDiscardedFrames ?? 0) + frames;
        const demand = new Int32Array(nativeAudio.buffer, nativeAudio.demand, 1);
        Atomics.add(demand, 0, 1); Atomics.notify(demand, 0, 1);
        return;
      }
      // Read only as much as fits, so drained mixer frames are never dropped.
      const free = (Atomics.load(control, 0) - Atomics.load(control, 1) - 1 + capacity) % capacity;
      if (!free) return;
      const frames = module._KB_AudioRead(pointer, Math.min(free, 4096), timePointer);
      if (!frames) return;
      // Keep the mixer current while mouse/audio are released, so Resume does
      // not replay old queued sound. Unlock controls output, not engine timing.
      if (!state.interactive || context?.state !== 'running') {
        state.audioDiscardedFrames = (state.audioDiscardedFrames ?? 0) + frames; return;
      }
      let stereo, times;
      try { ({ stereo, times } = audioViews(module, pointer, frames, timePointer)); }
      catch (error) { crash(error); return; }
      state.audioFrames += writeStereo(ring, capacity, stereo, timePointer ? timestamps : null, times);
      state.audioUnderruns = Atomics.load(control, 2);
      state.audioOverruns = Atomics.load(control, 3);
    }, 8);
    // Dvars precede devmap so startup receives the player's saved settings.
    const args = [...fiveArguments];
    // Renderer: pipelined WebGPU by default when the adapter has every required
    // feature; WebGL2 otherwise. ?renderer=webgl2|webgpu overrides. The engine
    // still falls back to WebGL2 when the pack lacks shaders-wgsl.pack.
    const choice = await rendererChoice();
    Object.assign(state, { renderer: choice.renderer === 'webgpu' ? 'webgpu-pending' : 'webgl2',
      rendererRequested: choice.renderer, rendererReason: choice.reason, rendererDetail: null });
    if (choice.renderer === 'webgpu')
      args.splice(args.indexOf('+devmap'), 0, '+set', 'r_webgpu', '1', '+set', 'r_webgpu_pipeline', String(choice.pipeline));
    args.splice(args.indexOf('+devmap'), 0, '+set', 'sensitivity', String(settings.sensitivity),
      '+set', 'snd_menu_master', String(settings.volume), '+set', 'r_customMode', `${canvas.width}x${canvas.height}`);
    // webmods: the ticked mods the pack ships (play.js); the engine stacks mods/<name> and mods/_stack (FS_Startup)
    // horde also sizes the engine for its zombie count (horde.js); those dvars must precede devmap, as fs_mods does.
    // hordetoggle: a horde page (?horde=1, the landing's HORDE MODE toggle) always starts the fixed horde game; the Options
    // mods do not apply there.
    if (hordePage) args.splice(args.indexOf('+devmap'), 0, ...hordeArguments(HORDE_GAME));
    else if (settings.mods?.includes('horde')) args.splice(args.indexOf('+devmap'), 0, ...hordeArguments({ ...settings.horde, mods: settings.mods }));
    else if (settings.mods?.length) args.splice(args.indexOf('+devmap'), 0, '+set', 'fs_mods', settings.mods.join(' '));
    // Headless parity runner injects this object before page scripts. Players
    // keep their normal settings and real pointer/fullscreen APIs.
    if (globalThis.__headlessInput && globalThis.__kisakParity)
      args.splice(args.indexOf('+devmap'), 0, ...(globalThis.__kisakParity.commands ?? []));
    state.arguments = args;
    progress('files', null, `Opening ${map.name} from your saved pack…`);
    // overlap (play.js packGate): register every boot file not yet verified; the engine's file opens wait on them.
    // An engine build without the gate (no _KB_PackExpect) waits for the whole boot class here, as before.
    const gate = state.packGate;
    // bootfix: the gate only sees the wrapped open/stat syscalls; the engine reads localization.txt with stdio fopen in
    // platform-init (Win_InitLocalization), which bypasses it. If that file was not yet verified at callMain the engine
    // read nothing and asserted in Win_GetLanguage (DB_LoadXAssets). Repro: ?dlDelay=localization.txt:4000. Wait for
    // the root-level boot files (the third file fetched, normally ready long before callMain) before starting the engine.
    if (gate && !gate.done && gate.waiters) {
      const early = gate.paths.filter(path => !path.includes('/'));
      if (!early.every(path => gate.ready.has(path))) {
        const waitStart = performance.now();
        await new Promise(resolve => { const check = () => { if (gate.done || early.every(path => gate.ready.has(path))) {
          gate.waiters.delete(check); resolve(); } }; gate.waiters.add(check); check(); });
        state.bootRootWaitMs = Math.round(performance.now() - waitStart);
      }
    }
    if (gate && !gate.done) {
      if (module._KB_PackExpect) {
        for (const path of gate.paths) {
          if (gate.ready.has(path)) continue;
          const bytes = new TextEncoder().encode(path), address = module._malloc(bytes.length + 1);
          const heap = new Uint8Array(module.HEAPF32.buffer, address, bytes.length + 1); heap.set(bytes); heap[bytes.length] = 0;
          module._KB_PackExpect(address, gate.sizes?.get(path) ?? -1); module._free(address);
        }
        gate.module = module; state.packGateExpected = gate.paths.length - gate.ready.size;
      } else await gate.bootReady;
    }
    state.timings.callMain = performance.now();
    module.callMain(args);
    // Transfer loses pointer-lock state queued before module initialization.
    module._KB_Input(3, Number(document.pointerLockElement === canvas), 0);
  }
  let presentRing = null, defaultPresentReader = null;
  // Present intervals since the reader's previous call, read from the engine's shared
  // ring (src/web/gl/web_present.cpp). Plain memory reads: no wasm call, no lock.
  // Each reader keeps its own cursor (telemetry's presentFrames and the ?perf=1 overlay).
  function presentReader() {
    let presentRead = null;
    return () => {
      if (!module?._KB_PresentRing || !module.HEAPF32) return null;
      const buffer = module.HEAPF32.buffer;
      if (!presentRing) {
        const layout = new Uint32Array(buffer, module._KB_PresentRing(), 4);
        presentRing = { capacity: layout[0], written: layout[1], intervals: layout[2], times: layout[3] };
      }
      const { capacity } = presentRing;
      const written = Atomics.load(new Uint32Array(buffer, presentRing.written, 1), 0);
      if (presentRead === null) presentRead = written;
      let count = (written - presentRead) >>> 0, lost = 0;
      // Skip slots the owner may be overwriting while we copy.
      if (count > capacity - 256) { lost = count - (capacity - 256); count = capacity - 256; }
      const intervalView = new Float32Array(buffer, presentRing.intervals, capacity);
      const timeView = new Float64Array(buffer, presentRing.times, capacity);
      const intervals = [], times = [];
      for (let i = (written - count) >>> 0; i !== written; i = (i + 1) >>> 0) {
        const slot = i & (capacity - 1), interval = intervalView[slot];
        if (interval > 0) { intervals.push(interval); times.push(timeView[slot]); }
      }
      presentRead = written;
      return { intervals, times, lost };
    };
  }
  // intro6: the engine holds the game paused on its first loaded frame (main.cpp intro-hold). Release it only when
  // the player is in (play()) AND the page's load video (play.js #intro, drawn above the canvas) is gone. Released
  // earlier, the zombies intro (black, flicker, fade in) ran hidden under the video and the player first saw the lit level.
  function releaseIntro() {
    if (state.introReleased || !state.introWanted || !module) return;
    const intro = globalThis.__kisakIntro;
    if (intro?.started && !intro.finished && intro.video?.isConnected) return;
    state.introReleased = true; state.timings.introRelease = performance.now(); module._KB_Input(7, 1, 0);
  }
  return { ring, input,
    presentFrames() { return (defaultPresentReader ??= presentReader())(); },
    // fpsui: an independent cursor over the same ring (the ?perf=1 overlay), so it never steals telemetry's intervals.
    presentReader,
    // Periodic telemetry: counters and atomics only. mallinfo() is left to
    // memorySnapshot(): it walks the whole heap under the allocator lock.
    telemetryMemory() {
      if (!module?.HEAPF32) return null;
      const wasmBytes = module.HEAPF32.buffer.byteLength, wasmBreak = module._KB_MemoryStats?.(3) ?? null;
      return { wasmBytes, wasmBreak, wasmUnclaimedBytes: wasmBreak === null ? null : wasmBytes - wasmBreak,
        engineZBytes: module._KB_EngineAllocStats?.(0) ?? null, engineHunkUsed: module._KB_EngineAllocStats?.(1) ?? null,
        enginePMemUsed: module._KB_EngineAllocStats?.(2) ?? null,
        textureStagingBytes: module._KB_WebResourceStats?.(0) ?? null, bufferStagingBytes: module._KB_WebResourceStats?.(1) ?? null,
        liveTextures: module._KB_WebResourceStats?.(2) ?? null, programCount: module._KB_WebResourceStats?.(6) ?? null,
        virtualReservedBytes: module._KB_VirtualMemoryStats?.(0) ?? null,
        audioCachedPCMBytes: module._KB_AudioMemoryStats?.(0) ?? null, audioCachedClips: module._KB_AudioMemoryStats?.(1) ?? null,
        audioPCMEvictions: module._KB_AudioMemoryStats?.(2) ?? null };
    },
    memorySnapshot() {
      module?.refreshAudioViews?.();
      return { wasmBytes: module?.HEAPF32?.buffer.byteLength ?? 0,
        wasmLiveBytes: module?._KB_MemoryStats?.(0) ?? null,
        wasmFreeBytes: module?._KB_MemoryStats?.(1) ?? null,
        wasmArenaBytes: module?._KB_MemoryStats?.(2) ?? null,
        wasmBreak: module?._KB_MemoryStats?.(3) ?? null,
        engineZBytes: module?._KB_EngineAllocStats?.(0) ?? null,
        virtualReservedBytes: module?._KB_VirtualMemoryStats?.(0) ?? null,
        virtualReservations: module?._KB_VirtualMemoryStats?.(1) ?? null,
        engineHunkUsed: module?._KB_EngineAllocStats?.(1) ?? null,
        enginePMemUsed: module?._KB_EngineAllocStats?.(2) ?? null,
        textureStagingBytes: module?._KB_WebResourceStats?.(0) ?? null,
        bufferStagingBytes: module?._KB_WebResourceStats?.(1) ?? null,
        liveTextures: module?._KB_WebResourceStats?.(2) ?? null,
        framebufferCacheEntries: module?._KB_WebResourceStats?.(3) ?? null,
        indexRangeBytesEstimate: module?._KB_WebResourceStats?.(4) ?? null,
        vaoBytesEstimate: module?._KB_WebResourceStats?.(5) ?? null,
        programCount: module?._KB_WebResourceStats?.(6) ?? null,
        shaderStageCount: module?._KB_WebResourceStats?.(7) ?? null,
        waitProfileBytesEstimate: module?._KB_WaitMemoryStats?.(0) ?? null,
        waitProfileCallerCount: module?._KB_WaitMemoryStats?.(1) ?? null,
        audioCachedPCMBytes: module?._KB_AudioMemoryStats?.(0) ?? null,
        audioCachedClips: module?._KB_AudioMemoryStats?.(1) ?? null };
    },
    frameProfile(mode) { if (!module?._KB_FrameProfileMode) throw new Error('No frame diagnostic export'); module._KB_FrameProfileMode(mode); },
    frameTrace(enabled) { if (!module?._KB_FrameTraceMode) throw new Error('No frame trace export'); module._KB_FrameTraceMode(enabled); },
    audioSnapshot() {
      const nativeFill = nativeAudio ? (Atomics.load(new Int32Array(nativeAudio.buffer, nativeAudio.write, 1), 0)
        - Atomics.load(new Int32Array(nativeAudio.buffer, nativeAudio.read, 1), 0)) >>> 0 : null;
      return { sampleRate: context?.sampleRate, mixerRate: 48000, baseLatencyMs: context?.baseLatency * 1000,
        outputLatencyMs: context?.outputLatency * 1000, contextState: context?.state,
        consumer: nativeAudio ? 'worklet' : 'ui', capacity: nativeAudio?.capacity ?? capacity,
        fill: nativeFill ?? (Atomics.load(control, 1) - Atomics.load(control, 0) + capacity) % capacity,
        mixerQueued: module?._KB_AudioQueued?.(), mixerDropped: module?._KB_AudioDropped?.(),
        producer: nativeAudio?.demand ? Array.from(new Uint32Array(nativeAudio.buffer, nativeAudio.demand + 4, 6)) : null,
        underruns: Atomics.load(control, 2), overruns: Atomics.load(control, 3),
        frames: nativeAudio ? Atomics.load(control, 0) >>> 0 : state.audioFrames };
    },
    async captureAudio(seconds = 10, count = 1) {
      if (!module || context?.state !== 'running') throw new Error('Audio capture requires an active engine');
      if (captures.size) throw new Error('An audio capture is already running');
      if (!Number.isInteger(count) || count < 1 || count > 3) throw new Error('Audio capture count must be 1..3');
      if (!module._KB_AudioTrace) throw new Error('This engine has no mixer timing diagnostics');
      if (!nativeAudio && !timePointer) timePointer = module._malloc(4096 * 8);
      if (!nativeAudio && !timePointer) throw new Error('Cannot allocate audio timestamp buffer');
      module._KB_AudioTrace(1);
      const before = this.audioSnapshot(), results = [];
      try {
        for (let i=0;i<count;++i) {
          const id = ++captureId;
          results.push(new Promise(resolve => captures.set(id, resolve)));
          audioNode.port.postMessage({ type: 'capture', id, seconds });
        }
        const series = (await Promise.all(results)).map(capture=>({...capture,before,after:this.audioSnapshot()}));
        return count === 1 ? series[0] : series;
      } finally { module._KB_AudioTrace(0); }
    },
    async load(settings = { sensitivity: 5, volume: .8 }) {
      if (!starting) starting = Promise.all([prepareAudio(), start(settings)]);
      await starting;
    },
    async play() {
      canvas.focus();
      ++audioGeneration;
      if (nativeAudio) {
        // The muted UI consumer kept this ring current at 48kHz. Preserve its
        // future 60ms of audio on handoff: emptying it here starved the first
        // worklet callbacks until the mixer next woke (12 startup underruns).
        // The worklet's existing timestamp filter discards only stale samples.
        nativeRunning = true;
        const demand = new Int32Array(nativeAudio.buffer,nativeAudio.demand,1);
        Atomics.add(demand,0,1); Atomics.notify(demand,0,1);
        if (!audioConfigured) {
          Atomics.store(control, 0, 0); Atomics.store(control, 1, 0);
          audioNode.port.postMessage({ type: 'mixer', ...nativeAudio });
          audioConfigured = true;
        }
        audioNode.port.postMessage({ type: 'resume', since: Date.now() });
      }
      // Both activation calls begin synchronously during the click gesture.
      state.interactive = true; input.enable(true);
      const lock = input.lock();
      const audio = context.resume();
      try {
        await Promise.all([lock, audio]);
        state.activation = { audio: context.state, pointerLocked: document.pointerLockElement === canvas };
        // intro5: the engine held the game paused on its first loaded frame; the player is in now, let the intro run.
        state.introWanted = true; releaseIntro();
      }
      catch (error) { state.interactive = false; throw error; }
    },
    // webmenu: game menu state (bit 0 menu owns the cursor) and a test aid that
    // logs the focused menu's items with canvas-pixel centres (state.menus).
    uiState: () => module ? module._KB_UIState() : 0,
    // intro6: play.js calls this when its load video ends, is skipped or is removed.
    introReady: () => releaseIntro(),
    // loadvol: the cinematic master volume (video_bridge.js setMaster; before the bridge exists, start() reads state.videoMaster).
    videoMaster(value) { if (module?.kbVideo?.setMaster) module.kbVideo.setMaster(value); },
    describeMenu: () => module?._KB_Input(5, 0, 0),
    // Background IWDs finished after FS_Startup: index them now (no-op before the module exists; startup sees them).
    lateIwds: () => module?._KB_Input(6, 0, 0),
    pause() {
      input.enable(false);
      mouseX = mouseY = 0;
      state.interactive = false;
      if (!nativeAudio) Atomics.store(control, 0, Atomics.load(control, 1));
      const generation = ++audioGeneration;
      if (context?.state === 'running') context.suspend().then(() => {
        if (generation === audioGeneration) nativeRunning = false;
      }).catch(crash);
      else nativeRunning = false;
      // Release pauses browser input/audio; the native simulation keeps running.
      if (module) module._KB_Input(3, 0, 0);
    },
    async stop() {
      stopped = true; state.engineStopped = true;
      if (pump) clearInterval(pump);
      input.dispose();
      if (context) await context.close();
      if (module?.PThread) module.PThread.terminateAllThreads();
      // Do not free a buffer while a still-running engine could use it.
    },
  };
}
