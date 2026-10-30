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
 * capture, y compris dans les racines fantômes), dès que la page y accède (`contentWindow`, `contentDocument`), et à
 * chaque balayage des fenêtres filles `w[i]` (accès indexé, que la page ne peut pas masquer) : au chargement d'un cadre,
 * à chaque accès et à chaque mutation du document. Tout ce dont il se sert est saisi avant que la page ne tourne
 * (getters d'origine, `Reflect.apply`…) : masquer `contentWindow` sur l'élément ou remplacer les objets de base n'y
 * change rien. Sérialisé par `executeInMainWorld` : tout est défini à l'intérieur.
 */
function sansWebRtc(): void {
  type Fenetre = Window & typeof globalThis & Record<string | number, unknown>;
  const appliquer = Reflect.apply;
  const definir = Object.defineProperty;
  const descripteur = Object.getOwnPropertyDescriptor;
  const ensemble = new WeakSet<object>();
  const WS = WeakSet.prototype;
  const a = (o: object) => appliquer(WS.has, ensemble, [o]) as boolean;
  const marquer = (o: object) => appliquer(WS.add, ensemble, [o]);
  const NOMS = ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"];
  const CLASSES = ["HTMLIFrameElement", "HTMLFrameElement", "HTMLObjectElement", "HTMLEmbedElement"];
  const racine = globalThis as Fenetre;
  // Getters d'origine de `contentWindow`, de toutes les fenêtres équipées (chaque cadre a ses propres classes).
  const getters: Array<(this: unknown) => unknown> = [];

  /** La fenêtre d'un élément cadre, par les getters d'origine (pas par la propriété, que la page peut masquer). */
  const fenetreDe = (el: unknown): Fenetre | null => {
    for (let i = 0; i < getters.length; i++) {
      try {
        return appliquer(getters[i]!, el, []) as Fenetre | null;
      } catch {
        // Pas de cette classe ou de cette fenêtre : getter suivant.
      }
    }
    return null;
  };

  /** Les fenêtres filles `w[i]`, et les leurs. */
  const balayer = (w: Fenetre): void => {
    for (let i = 0; i < 1000; i++) {
      let f: Fenetre | undefined;
      try {
        f = w[i] as Fenetre | undefined;
      } catch {
        return;
      }
      if (!f) return;
      equiper(f);
    }
  };
  const toutBalayer = () => {
    try {
      balayer(racine);
    } catch {
      // Rien de plus à faire.
    }
  };

  function equiper(w: Fenetre | null | undefined): void {
    if (!w) return;
    let doc: Document | undefined;
    try {
      doc = w.document as Document | undefined;
    } catch {
      return; // Autre origine : inaccessible, donc inoffensive ici.
    }
    // Par document : un cadre qui navigue (srcdoc) a un nouveau document derrière la même fenêtre.
    if (!doc || !a(doc)) {
      if (doc) marquer(doc);
      installer(w, doc);
    }
    balayer(w);
  }

  function installer(w: Fenetre, doc: Document | undefined): void {
    try {
      for (let i = 0; i < NOMS.length; i++) {
        try {
          delete w[NOMS[i]!];
        } catch {
          // Non configurable : laissé (la politique WebRTC de la vue coupe l'UDP direct).
        }
      }
      if (!doc) return;
      const ET = w.EventTarget?.prototype;
      const ecouter = ET?.addEventListener;
      // Saisi à l'installation : la page ne peut plus remplacer `Event.prototype` pour cette lecture.
      const lireCible = descripteur(w.Event.prototype, "target")?.get;
      const surCharge = (e: Event) => {
        let cible: unknown = null;
        try {
          cible = lireCible ? appliquer(lireCible, e, []) : null;
        } catch {
          cible = null;
        }
        if (cible) equiper(fenetreDe(cible));
        toutBalayer();
      };
      const capter = (r: EventTarget) => {
        if (ecouter) appliquer(ecouter, r, ["load", surCharge, true]);
      };
      // Les getters d'abord : `surCharge` s'en sert.
      for (let i = 0; i < CLASSES.length; i++) {
        const proto = (w[CLASSES[i]!] as { prototype?: object } | undefined)?.prototype;
        if (!proto) continue;
        const props = ["contentWindow", "contentDocument"];
        for (let j = 0; j < props.length; j++) {
          const prop = props[j]!;
          const d = descripteur(proto, prop);
          if (!d?.get) continue;
          const lire = d.get;
          if (prop === "contentWindow") getters[getters.length] = lire;
          const fenetre = prop === "contentWindow";
          definir(proto, prop, {
            get(this: object) {
              const r = appliquer(lire, this, []) as (Fenetre & { defaultView?: Fenetre }) | null;
              try {
                equiper(fenetre ? r : (r?.defaultView ?? null));
              } catch {
                // Autre origine.
              }
              toutBalayer();
              return r;
            },
            configurable: false,
            enumerable: d.enumerable ?? false,
            __proto__: null,
          } as PropertyDescriptor);
        }
      }
      capter(doc);
      const ombre = w.Element?.prototype.attachShadow;
      if (ombre) {
        definir(w.Element.prototype, "attachShadow", {
          value: function (this: Element, o: ShadowRootInit) {
            const r = appliquer(ombre, this, [o]) as ShadowRoot;
            capter(r);
            return r;
          },
          configurable: false,
          writable: false,
          __proto__: null,
        } as PropertyDescriptor);
      }
      // Ce qui peut créer un cadre hors de portée du `load` capté (racine fantôme déclarative, que attachShadow ne voit
      // pas ; flux du parseur) : balayage dans la même tâche, juste après l'original. `innerHTML`/`outerHTML` ne créent
      // pas de racine déclarative : leurs cadres passent par le `load` capté (mesuré, e2e des cadres).
      const balayerApres = (proto: object | undefined, nom: string) => {
        const d = proto && descripteur(proto, nom);
        const original = d ? descripteur(d, "value")?.value : undefined;
        if (typeof original !== "function") return;
        definir(proto, nom, {
          value: function (this: unknown, ...args: unknown[]) {
            try {
              return appliquer(original as (...a: unknown[]) => unknown, this, args);
            } finally {
              toutBalayer();
            }
          },
          configurable: false,
          writable: false,
          enumerable: d!.enumerable ?? false,
          __proto__: null,
        } as PropertyDescriptor);
      };
      // `window.open("", nom)` rend un cadre existant par son nom, même dans une racine fantôme déclarative fermée
      // (mesuré) : la fenêtre rendue est équipée avant d'être rendue.
      try {
        const d = descripteur(w, "open") ?? descripteur(w.Window?.prototype ?? {}, "open");
        const ouvrir = d ? descripteur(d, "value")?.value : undefined;
        if (typeof ouvrir === "function") {
          definir(w, "open", {
            value: function (this: unknown, ...args: unknown[]) {
              const r = appliquer(ouvrir as (...a: unknown[]) => unknown, this, args) as Fenetre | null;
              try {
                equiper(r);
              } catch {
                // Autre origine.
              }
              toutBalayer();
              return r;
            },
            configurable: false,
            writable: false,
            enumerable: d!.enumerable ?? true,
            __proto__: null,
          } as PropertyDescriptor);
        }
      } catch {
        // `open` non remplaçable : laissé.
      }
      balayerApres(w.Element?.prototype, "setHTMLUnsafe");
      balayerApres(w.Element?.prototype, "insertAdjacentHTML");
      balayerApres(w.ShadowRoot?.prototype, "setHTMLUnsafe");
      balayerApres(w.Document?.prototype, "write");
      balayerApres(w.Document?.prototype, "writeln");
      // Filet : chaque mutation du document (microtâche, avant chaque script du parseur) balaie les fenêtres filles.
      const MO = w.MutationObserver;
      if (MO) {
        const mo = new MO(toutBalayer);
        appliquer(MO.prototype.observe, mo, [doc, { childList: true, subtree: true, __proto__: null }]);
      }
    } catch {
      // Fenêtre d'une autre origine : inaccessible, donc inoffensive ici.
    }
  }

  equiper(racine);
}

/**
 * Un cadre `about:` dont l'origine (héritée du parent) est celle d'une extension. Lu ici, dans le monde du preload
 * (isolé), dès son démarrage : la page ne peut rien y poser, alors que `origin` est remplaçable dans le monde principal
 * (un parent de même origine pourrait le changer sur la fenêtre du cadre). Les cadres `about:blank` des sites (des
 * dizaines par page chez les régies) ne posent donc pas de question synchrone ; un site ne peut pas avoir une origine
 * `chrome-extension://`.
 */
function cadreAboutDExtension(): boolean {
  try {
    const g = globalThis as { location?: { protocol?: string }; origin?: unknown };
    const protocole = g.location?.protocol;
    const origine = g.origin;
    return protocole === "about:" && typeof origine === "string" && origine.startsWith("chrome-extension://");
  } catch {
    return false;
  }
}

// Un cadre `about:blank` ou `about:srcdoc` a l'origine de son parent, mais ni le garde ni les API d'extension (mesuré) :
// dans une page d'une extension de l'agent, il perd WebRTC comme elle (le processus principal juge par l'origine du
// cadre). Les vues qui montrent ces pages font tourner ce preload dans leurs sous-cadres (`nodeIntegrationInSubFrames`,
// sans Node : bac à sable).
if (process.type === "renderer" && cadreAboutDExtension()) {
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
