import type { WebContents } from "electron";
import type { Action } from "../../commun/api";
import type { IdOnglet, Onglet } from "../../commun/modele";

type Champs = Partial<Pick<Onglet, "url" | "titre" | "favicon" | "chargement" | "peutReculer" | "peutAvancer" | "zoom" | "plante">>;

/** Traduit les événements d'une page web en `majOnglet`. */
export function brancherEvenements(wc: WebContents, id: IdOnglet, agir: (a: Action) => void): void {
  const maj = (champs: Champs) => agir({ type: "majOnglet", id, champs });
  const historique = () => ({ peutReculer: wc.navigationHistory.canGoBack(), peutAvancer: wc.navigationHistory.canGoForward() });

  wc.on("page-title-updated", (_e, titre) => maj({ titre }));
  wc.on("page-favicon-updated", (_e, favicons) => maj({ favicon: favicons[0] ?? null }));
  wc.on("did-navigate", (_e, url) => maj({ url, ...historique() }));
  wc.on("did-navigate-in-page", (_e, url, principal) => {
    if (principal) maj({ url, ...historique() });
  });
  wc.on("did-start-loading", () => maj({ chargement: true, plante: false }));
  wc.on("did-stop-loading", () => maj({ chargement: false, ...historique() }));
  wc.on("render-process-gone", (_e, d) => {
    if (d.reason !== "clean-exit") maj({ plante: true, chargement: false });
  });
}
