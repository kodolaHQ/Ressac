import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPublicKey } from "node:crypto";
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
 * et à chaque événement d'onglet. Une page dont l'URL contient `ouvrir-onglet` lui fait ouvrir (une fois) la même URL
 * avec `ouverte-par-sonde`, par `tabs.create`.
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
  if (url.includes("ouvrir-onglet") && !ouverts.has(id)) {
    ouverts.add(id);
    chrome.tabs.create({ url: url.replace("ouvrir-onglet", "ouverte-par-sonde") });
  }
});
rapporter("demarrage");
`,
};

export const EXTENSIONS_TEST = { bloqueur, cacheur, sonde } as const;
export type ExtensionTest = keyof typeof EXTENSIONS_TEST;

/**
 * Installe une extension de test comme si elle venait du Store, dans le profil `dossierProfil` (userData) : le CRX est
 * construit (son id vient de sa clé), son contenu posé dans `extensions/store/<id>/<version>_0` avec la clé publique
 * dans le manifeste (comme le fait l'installeur), et son entrée écrite au registre, accordée et active dans `profils`.
 */
export function installerStoreFactice(dossierProfil: string, extension: ExtensionTest, o: { profils: string[] }): { id: string } {
  const source = mkdtempSync(join(tmpdir(), "webaios-ext-source-"));
  try {
    const fichiers = EXTENSIONS_TEST[extension];
    ecrireExtension(source, fichiers);
    const { id, cle } = construireCrx(source);
    const manifeste = fichiers["manifest.json"] as { name: string; version: string; permissions?: string[] };
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
      vues: {},
    };
    writeFileSync(fichierEtat, JSON.stringify(etat, null, 2));
    return { id };
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
}
