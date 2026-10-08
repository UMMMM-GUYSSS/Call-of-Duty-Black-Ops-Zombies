import { checkRenderer } from './capabilities.js';

// Use a disposable canvas: #game belongs exclusively to the engine pthread.
self.onmessage = ({ data: canvas }) => {
  const features = [
    [navigator.storage?.getDirectory && self.FileSystemFileHandle?.prototype.createSyncAccessHandle && navigator.locks, 'worker OPFS storage'],
    [self.requestAnimationFrame, 'worker animation frames'],
  ];
  for (const [supported, feature] of features) {
    if (!supported) {
      self.postMessage({ kind: 'browser', message: `This browser is missing ${feature}. Use a current desktop Chrome, Edge or Firefox.` });
      return;
    }
  }
  const gl = canvas.getContext('webgl2');
  const failure = checkRenderer(gl);
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  self.postMessage(failure);
};
