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
 * Le protocole du contexte, lu dans le monde principal : dans le preload d'un service worker, `location` n'existe pas
 * (mesuré avec Electron 45).
 */
function protocole(): string | undefined {
  try {
    return contextBridge.executeInMainWorld({ func: () => (globalThis as { location?: { protocol?: string } }).location?.protocol }) as string | undefined;
  } catch {
    return undefined;
  }
}

// Service worker ou page : seulement s'ils sont ceux d'une extension (le preload tourne aussi dans les service workers
// et les pages des sites du profil).
const dansExtension = (process.type === "service-worker" || process.type === "renderer") && protocole() === "chrome-extension:";
if (dansExtension) {
  try {
    const reponse: Promise<Demarrage> = ipcRenderer.invoke("webaios:extension-demarrage");
    // Le refus est traité dans le monde principal ; ici, il ne doit pas remonter comme rejet non traité.
    reponse.catch(() => {});
    contextBridge.executeInMainWorld({ func: correctifs, args: [reponse] });
  } catch (e) {
    console.error("[webaios] correctifs des extensions :", e);
  }
}
