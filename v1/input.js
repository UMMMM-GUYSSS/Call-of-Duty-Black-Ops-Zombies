// src/win32/win_wndproc.cpp:virtualKeyConvert/MapKey, src/ui/keycodes.h.
// Physical US punctuation codes; text characters are delivered separately.
export const codeToKey = {
  Backquote: 126, Backspace: 127, Tab: 9, Enter: 13, Escape: 27, Space: 32,
  ShiftLeft: 160, ShiftRight: 160, ControlLeft: 159, ControlRight: 159,
  AltLeft: 158, AltRight: 158, CapsLock: 151, Pause: 153,
  ArrowUp: 154, ArrowDown: 155, ArrowLeft: 156, ArrowRight: 157,
  Insert: 161, Delete: 162, PageDown: 163, PageUp: 164, Home: 165, End: 166,
  Numpad0: 192, Numpad1: 188, Numpad2: 189, Numpad3: 190, Numpad4: 185,
  Numpad5: 186, Numpad6: 187, Numpad7: 182, Numpad8: 183, Numpad9: 184,
  NumpadEnter: 191, NumpadDecimal: 193, NumpadDivide: 194,
  NumpadSubtract: 195, NumpadAdd: 196, NumLock: 197, NumpadMultiply: 198, NumpadEqual: 199,
  Semicolon: 59, Equal: 61, Comma: 44, Minus: 45, Period: 46, Slash: 47,
  BracketLeft: 91, Backslash: 92, BracketRight: 93, Quote: 39,
};
for (let i = 0; i < 26; i++) codeToKey['Key' + String.fromCharCode(65 + i)] = 97 + i;
for (let i = 0; i < 10; i++) codeToKey['Digit' + i] = 48 + i;
for (let i = 1; i <= 15; i++) codeToKey['F' + i] = 166 + i;
// Pointer-lock request options (reported by telemetry). null: requestPointerLock()
// without unadjustedMovement, i.e. OS acceleration applies to movementX/Y.
export const pointerLockOptions = null;
// Browser: left/middle/right/back/forward -> engine: left/right/middle/back/forward.
const mouseKeys = [200, 202, 201, 203, 204];
// Chrome (Windows) sometimes reports one huge movementX/Y right after the pointer
// lock is (re)acquired or the window regains focus, which snaps the aim
// elsewhere. Same guard as the vel.gg speedrun game: ignore motion for a short
// warmup after a lock change / refocus, and drop single implausible jumps.
const lockWarmupMs = 120, maxMotionDelta = 300;

