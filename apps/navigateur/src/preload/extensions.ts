// Correctifs des extensions (spec §4.3), enregistré par `ExtensionsProfils.brancher` sur chaque session de profil, pour
// les service workers et les pages, après le preload de electron-chrome-extensions. Il ne fait rien hors d'un service
// worker ou d'une page `chrome-extension://` (il tourne aussi dans chaque page web du profil).
//
// Le processus principal dit, une fois par version et par profil, ce que Chrome aurait fait au chargement :
// - `installation` : `runtime.onInstalled` (jamais émis par Electron), appelé une fois avec ces détails ;
// - `rulesets` / `rulesetsInactifs` : l'état des rulesets statiques remis aux valeurs du manifeste (Electron n'active
//   pas ceux à `enabled: true`), avant les écouteurs.
import { contextBridge, ipcRenderer } from "electron";

/** Réponse de `webaios:extension-demarrage` (voir `ExtensionsProfils`). */
interface Demarrage {
  installation: { reason: "install" | "update"; previousVersion?: string } | null;
  rulesets: string[];
  rulesetsInactifs: string[];
  agent: boolean;
}

/** Monde principal de l'extension : sérialisé par `executeInMainWorld`, il ne voit rien de ce module. */
function correctifs(reponse: Promise<Demarrage>): void {
  type Ecouteur = (details: { reason: string; previousVersion?: string }) => void;
  type Dnr = { updateEnabledRulesets?(o: { enableRulesetIds: string[]; disableRulesetIds: string[] }): Promise<void> };
  const c = (globalThis as unknown as { chrome?: { runtime?: object; declarativeNetRequest?: Dnr } }).chrome;
  const runtime = c?.runtime;
  // Les écouteurs posés au démarrage du fond (comme dans Chrome, ceux posés plus tard ne reçoivent rien).
  const ecouteurs: Ecouteur[] = [];
  if (runtime) {
    const evenement = {
      addListener(f: Ecouteur) {
        if (typeof f === "function" && !ecouteurs.includes(f)) ecouteurs.push(f);
      },
      removeListener(f: Ecouteur) {
        const i = ecouteurs.indexOf(f);
        if (i >= 0) ecouteurs.splice(i, 1);
      },
      hasListener: (f: Ecouteur) => ecouteurs.includes(f),
      hasListeners: () => ecouteurs.length > 0,
    };
    try {
      Object.defineProperty(runtime, "onInstalled", { value: evenement, configurable: true, enumerable: true, writable: true });
    } catch (e) {
      console.error("[webaios] runtime.onInstalled non remplaçable :", e);
    }
  }
  reponse.then(
    async (r) => {
      // Les rulesets d'abord : un `onInstalled` qui en coupe un passe après, et le garde coupé.
      if (r.installation && r.rulesets.length + r.rulesetsInactifs.length > 0 && c?.declarativeNetRequest?.updateEnabledRulesets) {
        try {
          await c.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: r.rulesets, disableRulesetIds: r.rulesetsInactifs });
        } catch (e) {
          console.error("[webaios] rulesets du manifeste non activés :", e);
        }
      }
      if (!r.installation) return;
      for (const f of [...ecouteurs]) {
        try {
          f({ ...r.installation });
        } catch (e) {
          console.error(e);
        }
      }
    },
    (e) => console.error("[webaios] démarrage de l'extension :", e),
  );
}

/**
 * Le contexte est-il celui d'une extension : protocole `chrome-extension:` et `chrome.runtime.id` présent, lus dans le
 * monde principal (dans le preload d'un service worker, `location` n'existe pas : mesuré avec Electron 45). Un service
 * worker de site web n'a ni l'un ni l'autre.
 */
function contexteExtension(): boolean {
  try {
    return (
      contextBridge.executeInMainWorld({
        func: () => {
          const g = globalThis as { location?: { protocol?: string }; chrome?: { runtime?: { id?: unknown } } };
          return g.location?.protocol === "chrome-extension:" && !!g.chrome?.runtime?.id;
        },
      }) === true
    );
  } catch {
    return false;
  }
}

/**
 * Retire WebRTC du monde principal (pages des extensions de l'agent, et leurs cadres `about:`) : aucun envoi hors de
 * leur accord. Un cadre `about:blank` créé par la page a d'abord un document vide où ce preload n'a pas encore tourné :
 * chaque cadre de même origine en est privé dès qu'il apparaît (`load` synchrone d'un cadre vide, capté à la phase de
 * capture, y compris dans les racines fantômes) et dès que la page y accède (`contentWindow`, `contentDocument`).
 * Sérialisé par `executeInMainWorld` : tout est défini à l'intérieur.
 */
