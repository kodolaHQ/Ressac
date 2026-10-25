import type { WebContents } from "electron";
import type { Action } from "../../commun/api";
import type { IdOnglet, Onglet } from "../../commun/modele";

type Champs = Partial<Pick<Onglet, "url" | "titre" | "favicon" | "chargement" | "peutReculer" | "peutAvancer" | "zoom" | "plante">>;

/** Ce que l'historique reçoit d'une page web. */
export interface NotesHistorique {
  noter(v: { url: string; titre: string }): void;
  majTitre(url: string, titre: string): void;
}

const historisable = (url: string) => url.startsWith("http://") || url.startsWith("https://");

/** Traduit les événements d'une page web en `majOnglet`, et note les visites dans l'historique. */
export function brancherEvenements(wc: WebContents, id: IdOnglet, agir: (a: Action) => void, historique?: NotesHistorique): void {
  const maj = (champs: Champs) => agir({ type: "majOnglet", id, champs });
  const navigation = () => ({ peutReculer: wc.navigationHistory.canGoBack(), peutAvancer: wc.navigationHistory.canGoForward() });

  const noter = (url: string) => {
    if (historisable(url)) historique?.noter({ url, titre: wc.getTitle() || url });
  };

  wc.on("page-title-updated", (_e, titre) => {
    maj({ titre });
    if (historisable(wc.getURL())) historique?.majTitre(wc.getURL(), titre);
  });
  wc.on("page-favicon-updated", (_e, favicons) => maj({ favicon: favicons[0] ?? null }));
  wc.on("did-navigate", (_e, url) => {
    maj({ url, ...navigation() });
    noter(url);
  });
  // Les sites à une seule page (YouTube…) changent d'URL sans recharger : chaque URL compte.
  wc.on("did-navigate-in-page", (_e, url, principal) => {
    if (!principal) return;
    maj({ url, ...navigation() });
    noter(url);
  });
  wc.on("did-start-loading", () => maj({ chargement: true, plante: false }));
  wc.on("did-stop-loading", () => maj({ chargement: false, ...navigation() }));
  wc.on("render-process-gone", (_e, d) => {
    if (d.reason !== "clean-exit") maj({ plante: true, chargement: false });
  });
}