// webmenu: Escape belongs to the game, as on desktop. Locked: relative motion
// for gameplay. Unlocked while a game menu owns the cursor: absolute canvas
// pixels (engine CL_MouseEvent -> UI_MouseEvent scales them to 640x480).
// Unlocked in gameplay: the next canvas click re-locks (a user gesture).
export function captureInput(canvas, send, hooks = {}) {
  const held = new Map(), listeners = [];
  let wheelRemainder = 0, enabled = false, escapeAt = -1e9, injectedAt = -1e9, blurAt = -1e9, selfRelease = false;
  function on(target, name, callback, options) {
    target.addEventListener(name, callback, options);
    listeners.push(() => target.removeEventListener(name, callback, options));
  }
  const emit = event => send({ ...event, time: performance.now() });
  const locked = () => document.pointerLockElement === canvas;
  const menu = () => Boolean(hooks.menuOpen?.());
  // Keys go to the game whenever it owns the page (locked, or a game menu).
  const active = () => enabled && (locked() || menu());
  let lockChangeAt = -1e9;
  const motion = event => emit({ kind: 'mouse', dx: event.movementX, dy: event.movementY });
  const spurious = event => performance.now() - lockChangeAt < lockWarmupMs
    || Math.abs(event.movementX || 0) > maxMotionDelta || Math.abs(event.movementY || 0) > maxMotionDelta;
  function cursor(event) {
    const rect = canvas.getBoundingClientRect(), size = hooks.size?.() ?? canvas;
    emit({ kind: 'cursor', x: Math.round((event.clientX - rect.left) * size.width / rect.width),
      y: Math.round((event.clientY - rect.top) * size.height / rect.height) });
  }
  function release() {
    for (const key of new Set(held.values())) emit({ kind: 'key', key, down: false });
    held.clear(); wheelRemainder = 0;
  }
  function pressEscape() { emit({ kind: 'key', key: 27, down: true }); emit({ kind: 'key', key: 27, down: false }); }
  // Capture Escape before the browser/test stub releases the lock.
  on(document, 'keydown', event => {
    const key = codeToKey[event.code];
    // The Escape that cost the pointer lock was already forwarded (once).
    if (key === 27 && enabled && performance.now() - injectedAt < 500) { event.preventDefault(); return; }
    if (!active()) return;
    if (key === undefined) return;
    event.preventDefault();
    if (key === 27) escapeAt = performance.now();
    if (!held.has(event.code)) {
      if (![...held.values()].includes(key)) emit({ kind: 'key', key, down: true });
      held.set(event.code, key);
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) emit({ kind: 'char', char: event.key.codePointAt(0) });
  }, { capture: true });
  on(document, 'keyup', event => {
    const key = held.get(event.code);
    if (key === undefined) return;
    event.preventDefault(); held.delete(event.code);
    if (![...held.values()].includes(key)) emit({ kind: 'key', key, down: false });
  });
  on(document, 'mousemove', event => {
    if (!enabled) return;
    if (locked()) { if (!spurious(event)) motion(event); } else if (menu() && event.target === canvas) cursor(event);
  });
  for (const name of ['mousedown', 'mouseup']) on(document, name, event => {
    if (!enabled) return;
    const down = name === 'mousedown';
    if (!locked() && !menu()) {
      // Gameplay without the mouse: this click only re-captures it.
      if (down && event.button === 0 && event.target === canvas) { event.preventDefault(); hooks.relock?.(); }
      return;
    }
    if (!locked() && event.target !== canvas) return;
    const key = mouseKeys[event.button];
    if (key === undefined) return;
    event.preventDefault(); canvas.focus();
    if (!locked()) cursor(event);
    const code = 'mouse' + event.button;
    if (down) { if (held.has(code)) return; held.set(code, key); }
    else if (!held.delete(code)) return;
    emit({ kind: 'key', key, down });
  });
  on(document, 'wheel', event => {
    if (!active()) return;
    event.preventDefault();
    // One wheel detent => a key pulse, retaining fractional trackpad movement.
    wheelRemainder += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.height : 1);
    while (Math.abs(wheelRemainder) >= 100) {
      const key = wheelRemainder > 0 ? 205 : 206;
      emit({ kind: 'key', key, down: true }); emit({ kind: 'key', key, down: false });
      wheelRemainder -= Math.sign(wheelRemainder) * 100;
    }
  }, { passive: false });
  on(canvas, 'contextmenu', event => event.preventDefault());
  on(window, 'blur', () => { blurAt = performance.now(); release(); });
  on(window, 'focus', () => { lockChangeAt = performance.now(); });
  on(document, 'pointerlockchange', () => {
    lockChangeAt = performance.now();
    const nowLocked = locked();
    release();
    emit({ kind: 'pointer-lock', locked: nowLocked || (enabled && menu()) });
    // A new lock starts a new session: an older page-seen Escape cannot explain its loss.
    if (nowLocked) escapeAt = -1e9;
    if (nowLocked || !enabled) { selfRelease = false; return; }
    // Browsers take Escape to leave pointer lock (Chrome may not deliver the
    // key). Hand it to the game unless the page saw that Escape, the page
    // released the mouse for a game menu, or the tab lost focus.
    // A focus loss (Alt+Tab) also releases it: wait briefly for its blur.
    const lostAt = performance.now(), byPage = selfRelease;
    selfRelease = false;
    if (byPage || lostAt - escapeAt < 500 || menu()) return;
    setTimeout(() => {
      if (!enabled || locked() || blurAt >= lostAt || escapeAt >= lostAt || menu()) return;
      pressEscape(); injectedAt = performance.now(); state.injectedEscapes++;
    }, 60);
  });
  const state = { injectedEscapes: 0 };
  return { release, motion, state, pressEscape,
    dispose() { release(); listeners.forEach(remove => remove()); },
    enable(value) { enabled = value; if (!value) release(); },
    // Free the cursor for a game menu without sending the game an Escape.
    unlock() { if (locked()) { selfRelease = true; document.exitPointerLock(); } },
    lock: () => pointerLockOptions ? canvas.requestPointerLock(pointerLockOptions) : canvas.requestPointerLock() };
}