function sansWebRtc(): void {
  type Fenetre = Window & typeof globalThis & Record<string, unknown>;
  const NOMS = ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"];
  const equipees = new WeakSet<object>();
  const equiper = (w: Fenetre | null | undefined): void => {
    if (!w) return;
    try {
      // Par document : un cadre qui navigue (srcdoc) a un nouveau document derrière la même fenêtre.
      const doc = w.document as Document | undefined;
      if (doc) {
        if (equipees.has(doc)) return;
        equipees.add(doc);
      }
      for (const nom of NOMS) {
        try {
          delete w[nom];
        } catch {
          // Non configurable : laissé (la politique WebRTC de la vue coupe l'UDP direct).
        }
      }
      const capter = (racine: EventTarget) =>
        racine.addEventListener(
          "load",
          (e) => {
            const cible = e.target as { contentWindow?: Fenetre | null } | null;
            if (cible && "contentWindow" in cible) {
              try {
                equiper(cible.contentWindow);
              } catch {
                // Autre origine : rien à faire.
              }
            }
          },
          true,
        );
      if (!doc) return;
      capter(doc);
      const ombre = w.Element?.prototype.attachShadow;
      if (ombre) {
        Object.defineProperty(w.Element.prototype, "attachShadow", {
          value: function (this: Element, o: ShadowRootInit) {
            const r = ombre.call(this, o);
            capter(r);
            return r;
          },
          configurable: false,
          writable: false,
        });
      }
      for (const nomClasse of ["HTMLIFrameElement", "HTMLFrameElement", "HTMLObjectElement", "HTMLEmbedElement"]) {
        const proto = (w[nomClasse] as { prototype?: object } | undefined)?.prototype;
        if (!proto) continue;
        for (const prop of ["contentWindow", "contentDocument"]) {
          const d = Object.getOwnPropertyDescriptor(proto, prop);
          if (!d?.get) continue;
          const lire = d.get;
          Object.defineProperty(proto, prop, {
            get(this: object) {
              const r = lire.call(this) as (Fenetre & { defaultView?: Fenetre }) | null;
              try {
                equiper(prop === "contentWindow" ? r : (r?.defaultView ?? null));
              } catch {
                // Autre origine.
              }
              return r;
            },
            configurable: false,
            enumerable: d.enumerable ?? false,
          });
        }
      }
    } catch {
      // Fenêtre d'une autre origine : inaccessible, donc inoffensive ici.
    }
  };
  equiper(globalThis as Fenetre);
}

/** Le protocole du cadre, lu dans le monde principal. */
function protocoleDuCadre(): string | undefined {
  try {
    return contextBridge.executeInMainWorld({ func: () => (globalThis as { location?: { protocol?: string } }).location?.protocol }) as string | undefined;
  } catch {
    return undefined;
  }
}

// Un cadre `about:blank` ou `about:srcdoc` a l'origine de son parent, mais ni le garde ni les API d'extension (mesuré) :
// dans une page d'une extension de l'agent, il perd WebRTC comme elle (le processus principal juge par l'origine du
// cadre). Les vues qui montrent ces pages font tourner ce preload dans leurs sous-cadres (`nodeIntegrationInSubFrames`,
// sans Node : bac à sable).
if (process.type === "renderer" && protocoleDuCadre() === "about:") {
  try {
    if (ipcRenderer.sendSync("webaios:extension-agent") === true) contextBridge.executeInMainWorld({ func: sansWebRtc });
  } catch (e) {
    console.error("[webaios] WebRTC d'un cadre de l'agent :", e);
  }
}

// Service worker ou page : seulement s'ils sont ceux d'une extension (le preload tourne aussi dans les service workers
// et les pages des sites du profil).
const dansExtension = (process.type === "service-worker" || process.type === "renderer") && contexteExtension();
if (dansExtension) {
  try {
    const reponse: Promise<Demarrage> = ipcRenderer.invoke("webaios:extension-demarrage");
    // Le refus est traité dans le monde principal ; ici, il ne doit pas remonter comme rejet non traité.
    reponse.catch(() => {});
    contextBridge.executeInMainWorld({ func: correctifs, args: [reponse] });
  } catch (e) {
    console.error("[webaios] correctifs des extensions :", e);
  }
  // Le garde des extensions de l'agent (webaios-garde-fond.js) demande au processus principal, qui vérifie l'expéditeur
  // et l'accord ; une extension du Store reçoit toujours `true` (rien ne l'utilise).
  try {
    contextBridge.exposeInMainWorld("__webaios", {
      urlPermise: (url: unknown): Promise<boolean> => ipcRenderer.invoke("webaios:extension-url-permise", String(url)),
      hotePermis: (onglet: unknown): Promise<boolean> => ipcRenderer.invoke("webaios:extension-hote-permis", Number(onglet)),
    });
  } catch (e) {
    console.error("[webaios] garde des extensions :", e);
  }
  if (process.type === "renderer") {
    try {
      if (ipcRenderer.sendSync("webaios:extension-agent") === true) contextBridge.executeInMainWorld({ func: sansWebRtc });
    } catch (e) {
      console.error("[webaios] WebRTC des pages de l'agent :", e);
    }
  }
}
