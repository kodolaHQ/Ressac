import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPublicKey, type KeyObject } from "node:crypto";
import { construireCrx } from "./crx";

/** Écrit une extension : chaque fichier par chemin relatif (un objet est écrit en JSON). */
export function ecrireExtension(dossier: string, f: Record<string, string | object>): void {
  for (const [nom, contenu] of Object.entries(f)) {
    const chemin = join(dossier, nom);
    mkdirSync(dirname(chemin), { recursive: true });
    writeFileSync(chemin, typeof contenu === "string" ? contenu : JSON.stringify(contenu, null, 2));
  }
}

/** Bloque `/pub.js` (script ou page) par une règle DNR dynamique posée au démarrage de son service worker. */
const bloqueur = {
  "manifest.json": {
    manifest_version: 3,
    name: "Bloqueur de test",
    version: "1.0.0",
    permissions: ["declarativeNetRequest"],
    background: { service_worker: "fond.js" },
  },
  "fond.js": `chrome.declarativeNetRequest.updateDynamicRules({
  removeRuleIds: [1],
  addRules: [{ id: 1, priority: 1, action: { type: "block" }, condition: { urlFilter: "/pub.js", resourceTypes: ["script", "main_frame"] } }],
}).then(() => console.log("bloqueur prêt"));
`,
};

/** Cache `#cache-moi` par une feuille de style de script de contenu. */
const cacheur = {
  "manifest.json": {
    manifest_version: 3,
    name: "Cacheur de test",
    version: "1.0.0",
    content_scripts: [{ matches: ["<all_urls>"], css: ["cache.css"] }],
  },
  "cache.css": "#cache-moi { display: none !important; }\n",
};

/**
 * Expose ce que voit l'extension par `console.log` d'une ligne `sonde:<JSON>` (onglets, fenêtres, stockage), au démarrage
 * et à chaque événement d'onglet. Selon l'URL d'une page chargée (une fois par onglet) :
 * - `ouvrir-onglet` : `tabs.create` de la même URL avec `ouverte-par-sonde` ;
 * - `ouvrir-actif` : `tabs.create({ active: true })` de la même URL avec `ouverte-active` ;
 * - `activer-plus-tard` : `tabs.update(cet onglet, { active: true })` 1,5 s plus tard.
 */
const sonde = {
  "manifest.json": {
    manifest_version: 3,
    name: "Sonde de test",
    version: "1.0.0",
    permissions: ["tabs", "storage"],
    background: { service_worker: "fond.js" },
  },
  "fond.js": `const ouverts = new Set();
async function rapporter(raison) {
  const onglets = await chrome.tabs.query({});
  const fenetres = await chrome.windows.getAll({ populate: true });
  await chrome.storage.local.set({ vu: Date.now() });
  const stockage = await chrome.storage.local.get(null);
  console.log("sonde:" + JSON.stringify({
    raison,
    onglets: onglets.map((o) => ({ id: o.id, url: o.url, fenetre: o.windowId })),
    fenetres: fenetres.map((f) => ({ id: f.id, onglets: (f.tabs || []).map((o) => o.url) })),
    stockage: Object.keys(stockage),
  }));
}
chrome.tabs.onCreated.addListener(() => rapporter("cree"));
chrome.tabs.onRemoved.addListener(() => rapporter("retire"));
chrome.tabs.onUpdated.addListener((id, changement, onglet) => {
  if (changement.status !== "complete" && !changement.url) return;
  rapporter("maj");
  const url = onglet.url || "";
  if (ouverts.has(id)) return;
  if (url.includes("ouvrir-onglet")) {
    ouverts.add(id);
    chrome.tabs.create({ url: url.replace("ouvrir-onglet", "ouverte-par-sonde") });
  } else if (url.includes("ouvrir-actif")) {
    ouverts.add(id);
    chrome.tabs.create({ url: url.replace("ouvrir-actif", "ouverte-active"), active: true });
  } else if (url.includes("activer-plus-tard")) {
    ouverts.add(id);
    setTimeout(() => chrome.tabs.update(id, { active: true }), 1500);
  }
});
rapporter("demarrage");
`,
};

