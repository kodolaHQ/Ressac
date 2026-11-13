// Ressac: fixes placed at the head of an extension's content scripts. chrome.storage.sync is replaced by
// chrome.storage.local, and `browser` points at `chrome` (extensions written for Firefox). No effect if already done.
(() => {
  const c = globalThis.chrome;
  const storage = c && c.storage;
  if (storage && storage.local && storage.sync !== storage.local) {
    try {
      Object.defineProperty(storage, "sync", { value: storage.local, configurable: true, writable: true, enumerable: true });
    } catch {
      // Property that cannot be redefined: left as it is.
    }
  }
  if (c && globalThis.browser !== c) {
    try {
      globalThis.browser = c;
    } catch {
      // `browser` read-only: left as it is.
    }
  }
})();
