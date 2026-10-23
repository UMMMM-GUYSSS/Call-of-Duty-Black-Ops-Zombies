// Local play diagnostics for tools/web/serve.mjs. One probe decides: a server
// without /telemetry (or ?telemetry=0) disables every send. Records go only to
// this page's own origin; serve.mjs accepts them from loopback and appends JSON
// lines to build/telemetry. Sampling is cheap: frame intervals are read from a
// shared WASM ring every 10 s (no per-frame messages), and the periodic memory
// sample avoids mallinfo (a full heap walk under the allocator lock).
import { pointerLockOptions } from './input.js';
const TELEMETRY_URL = new URL('./telemetry', import.meta.url).pathname; // velgg: under the site's base path

const periodMs = 10000, logTail = 300, lineChars = 2000, beaconBytes = 60000;
const buckets = [8.4, 16.8, 20, 25, 33.4, 50, 100, 250, Infinity];

function percentile(sorted, p) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1) + 0.5))] : null;
}
const round = value => value === null || value === undefined || !Number.isFinite(value) ? value ?? null : Math.round(value * 100) / 100;

function rendererInfo() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return { webgl2: false };
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const info = { webgl2: true, vendor: gl.getParameter(debug ? debug.UNMASKED_VENDOR_WEBGL : gl.VENDOR),
      renderer: gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
      version: gl.getParameter(gl.VERSION), maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE) };
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return info;
  } catch (error) { return { error: String(error?.message ?? error) }; }
}

function measureRaf(ms = 2000) {
  return new Promise(resolve => {
    const intervals = [];
    let last = null, done = false;
    const start = performance.now();
    function finish() {
      if (done) return;
      done = true;
      intervals.sort((a, b) => a - b);
      const median = percentile(intervals, 0.5);
      resolve({ samples: intervals.length, medianMs: round(median), hz: median ? round(1000 / median) : null,
        p95Ms: round(percentile(intervals, 0.95)), visibility: document.visibilityState });
    }
    function tick(now) {
      if (done) return;
      if (last !== null) intervals.push(now - last);
      last = now;
      if (now - start < ms) requestAnimationFrame(tick); else finish();
    }
    // A hidden tab pauses rAF; report what was measured rather than waiting.
    setTimeout(finish, ms + 1000);
    requestAnimationFrame(tick);
  });
}

export function frameStats(intervals, times) {
  const sorted = Float64Array.from(intervals).sort();
  const worst = [];
  for (let i = 0; i < intervals.length; ++i) {
    if (worst.length < 5 || intervals[i] > worst[worst.length - 1].ms) {
      worst.push({ ms: round(intervals[i]), atMs: Math.round(times[i] - performance.timeOrigin) });
      worst.sort((a, b) => b.ms - a.ms); if (worst.length > 5) worst.pop();
    }
  }
  let over33 = 0, over50 = 0, total = 0;
  for (const value of intervals) { total += value; if (value > 33) over33++; if (value > 50) over50++; }
  return { count: intervals.length, meanMs: round(intervals.length ? total / intervals.length : null),
    medianMs: round(percentile(sorted, 0.5)), p95Ms: round(percentile(sorted, 0.95)), p99Ms: round(percentile(sorted, 0.99)),
    maxMs: round(sorted.length ? sorted[sorted.length - 1] : null), over33, over50, worst };
}