/**
 * Les correctifs de la spec §4.3, vus de l'intérieur d'une extension du Store (« Bitwarden-like » : `nativeMessaging`).
 * Le fond (en mode strict, comme les extensions empaquetées) note ce qu'il observe et tient un journal (`journal` dans
 * `storage.local` : chaque démarrage, chaque `onInstalled`). Le script de contenu écrit `storage.sync` puis le relit
 * (`data-sync` de la page), et selon l'URL de la page demande au fond (réponse JSON dans `data-<demande>`) :
 * - `couper-regles` (`data-couper`) : coupe le ruleset statique « regles » (`updateEnabledRulesets`) ;
 * - `natif` (`data-natif`) : `connectNative("com.webaios.essai")`, et l'erreur reçue à la fermeture du port ;
 * - sinon (`data-rapport`) : `{ browserEstChrome, commandes, ajout, electron, journal, rulesets }` (`electron` : le type de
 *   `globalThis.electron` dans le fond, que la bibliothèque expose puis efface). Avec `?autre=<id>` dans l'URL :
 *   `usurpation` / `soi`, un `tabs.query` passé par cet objet au nom de `<id>`, puis au sien, a-t-il abouti ?
 * Son ruleset statique « regles », activé dans le manifeste, bloque le script `/pub.js`.
 */
const sondeCorrectifs = {
  "manifest.json": {
    manifest_version: 3,
    name: "Sonde des correctifs",
    version: "1.0.0",
    permissions: ["storage", "declarativeNetRequest", "nativeMessaging"],
    background: { service_worker: "fond.js" },
    declarative_net_request: { rule_resources: [{ id: "regles", enabled: true, path: "regles.json" }] },
    content_scripts: [{ matches: ["<all_urls>"], js: ["contenu.js"] }],
  },
  "regles.json": [{ id: 1, priority: 1, action: { type: "block" }, condition: { urlFilter: "/pub.js", resourceTypes: ["script"] } }],
  "fond.js": `"use strict";
let ajout;
try {
  chrome.webaiosAjout = 1;
  ajout = chrome.webaiosAjout === 1 ? "gardee" : "perdue";
} catch (e) {
  ajout = "erreur : " + e.message;
}
const observe = {
  browserEstChrome: typeof browser !== "undefined" && browser === chrome,
  commandes: typeof browser !== "undefined" && browser ? typeof browser.commands : "sans browser",
  ajout,
  electron: typeof globalThis.electron,
};
let file = Promise.resolve();
function noter(entree) {
  file = file.then(async () => {
    const { journal = [] } = await chrome.storage.local.get("journal");
    journal.push(entree);
    await chrome.storage.local.set({ journal });
  });
  return file;
}
chrome.runtime.onInstalled.addListener((d) => noter({ e: "installe", raison: d.reason, precedente: d.previousVersion ?? null }));
noter({ e: "demarrage", version: chrome.runtime.getManifest().version });
chrome.runtime.onMessage.addListener((m, _expediteur, repondre) => {
  if (m && m.demande === "rapport") {
    file.then(async () => {
      const { journal = [] } = await chrome.storage.local.get("journal");
      // Usurpation : l'objet IPC de la bibliothèque appelé au nom d'une autre extension chargée (m.autre), puis au sien.
      const e = globalThis.electron;
      const essai = async (id) => (e && m.autre ? Array.isArray(await e.invokeExtension(id, "tabs.query", {}, {})) : null);
      const usurpation = await essai(m.autre);
      const soi = await essai(chrome.runtime.id);
      repondre({ ...observe, journal, rulesets: await chrome.declarativeNetRequest.getEnabledRulesets(), usurpation, soi });
    });
    return true;
  }
  if (m === "couper") {
    chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: ["regles"] }).then(async () => repondre(await chrome.declarativeNetRequest.getEnabledRulesets()));
    return true;
  }
  if (m === "natif") {
    try {
      const port = chrome.runtime.connectNative("com.webaios.essai");
      port.onDisconnect.addListener(() => repondre({ erreur: chrome.runtime.lastError ? chrome.runtime.lastError.message : null }));
      port.postMessage({ bonjour: 1 });
    } catch (e) {
      repondre({ exception: e.message });
    }
    return true;
  }
});
`,
  "contenu.js": `(async () => {
  const racine = document.documentElement;
  try {
    await chrome.storage.sync.set({ essai: "valeur-sync" });
    const lu = await chrome.storage.sync.get("essai");
    racine.dataset.sync = String(lu.essai);
  } catch (e) {
    racine.dataset.sync = "erreur : " + e.message;
  }
  const demande = location.search.includes("couper-regles") ? "couper" : location.search.includes("natif") ? "natif" : "rapport";
  const message = demande === "rapport" ? { demande, autre: new URLSearchParams(location.search).get("autre") } : demande;
  try {
    racine.dataset[demande] = JSON.stringify((await chrome.runtime.sendMessage(message)) ?? null);
  } catch (e) {
    racine.dataset[demande] = JSON.stringify({ exception: e.message });
  }
})();
`,
};

