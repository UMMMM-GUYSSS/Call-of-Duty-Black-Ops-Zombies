// Size once before OffscreenCanvas transfer. Resize only the CSS rectangle:
// the engine keeps its render targets and projection at this fixed resolution.
export function sizeGameCanvas(canvas) {
  const width = Math.max(1, innerWidth), height = Math.max(1, innerHeight);
  const density = Math.min(devicePixelRatio || 1, 1920 / width, 1440 / height);
  const scale = Math.max(density, 800 / width, 600 / height);
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const buffer = { width: canvas.width, height: canvas.height, devicePixelRatio };
  function fit() {
    const scale = Math.min(innerWidth / buffer.width, innerHeight / buffer.height);
    canvas.style.width = `${buffer.width * scale}px`;
    canvas.style.height = `${buffer.height * scale}px`;
  }
  fit();
  window.addEventListener('resize', fit);
  return { ...buffer, dispose: () => window.removeEventListener('resize', fit) };
}
