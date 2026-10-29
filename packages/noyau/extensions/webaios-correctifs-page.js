// WebAiOs : correctifs posés en tête des scripts de contenu des extensions (Store et agent).
// Electron n'a pas de chrome.storage.sync : il est redéfini sur chrome.storage.local, et `browser` pointe sur
// `chrome` (extensions écrites pour Firefox). Sans effet si déjà fait.
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