export function startTelemetry(state) {
  const query = new URLSearchParams(location.search).get('telemetry');
  let enabled = query === '0' || query === 'off' ? false : null, build = null, pending = [];
  const session = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const totals = { frames: 0, over33: 0, over50: 0, lost: 0, histogram: buckets.map(() => 0), worst: [], records: 0 };
  let crashSent = 0, errorsSent = 0, hiddenCount = 0, lastAudio = null, lastMemory = null, ended = false, timer, crashTimer;
  const telemetry = state.telemetry = { session, totals, get enabled() { return enabled; } };

  function post(body, final) {
    const text = JSON.stringify(body);
    // Beacons survive page unload but are capped near 64 KB; crash records with a
    // full log tail use a regular request because the crash page stays open.
    if (final && text.length < beaconBytes && navigator.sendBeacon?.(TELEMETRY_URL, new Blob([text], { type: 'application/json' }))) return;
    fetch(TELEMETRY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text,
      keepalive: text.length < beaconBytes }).catch(() => {});
  }
  function send(type, data = {}, final = false) {
    if (enabled === false) return;
    const body = { type, session, seq: totals.records++, pageMs: Math.round(performance.now()), wall: new Date().toISOString(),
      screen: state.screen ?? null, interactive: Boolean(state.interactive), build, pack: state.manifest?.version ?? null, ...data };
    if (enabled === null) pending.push([body, final]); else post(body, final);
  }
  const ready = fetch(TELEMETRY_URL, { cache: 'no-store' }).then(response => response.ok ? response.json() : null)
    .catch(() => null).then(info => {
      if (enabled !== false) enabled = Boolean(info?.enabled);
      build = info?.build ?? null;
      const queued = pending; pending = null;
      if (enabled) for (const [body, final] of queued) post({ ...body, build }, final);
    });

  function drainFrames() {
    const frames = state.engine?.presentFrames?.();
    if (!frames) return null;
    const { intervals, times, lost } = frames;
    totals.lost += lost;
    const stats = frameStats(intervals, times);
    totals.frames += stats.count; totals.over33 += stats.over33; totals.over50 += stats.over50;
    for (const value of intervals) totals.histogram[buckets.findIndex(limit => value < limit)]++;
    totals.worst = [...totals.worst, ...stats.worst].sort((a, b) => b.ms - a.ms).slice(0, 5);
    return { ...stats, lost, windowMs: intervals.length ? Math.round(times[times.length - 1] - times[0]) : 0 };
  }
  function sample() {
    // After a crash a dead pthread may still hold the mixer/allocator locks;
    // never call into WASM then (the end record uses the last live sample).
    const live = !crashSent && !state.engineStopped;
    const memory = !live ? null : (() => { try { return state.engine?.telemetryMemory?.() ?? null; } catch (error) { return { error: error.message }; } })();
    if (memory) lastMemory = memory;
    let audio = null;
    try {
      const snapshot = live ? state.engine?.audioSnapshot?.() : null;
      if (snapshot) {
        audio = { contextState: snapshot.contextState, consumer: snapshot.consumer, underruns: snapshot.underruns,
          overruns: snapshot.overruns, fill: snapshot.fill, mixerDropped: snapshot.mixerDropped ?? null,
          discardedFrames: state.audioDiscardedFrames ?? 0 };
        audio.newUnderruns = lastAudio ? audio.underruns - lastAudio.underruns : audio.underruns;
        lastAudio = audio;
      }
    } catch (error) { audio = { error: error.message }; }
    const heap = performance.memory ? { usedJSHeap: performance.memory.usedJSHeapSize,
      totalJSHeap: performance.memory.totalJSHeapSize, limitJSHeap: performance.memory.jsHeapSizeLimit } : null;
    return { memory, audio, jsHeap: heap, renderer: { chosen: state.renderer ?? null, requested: state.rendererRequested ?? null,
        reason: state.rendererReason ?? null, detail: state.rendererDetail ?? null }, warmGate: state.warmGate ?? null, visibility: document.visibilityState, focused: document.hasFocus(), hiddenCount,
      pointerLocked: Boolean(document.pointerLockElement), fullscreen: Boolean(document.fullscreenElement),
      counters: { consoleErrors: state.consoleErrors, scriptExceptions: state.scriptExceptions, glErrors: state.glErrors,
        inputEvents: state.inputEvents, inputDropped: state.inputDropped, consoleDiscarded: state.consoleDiscarded ?? 0 } };
  }
  function periodic() {
    if (!state.timings.wasmReady || state.engineStopped) return;
    send('periodic', { frames: drainFrames(), ...sample() });
  }
  function tail() {
    return state.console.slice(-logTail).map(row => ({ ms: Math.round(row.ms), error: row.error || undefined,
      message: row.message.length > lineChars ? row.message.slice(0, lineChars) + '…' : row.message }));
  }

  telemetry.crash = (message, detail = {}) => {
    if (crashSent >= 6) return;
    const first = crashSent++ === 0;
    const record = () => ({ message: String(message), stack: detail.stack ?? null, source: detail.source ?? null,
      sinceStartMs: Math.round(performance.now()), timings: state.timings, errors: state.errors.slice(-20),
      lastMemory, exitCode: state.exitCode ?? null });
    if (!first) { send('crash-secondary', record()); return; }
    // Workers report stacks just after the fatal line; give them a moment to land.
    const flush = () => {
      if (!crashTimer) return;
      clearTimeout(crashTimer); crashTimer = null;
      let frames = null; try { frames = drainFrames(); } catch { /* engine views may be gone */ }
      send('crash', { ...record(), frames, log: tail(), consoleLines: state.console.length }, ended);
    };
    crashTimer = setTimeout(flush, 750);
    telemetry.flushCrash = flush;
    if (ended) flush();
  };
  telemetry.error = (source, message, stack = null) => {
    if (errorsSent++ >= 30) return;
    send('error', { source, message: String(message).slice(0, 4000), stack, sinceStartMs: Math.round(performance.now()) });
  };

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') hiddenCount++; });
  window.addEventListener('pagehide', () => {
    if (ended) return;
    ended = true; clearInterval(timer);
    telemetry.flushCrash?.();
    let frames = null; try { frames = drainFrames(); } catch { /* ignore */ }
    send('end', { frames, totals: { ...totals, histogramLimitsMs: buckets.map(String) }, sinceStartMs: Math.round(performance.now()),
      timings: state.timings, crashed: crashSent > 0, errorKind: state.errorKind ?? null, lastMemory,
      ...sample() }, true);
  });

  ready.then(async () => {
    if (!enabled) return;
    const raf = await measureRaf();
    send('start', { userAgent: navigator.userAgent, platform: navigator.userAgentData?.platform ?? navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency ?? null, deviceMemory: navigator.deviceMemory ?? null,
      screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight,
        colorDepth: screen.colorDepth }, devicePixelRatio, viewport: { width: innerWidth, height: innerHeight },
      raf, webgl: rendererInfo(), crossOriginIsolated, pointerLockOptions: pointerLockOptions ?? 'none (requestPointerLock())',
      headlessTest: Boolean(globalThis.__headlessInput), rendererRoute: state.rendererRoute ?? null,
      url: location.pathname + location.search });
    timer = setInterval(periodic, periodMs);
  });
  return telemetry;
}
