// WebAiOs: fixes placed at the head of an extension's content scripts. chrome.storage.sync is replaced by
// chrome.storage.local, and `browser` points at `chrome` (extensions written for Firefox). No effect if already done.
(() => {
  const c = globalThis.chrome;
  const stockage = c && c.storage;
  if (stockage && stockage.local && stockage.sync !== stockage.local) {
    try {
      Object.defineProperty(stockage, "sync", { value: stockage.local, configurable: true, writable: true, enumerable: true });
    } catch {
      // Propriété non redéfinissable : laissée telle quelle.
    }
  }
  if (c && globalThis.browser !== c) {
    try {
      globalThis.browser = c;
    } catch {
      // `browser` en lecture seule : laissé tel quel.
    }
  }
})();
