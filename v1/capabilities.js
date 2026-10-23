// Observable renderer contract: src/web/gl/web_requirements.h and
// notes/web-int-{caps-report,formats}.md. Keep the game's canvas untouched:
// Emscripten transfers it directly to the main engine pthread.
export async function checkCapabilities() {
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))
    return { kind: 'mobile', message: 'Five is built for a desktop computer with a keyboard and mouse. Open this link in a current Chrome, Edge or Firefox on your desktop.' };
  if (!isSecureContext) return { kind: 'secure', message: 'Open the HTTPS link. For local play, use http://127.0.0.1:8080. Plain HTTP on a remote computer cannot run Five.' };
  if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined')
    return { kind: 'browser', message: 'Shared memory is unavailable. Open this link directly in a current desktop Chrome, Edge or Firefox. The host must enable cross-origin isolation (COOP and COEP headers).' };
  const features = [
    [navigator.storage?.getDirectory && navigator.storage.estimate && navigator.storage.persist && navigator.locks, 'private file storage (OPFS, quota checks and Web Locks)'],
    [window.AudioWorkletNode && window.AudioContext && 'audioWorklet' in AudioContext.prototype, 'AudioWorklet sound'],
    [window.Worker && HTMLCanvasElement.prototype.transferControlToOffscreen, 'OffscreenCanvas in a worker'],
    [Element.prototype.requestPointerLock && Document.prototype.exitPointerLock, 'pointer lock for mouse aiming'],
    [typeof WebAssembly === 'object' && WebAssembly.Tag, 'WebAssembly exception handling'],
  ];
  for (const [supported, feature] of features)
    if (!supported) return { kind: 'browser', message: `This browser is missing ${feature}. Use a current desktop Chrome, Edge or Firefox, and allow site storage.` };
  try {
    // One page tests shared Wasm memory without reserving the game's 1.5 GiB twice.
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 24576, shared: true });
    const threads = new Uint8Array([0,97,115,109,1,0,0,0,5,4,1,3,1,1]);
    const simd = new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,22,1,20,0,253,12,...Array(16).fill(0),11]);
    if (!(memory.buffer instanceof SharedArrayBuffer) || !WebAssembly.validate(threads) || !WebAssembly.validate(simd)) throw new Error();
  } catch {
    return { kind: 'browser', message: 'WebAssembly threads or SIMD are unavailable. Update your desktop browser and use its 64-bit version. Five needs a 1.5 GiB game heap plus room for graphics and sound.' };
  }
  // jspicheck: the engine needs JSPI (WebAssembly.Suspending). Edge's "Enhance your security on the web" runs unfamiliar
  // sites without the JIT, which keeps WebAssembly but drops JSPI (checked: Edge 154 with --jitless --wasm-jitless).
  // Players hit "WebAssembly.Suspending is not a constructor" after the download had started.
  if (typeof WebAssembly.Suspending !== 'function')
    return { kind: 'browser', message: /\bEdg\//.test(navigator.userAgent)
      ? 'Microsoft Edge\'s "Enhance your security on the web" setting is switching off a feature the game needs on this site. In Edge, open Settings, then Privacy, search, and services, then Security. Under "Enhance your security on the web", choose Exceptions, add https://vel.gg, and reload this page. Or open this link in Chrome or Firefox.'
      : 'This browser is missing WebAssembly JSPI, which the game needs. Update to a current desktop Chrome, Edge or Firefox. If you turned off the JavaScript optimizer (V8 optimizer) for sites, allow it for https://vel.gg.' };
  const gl = document.createElement('canvas').getContext('webgl2');
  const failure = checkRenderer(gl);
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  if (failure) return failure;
  return new Promise(resolve => {
    let worker;
    const finish = result => { clearTimeout(timer); worker?.terminate(); resolve(result); };
    const unavailable = { kind: 'browser', message: 'Worker graphics or private file storage could not start. Update your desktop browser, allow site storage, and reload. The host must allow same-origin module workers.' };
    const timer = setTimeout(() => finish(unavailable), 8000);
    try {
      worker = new Worker(new URL('./capability-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => finish(data);
      worker.onerror = event => { event.preventDefault(); finish(unavailable); };
      const canvas = document.createElement('canvas').transferControlToOffscreen();
      worker.postMessage(canvas, [canvas]);
    } catch { finish(unavailable); }
  });
}

export function checkRenderer(gl) {
  if (!gl) return { kind: 'gpu', message: 'WebGL2 is unavailable. Enable graphics acceleration in your browser settings, restart the browser, and update your graphics driver.' };
  const missing = [];
  for (const name of ['WEBGL_compressed_texture_s3tc', 'EXT_color_buffer_float'])
    if (!gl.getExtension(name)) missing.push(name);
  if (!gl.getExtension('EXT_texture_norm16')) {
    for (const name of ['OES_texture_float_linear', 'EXT_float_blend'])
      if (!gl.getExtension(name)) missing.push(name);
  }
  for (const [name, minimum] of [['MAX_TEXTURE_SIZE', 2048], ['MAX_3D_TEXTURE_SIZE', 256],
    ['MAX_TEXTURE_IMAGE_UNITS', 16], ['MAX_VERTEX_TEXTURE_IMAGE_UNITS', 4],
    ['MAX_COMBINED_TEXTURE_IMAGE_UNITS', 20], ['MAX_VERTEX_UNIFORM_VECTORS', 264],
    ['MAX_FRAGMENT_UNIFORM_VECTORS', 264], ['MAX_VERTEX_ATTRIBS', 16]])
    if (gl.getParameter(gl[name]) < minimum) missing.push(`${name} ≥ ${minimum}`);
  return missing.length ? { kind: 'gpu', message: `Your graphics setup is missing ${missing.join(', ')}. Enable graphics acceleration, update your driver, or try another computer.` } : null;
}
