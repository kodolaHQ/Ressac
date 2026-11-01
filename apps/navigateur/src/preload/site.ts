/**
 * Preload des applis de site, enregistré sur la seule session `persist:site-<id>` (`sessionSite`) : il tourne dans le
 * cadre principal et dans chaque sous-cadre. Il demande au process principal ce qui va dans ce cadre (décidé depuis
 * l'expéditeur, jamais d'après ce que dit le cadre), pose le CSS de l'agent, puis lance la garde des extensions et ses
 * scripts dans le monde des retouches (`MONDE_RETOUCHES`) : jamais dans celui de la page, ni dans celui-ci (qui a
 * `ipcRenderer`). `webaiosSite` n'est exposé qu'à ce monde, et seulement dans le cadre principal.
 */
import { contextBridge, ipcRenderer, webFrame } from "electron";
import { CANAUX_PRELOAD_SITE as CANAUX, MONDE_RETOUCHES } from "../commun/preload-site";
import type { InjectionCadre } from "../commun/sites";

type ReponseMemoire = { ok: true; valeur?: unknown } | { ok: false; erreur: string };

/** Ce qui va dans ce cadre ; null (rien) si le process principal ne répond pas comme prévu. */
function demander(): InjectionCadre | null {
  try {
    const r: unknown = ipcRenderer.sendSync(CANAUX.injection);
    if (!r || typeof r !== "object") return null;
    const i = r as InjectionCadre;
    return Array.isArray(i.css) && Array.isArray(i.js) && Array.isArray(i.hotes) ? i : null;
  } catch {
    return null;
  }
}

/** Une demande à la mémoire de l'appli (un seul appel) ; un refus rejette avec le message de la mémoire. */
async function memoire(demande: { op: "retenir" | "lire" | "oublier"; cle: unknown; valeur?: unknown }): Promise<unknown> {
  let envoi = demande;
  if (demande.op === "retenir") {
    try {
      structuredClone(demande.valeur);
    } catch {
      // Une valeur que l'IPC ne sait pas copier (fonction…) : envoyée vide, la mémoire la refuse avec son propre message.
      envoi = { ...demande, valeur: undefined };
    }
  }
  let r: ReponseMemoire;
  try {
    r = await ipcRenderer.invoke(CANAUX.memoire, envoi);
  } catch {
    // Jamais redemandé : l'erreur du process principal n'est pas celle d'une valeur.
    throw new Error("Mémoire de l'appli indisponible");
  }
  if (!r || r.ok !== true) throw new Error(r && typeof r.erreur === "string" ? r.erreur : "Mémoire de l'appli indisponible");
  return r.valeur;
}

const pont = {
  retenir: async (cle: unknown, valeur: unknown): Promise<void> => void (await memoire({ op: "retenir", cle, valeur })),
  lire: (cle: unknown): Promise<unknown> => memoire({ op: "lire", cle }),
  oublier: async (cle: unknown): Promise<void> => void (await memoire({ op: "oublier", cle })),
};

const i = demander();
if (i) {
  for (const css of i.css) {
    try {
      webFrame.insertCSS(css);
    } catch (e) {
      console.error("[webaios] retouche CSS non posée :", e);
    }
  }
  if (i.js.length > 0 && typeof i.garde === "string") {
    const garde = i.garde;
    webFrame.setIsolatedWorldInfo(MONDE_RETOUCHES, { name: "WebAiOs · retouches" });
    if (i.pont) contextBridge.exposeInIsolatedWorld(MONDE_RETOUCHES, "webaiosSite", pont);
    let lances = false;
    const lancer = () => {
      if (lances) return;
      lances = true;
      // La garde d'abord, seule : sans elle, aucun script de l'agent ne tourne. Puis chaque script à part, dans l'ordre :
      // l'erreur de l'un n'empêche pas les suivants.
      void webFrame
        .executeJavaScriptInIsolatedWorld(MONDE_RETOUCHES, [{ code: garde }, { code: `__webaiosPortee(${JSON.stringify({ reseau: [], hotes: i.hotes })})` }])
        .then(async () => {
          for (const { code, nom } of i.js) {
            await webFrame.executeJavaScriptInIsolatedWorld(MONDE_RETOUCHES, [{ code, url: nom }]).catch(() => {
              // L'erreur est écrite dans la console du cadre avec la source du script (erreurs des retouches).
            });
          }
        })
        .catch((e) => console.error("[webaios] garde des retouches non posée, scripts de l'agent non lancés :", e));
    };
    // Comme un script de contenu « document_end » : le DOM de la page est là. Écouté sur window, en capture, avant tout
    // script de la page : premier servi, une page qui arrête l'événement n'empêche pas les retouches. Un faux
    // DOMContentLoaded envoyé par la page n'avance rien (isTrusted).
    if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", (e) => e.isTrusted && lancer(), { capture: true });
    else lancer();
  }
  // `i.reprise` : la reprise des vidéos (tâche suivante), dans le monde de ce preload.
}
