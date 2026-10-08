// fpsui: opt-in performance readout (?perf=1 on index/five/kino; landing.js keeps the query on the map page).
// Imported only when the query asks for it, so it costs nothing otherwise. Page-side only: it reads
//  - engine presents: the GL owner's per-Present intervals from the engine's shared ring (engine.presentReader(),
//    its own cursor, so telemetry's 10 s drain still sees every frame) -- this is the game's real frame time;
//  - page rAF: the page main thread's requestAnimationFrame cadence (display/compositor + main-thread stalls);
//  - long tasks: PerformanceObserver('longtask') on the page main thread (busy % = long-task ms / window).
// Render-thread busy % needs an engine export that does not exist yet; reported as null.
// A small corner box (pointer-events: none, so it never takes input) refreshes twice a second, and
// window.__perfStats holds the same numbers plus one summary per 5 s window (last 10 min) and session totals.
const WINDOW_MS = 5000, UPDATE_MS = 500, HISTORY = 120;
const now = () => performance.timeOrigin + performance.now(); // epoch ms, the clock of the present ring

function summarize(samples, windowMs) {
  const n = samples.length;
  if (!n) return { frames: 0, fps: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null, over33: 0, over100: 0 };
  const sorted = Float64Array.from(samples, s => s.ms).sort();
  const pick = q => +sorted[Math.min(n - 1, Math.floor(q * n))].toFixed(1);
  let over33 = 0, over100 = 0;
  for (const s of samples) { if (s.ms > 33) over33++; if (s.ms > 100) over100++; }
  return { frames: n, fps: +(n * 1000 / windowMs).toFixed(1), p50Ms: pick(0.5), p95Ms: pick(0.95), p99Ms: pick(0.99),
    maxMs: +sorted[n - 1].toFixed(1), over33, over100 };
}
function prune(list, from) { let i = 0; while (i < list.length && list[i].t < from) i++; if (i) list.splice(0, i); }

export function startPerfOverlay() {
  if (globalThis.__perfOverlay) return globalThis.__perfOverlay;
  const presents = [], rafs = [], longTasks = [];
  const totals = { since: new Date().toISOString(), presents: 0, over33: 0, over100: 0, maxMs: 0, lost: 0,
    longTasks: 0, longTaskMs: 0 };
  const history = [];
  let reader = null, readerEngine = null, lastRaf = 0, lastPresent = 0, windowStart = now(), windowPresents = [];

  const rafTick = t => {
    if (lastRaf && document.visibilityState === 'visible') rafs.push({ t: performance.timeOrigin + t, ms: t - lastRaf });
    lastRaf = t; requestAnimationFrame(rafTick);
  };
  requestAnimationFrame(rafTick);
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        longTasks.push({ t: performance.timeOrigin + entry.startTime, ms: entry.duration });
        totals.longTasks++; totals.longTaskMs += entry.duration;
      }
    }).observe({ type: 'longtask', buffered: false });
  } catch { /* longtask unsupported (Firefox/Safari): reported as null */ }
  const longTaskSupported = PerformanceObserver.supportedEntryTypes?.includes('longtask') ?? false;

  const box = document.createElement('div');
  box.id = 'perf-overlay';
  box.setAttribute('aria-hidden', 'true');
  Object.assign(box.style, { position: 'fixed', top: '4px', left: '4px', zIndex: 2147483647, pointerEvents: 'none',
    userSelect: 'none', font: '11px/1.35 ui-monospace, Consolas, monospace', color: '#e8e8e8', whiteSpace: 'pre',
    background: 'rgba(0,0,0,0.62)', padding: '4px 6px', borderRadius: '3px' });

  function drain() {
    const engine = globalThis.five?.engine;
    if (engine !== readerEngine) { readerEngine = engine; reader = engine?.presentReader?.() ?? null; }
    let frames = null;
    try { frames = reader?.(); } catch { frames = null; } // engine stopped/crashed: keep the last numbers
    if (!frames) return;
    totals.lost += frames.lost;
    for (let i = 0; i < frames.intervals.length; ++i) {
      const sample = { t: frames.times[i], ms: frames.intervals[i] };
      presents.push(sample); windowPresents.push(sample);
      totals.presents++; if (sample.ms > 33) totals.over33++; if (sample.ms > 100) totals.over100++;
      if (sample.ms > totals.maxMs) totals.maxMs = +sample.ms.toFixed(1);
      lastPresent = sample.t;
    }
  }
  function update() {
    drain();
    const t = now(), from = t - WINDOW_MS;
    prune(presents, from); prune(rafs, from); prune(longTasks, from);
    const span = Math.min(WINDOW_MS, t - started);
    const longMs = longTasks.reduce((sum, task) => sum + task.ms, 0);
    const state = globalThis.five;
    const stats = {
      updatedAt: new Date().toISOString(), windowMs: Math.round(span), screen: state?.screen ?? null,
      renderer: state?.renderer ?? null, visibility: document.visibilityState, focused: document.hasFocus(),
      fullscreen: Boolean(document.fullscreenElement), pointerLocked: Boolean(document.pointerLockElement),
      dpr: devicePixelRatio, screenSize: `${screen.width}x${screen.height}`,
      present: { ...summarize(presents, span), sinceLastMs: lastPresent ? Math.round(t - lastPresent) : null },
      raf: summarize(rafs, span),
      longTasks: longTaskSupported ? { count: longTasks.length, totalMs: Math.round(longMs),
        busyPct: +(100 * longMs / span).toFixed(1) } : null,
      renderThreadBusyPct: null, // needs an engine-side export (not in this build)
      totals, history };
    if (t - windowStart >= WINDOW_MS) { // one non-overlapping 5 s summary for the history
      history.push({ at: stats.updatedAt, screen: stats.screen, ...summarize(windowPresents, t - windowStart),
        rafP95Ms: stats.raf.p95Ms, longTaskMs: stats.longTasks?.totalMs ?? null });
      if (history.length > HISTORY) history.shift();
      windowStart = t; windowPresents = [];
    }
    globalThis.__perfStats = stats;
    render(stats);
  }
  const fmt = v => v === null || v === undefined ? '  -  ' : String(v).padStart(5);
  function render(s) {
    if (!box.isConnected) (document.body ?? document.documentElement).append(box); // landing replaces <body>
    const p = s.present, r = s.raf;
    box.textContent =
      `game ${fmt(p.fps)} fps  p50 ${fmt(p.p50Ms)} p95 ${fmt(p.p95Ms)} max ${fmt(p.maxMs)} ms\n` +
      `      >33ms ${String(p.over33).padStart(3)}  >100ms ${String(p.over100).padStart(3)}  (last ${Math.round(s.windowMs / 1000)} s)\n` +
      `page ${fmt(r.fps)} fps  p50 ${fmt(r.p50Ms)} p95 ${fmt(r.p95Ms)} max ${fmt(r.maxMs)} ms  >33 ${r.over33}\n` +
      `main long tasks ${s.longTasks ? `${s.longTasks.count} / ${s.longTasks.totalMs} ms (${s.longTasks.busyPct}%)` : 'n/a'}` +
      `  render busy n/a` + (p.sinceLastMs > 250 ? `\nno present for ${p.sinceLastMs} ms` : '');
  }
  const started = now();
  const timer = setInterval(update, UPDATE_MS);
  update();
  return globalThis.__perfOverlay = { box, update, stop() { clearInterval(timer); box.remove(); } };
}
