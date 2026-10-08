// WasmFS icase delegates lookup to the backing directory using LOWERCASE names.
// The downloader must store those names physically lowercase; URLs and manifest
// paths retain their original spelling and hashes. Scope this to its worker.
export function installIcaseStorage() {
  for (const method of ['getDirectoryHandle', 'getFileHandle']) {
    const original = FileSystemDirectoryHandle.prototype[method];
    FileSystemDirectoryHandle.prototype[method] = function(name, options) {
      return original.call(this, name.toLowerCase(), options);
    };
  }
}
