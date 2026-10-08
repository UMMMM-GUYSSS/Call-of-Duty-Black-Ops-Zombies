import { installIcaseStorage } from './opfs-icase.js';
installIcaseStorage();
// Dynamic import yields: retain the page's initial request until the pack
// worker installs its handler, otherwise a fast postMessage can be lost.
const pending = [];
self.onmessage = event => pending.push(event);
// Retain the pack lane's streaming hash, range resume, batching and journal.
await import('./download-worker.js');
for (const event of pending) self.onmessage(event);