/** Bloqueur purement déclaratif : un ruleset statique activé dans le manifeste, ni fond ni page. */
const bloqueurStatique = {
  "manifest.json": {
    manifest_version: 3,
    name: "Bloqueur statique de test",
    version: "1.0.0",
    permissions: ["declarativeNetRequest"],
    declarative_net_request: { rule_resources: [{ id: "regles", enabled: true, path: "regles.json" }] },
  },
  "regles.json": [{ id: 1, priority: 1, action: { type: "block" }, condition: { urlFilter: "/pub.js", resourceTypes: ["script"] } }],
};

export const EXTENSIONS_TEST = { bloqueur, cacheur, sonde, "sonde-correctifs": sondeCorrectifs, "bloqueur-statique": bloqueurStatique } as const;
export type ExtensionTest = keyof typeof EXTENSIONS_TEST;

/**
 * Installe une extension de test comme si elle venait du Store, dans le profil `dossierProfil` (userData) : le CRX est
 * construit (son id vient de sa clé), son contenu posé dans `extensions/store/<id>/<version>_0` avec la clé publique
 * dans le manifeste (comme le fait l'installeur), et son entrée écrite au registre, accordée et active dans `profils`.
 * Une nouvelle version (`version`) de la même extension reprend sa `cle` ; ses `vues` au registre sont gardées.
 */
export function installerStoreFactice(
  dossierProfil: string,
  extension: ExtensionTest,
  o: { profils: string[]; version?: string; cle?: KeyObject },
): { id: string; cle: KeyObject } {
  const source = mkdtempSync(join(tmpdir(), "webaios-ext-source-"));
  try {
    const fichiers = EXTENSIONS_TEST[extension];
    const lu = fichiers["manifest.json"] as { name: string; version: string; permissions?: string[] };
    const manifeste = { ...lu, version: o.version ?? lu.version };
    ecrireExtension(source, { ...fichiers, "manifest.json": manifeste });
    const { id, cle } = construireCrx(source, o.cle ? { cle: o.cle } : {});
    const cible = join(dossierProfil, "extensions", "store", id, `${manifeste.version}_0`);
    mkdirSync(dirname(cible), { recursive: true });
    cpSync(source, cible, { recursive: true });
    const publique = createPublicKey(cle).export({ type: "spki", format: "der" }).toString("base64");
    writeFileSync(join(cible, "manifest.json"), JSON.stringify({ ...manifeste, key: publique }, null, 2));

    const fichierEtat = join(dossierProfil, "extensions", "etat.json");
    let etat = { version: 1, toutesCoupees: false, extensions: {} as Record<string, unknown> };
    try {
      etat = JSON.parse(readFileSync(fichierEtat, "utf8"));
    } catch {
      // Registre absent : il est créé.
    }
    const ancienne = etat.extensions[`store:${id}`] as { vues?: Record<string, string> } | undefined;
    etat.extensions[`store:${id}`] = {
      source: "store",
      idChrome: id,
      nom: manifeste.name,
      version: manifeste.version,
      accord: { permissions: [...(manifeste.permissions ?? [])].sort(), hotes: [], reseau: [], tousLesSites: false, scriptsTousLesSites: false },
      profils: o.profils,
      epinglee: false,
      modifieeLe: null,
      desactivee: null,
      majEnAttente: null,
      vues: ancienne?.vues ?? {},
    };
    writeFileSync(fichierEtat, JSON.stringify(etat, null, 2));
    return { id, cle };
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
}

/**
 * Écrit une extension de l'agent dans `<racine>/extensions/<id>/` (le `~/WebAiOs` du test) : chaque fichier par chemin
 * relatif (un objet est écrit en JSON). Rien de ce qui est écrit là n'accorde un droit.
 */
export function ecrireExtensionAgent(racine: string, id: string, fichiers: Record<string, string | object>): void {
  ecrireExtension(join(racine, "extensions", id), fichiers);
}
