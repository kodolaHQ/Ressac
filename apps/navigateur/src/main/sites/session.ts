import { session, type Session } from "electron";
import { ID_SITE } from "@webaios/noyau";
import { preferencesWeb } from "../onglets/vues";
import { refuserPermissions } from "../permissions";

/** Partition d'une appli de site : jamais celle d'un espace, d'une application ni d'une autre appli de site. */
export const partitionSite = (id: string) => `persist:site-${id}`;

/** Le plein écran seul (vidéos) ; la lecture automatique passe par `preferencesSite`. Presse-papiers compris, tout le reste est refusé. */
const PERMISES_SITE: ReadonlySet<string> = new Set(["fullscreen"]);

/** Chemin du preload `site.js`, fixé une fois au démarrage des applis de site (`demarrerSites`). */
let preloadSite: string | null = null;

/** Le preload des applis de site : fixé une seule fois, jamais changé ensuite. */
export function fixerPreloadSite(chemin: string): void {
  if (preloadSite !== null && preloadSite !== chemin) throw new Error("preload des applis de site déjà fixé");
  preloadSite = chemin;
}

/** Sessions déjà préparées (une par id, gardée par Electron toute la vie du navigateur). */
const preparees = new WeakSet<Session>();

/**
 * La session d'une appli de site, préparée une fois : plein écran seul, aucun périphérique, téléchargements annulés, le
 * preload `site.js` sur chaque cadre. Aucune extension n'y est jamais chargée.
 */
export function sessionSite(id: string): Session {
  if (!ID_SITE.test(id)) throw new Error(`id d'appli de site invalide : ${id}`);
  if (preloadSite === null) throw new Error("preload des applis de site non fixé");
  const s = session.fromPartition(partitionSite(id));
  if (!preparees.has(s)) {
    refuserPermissions(s, PERMISES_SITE);
    s.registerPreloadScript({ id: "webaios-site", type: "frame", filePath: preloadSite });
    s.on("will-download", (e, item) => {
      e.preventDefault();
      item.cancel();
    });
    preparees.add(s);
  }
  return s;
}

/** Celles d'un onglet, et les vidéos lancées sans geste (spec §3.4). */
export function preferencesSite(s: Session) {
  return { ...preferencesWeb(s), autoplayPolicy: "no-user-gesture-required" as const };
}

/** Efface cookies, stockage et cache de l'appli (suppression) : une nouvelle appli au même id repart vide. */
export async function effacerSessionSite(id: string): Promise<void> {
  if (!ID_SITE.test(id)) throw new Error(`id d'appli de site invalide : ${id}`);
  const s = session.fromPartition(partitionSite(id));
  await s.clearStorageData();
  await s.clearCache();
}
