/** Ce qu'attendreChargement utilise d'un WebContents. */
export interface PageEnChargement {
  isLoading(): boolean;
  once(evenement: "did-stop-loading", f: () => void): unknown;
  removeListener(evenement: "did-stop-loading", f: () => void): unknown;
}

/** Attend la fin du chargement de la page, au plus `delaiMs` ; l'écouteur est retiré dans les deux cas. */
export function attendreChargement(wc: PageEnChargement, delaiMs: number): Promise<void> {
  if (!wc.isLoading()) return Promise.resolve();
  return new Promise<void>((ok) => {
    const fin = () => {
      clearTimeout(minuterie);
      wc.removeListener("did-stop-loading", fin);
      ok();
    };
    const minuterie = setTimeout(fin, delaiMs);
    wc.once("did-stop-loading", fin);
  });
}
