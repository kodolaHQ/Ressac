import { createHash } from "node:crypto";

export type SourceExtension = "store" | "agent";

export interface Portee {
  permissions: string[];
  hotes: string[];
  reseau: string[];
  tousLesSites: boolean;
  scriptsTousLesSites: boolean;
  /** Vrai si le manifeste déclare des content_scripts (absent : faux). */
  scripts?: boolean;
}

export interface AnalyseManifeste {
  nom: string;
  version: string;
  portee: Portee;
  refus: string[];
  avertissements: string[];
}

export const RESEAU_MAX = 10;

const PERMISSIONS_REFUSEES_AGENT = [
  "downloads",
  "webRequest",
  "webRequestBlocking",
  "nativeMessaging",
  "debugger",
  "proxy",
];
const CLES_REFUSEES_AGENT = ["externally_connectable", "sandbox", "chrome_url_overrides", "devtools_page"];
/** Seconds niveaux courants sous un domaine de pays (`*.co.uk`, `*.com.au`, `*.gouv.fr`…) : leur joker vaut « tous les sites ». */
const SECONDS_NIVEAUX = ["co", "com", "net", "org", "gov", "edu", "ac", "gouv", "ne", "or"];
/**
 * Vrai si le motif couvre tous les sites : <all_urls>, ou un hôte (port retiré, `*:*` compris) `*`, `*.<un seul label>`
 * (jokers de TLD) ou `*.<second niveau courant>.<pays à 2 lettres>` (`*.co.uk`).
 */
export function motifTousLesSites(motif: string): boolean {
  if (motif === "<all_urls>") return true;
  const m = /^(\*|https?|wss?|ftp):\/\/([^/]*)(\/.*)?$/.exec(motif);
  if (!m) return false;
  const hote = m[2]!.replace(/:[^:]*$/, "").toLowerCase();
  if (hote === "*" || /^\*\.[^.*]+$/.test(hote)) return true;
  const sld = /^\*\.([^.*]+)\.([a-z]{2})$/.exec(hote);
  return !!sld && SECONDS_NIVEAUX.includes(sld[1]!);
}
const DOMAINE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function objet(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function chaines(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function uniquesTries(l: string[]): string[] {
  return [...new Set(l)].sort();
}

function porteeVide(): Portee {
  return { permissions: [], hotes: [], reseau: [], tousLesSites: false, scriptsTousLesSites: false };
}

function analyserRegles(
  manifeste: Record<string, unknown>,
  regles: Record<string, unknown>,
  refus: string[],
): void {
  const dnr = objet(manifeste.declarative_net_request);
  const ressources = Array.isArray(dnr?.rule_resources) ? dnr.rule_resources : [];
  for (const res of ressources) {
    const chemin = objet(res)?.path;
    if (typeof chemin !== "string") continue;
    if (chemin.startsWith("/") || chemin.split(/[\\/]/).includes("..")) {
      refus.push(`Fichier de règles DNR refusé : chemin non permis « ${chemin} »`);
      continue;
    }
    const liste = regles[chemin] ?? regles[chemin.replace(/^\.\//, "")];
    if (!Array.isArray(liste)) {
      refus.push(`Fichier de règles DNR illisible ou absent : ${chemin}`);
      continue;
    }
    liste.forEach((r, i) => {
      const regle = objet(r);
      if (!regle) return;
      const num = typeof regle.id === "number" ? regle.id : i + 1;
      const action = objet(regle.action);
      const type = action?.type;
      if (type === "redirect" || type === "modifyHeaders") {
        refus.push(`Règle DNR refusée (${type}) dans ${chemin}, règle ${num}`);
        return;
      }
      const redirection = objet(action?.redirect);
      if (redirection && ("regexSubstitution" in redirection || "transform" in redirection)) {
        const quoi = "regexSubstitution" in redirection ? "regexSubstitution" : "transform";
        refus.push(`Règle DNR refusée (${quoi}) dans ${chemin}, règle ${num}`);
      }
    });
  }
}

function analyserReseau(webaios: unknown, refus: string[]): string[] {
  const o = objet(webaios ?? {});
  if (!o) {
    refus.push("webaios.json : contenu invalide");
    return [];
  }
  if (o.reseau === undefined) return [];
  if (!Array.isArray(o.reseau)) {
    refus.push("webaios.json : « reseau » doit être une liste de domaines");
    return [];
  }
  if (o.reseau.length > RESEAU_MAX) {
    refus.push(`webaios.json : ${RESEAU_MAX} domaines au plus (${o.reseau.length} demandés)`);
  }
  const valides: string[] = [];
  for (const d of o.reseau) {
    if (typeof d === "string" && DOMAINE.test(d)) valides.push(d);
    else refus.push(`webaios.json : domaine invalide « ${String(d)} »`);
  }
  return uniquesTries(valides);
}

export function analyserManifeste(
  brut: unknown,
  o: { source: SourceExtension; webaios?: unknown; regles?: Record<string, unknown> },
): AnalyseManifeste {
  const m = objet(brut);
  if (!m) {
    return {
      nom: "",
      version: "",
      portee: porteeVide(),
      refus: ["Manifeste illisible"],
      avertissements: [],
    };
  }
  const agent = o.source === "agent";
  const refus: string[] = [];
  const avertissements: string[] = [];

  const nomBrut = typeof m.name === "string" ? m.name : "";
  const version = typeof m.version === "string" ? m.version : "";
  if (!nomBrut) refus.push("Manifeste sans « name »");
  if (!version) refus.push("Manifeste sans « version »");
  const msg = /^__MSG_(.+)__$/.exec(nomBrut);
  const nom = msg ? msg[1]! : nomBrut;

  if (m.manifest_version !== 3) refus.push("Seules les extensions Manifest V3 sont prises en charge");

  const permsBrutes = chaines(m.permissions);
  const hotesBruts = chaines(m.host_permissions);
  const scripts = Array.isArray(m.content_scripts) ? m.content_scripts : [];
  const matchesScripts: string[] = [];
  let scriptsTous = false;
  for (const cs of scripts) {
    const c = objet(cs);
    if (!c) continue;
    const matches = chaines(c.matches);
    matchesScripts.push(...matches);
    if (matches.some((x) => motifTousLesSites(x))) scriptsTous = true;
    if (agent && c.world === "MAIN") {
      refus.push('Script de contenu refusé : world "MAIN" n\'est pas permis');
    }
  }

  const hotesTous = [...hotesBruts, ...matchesScripts, ...permsBrutes.filter((p) => p.includes("://") || p === "<all_urls>")];
  const permissions = uniquesTries(permsBrutes.filter((p) => !p.includes("://") && p !== "<all_urls>"));
  const hotes = uniquesTries(hotesTous);

  if (agent) {
    for (const p of permissions) {
      if (PERMISSIONS_REFUSEES_AGENT.includes(p)) refus.push(`Droit refusé : ${p}`);
    }
    for (const cle of CLES_REFUSEES_AGENT) {
      if (cle in m) refus.push(`Clé refusée : ${cle}`);
    }
    const fond = objet(m.background);
    if (fond) {
      if ("scripts" in fond || "page" in fond) {
        refus.push("background refusé : seul « service_worker » est permis");
      } else if ("service_worker" in fond && typeof fond.service_worker !== "string") {
        refus.push("background.service_worker doit être un chemin de fichier");
      }
    }
    analyserRegles(m, o.regles ?? {}, refus);
    if (Array.isArray(m.optional_permissions) && m.optional_permissions.length > 0) {
      refus.push("optional_permissions refusé : déclare ces droits dans permissions");
    }
    if (Array.isArray(m.optional_host_permissions) && m.optional_host_permissions.length > 0) {
      refus.push("optional_host_permissions refusé : déclare ces hôtes dans host_permissions");
    }
  }
  const reseau = agent ? analyserReseau(o.webaios, refus) : [];

  const portee: Portee = {
    permissions,
    hotes,
    reseau,
    tousLesSites: hotes.some((h) => motifTousLesSites(h)),
    scriptsTousLesSites: scriptsTous,
    scripts: scripts.length > 0,
  };
  return { nom, version, portee, refus, avertissements };
}

export function porteeElargie(accordee: Portee, nouvelle: Portee): boolean {
  const manque = (a: string[], n: string[]) => n.some((x) => !a.includes(x));
  return (
    manque(accordee.permissions, nouvelle.permissions) ||
    manque(accordee.hotes, nouvelle.hotes) ||
    manque(accordee.reseau, nouvelle.reseau) ||
    (!accordee.tousLesSites && nouvelle.tousLesSites) ||
    (!accordee.scriptsTousLesSites && nouvelle.scriptsTousLesSites) ||
    (!accordee.scripts && !!nouvelle.scripts)
  );
}

/**
 * Empreinte d'une portée (sha-256 hexadécimal d'un JSON canonique : clés triées, listes triées, `scripts` absent = faux).
 * La carte d'accord la porte : un appelant n'enregistre l'accord que si la portée qu'il écrit a la même empreinte que
 * celle montrée à l'utilisateur.
 */
export function empreintePortee(p: Portee): string {
  const triee = (l: string[]) => [...l].sort();
  const canonique = JSON.stringify({
    hotes: triee(p.hotes),
    permissions: triee(p.permissions),
    reseau: triee(p.reseau),
    scripts: !!p.scripts,
    scriptsTousLesSites: p.scriptsTousLesSites,
    tousLesSites: p.tousLesSites,
  });
  return createHash("sha256").update(canonique).digest("hex");
}

/** Accord renforcé (agent) : scripts partout, ou injection possible partout via `scripting`. */
export function accordRenforce(p: Portee, source: SourceExtension): boolean {
  return (
    source === "agent" &&
    (p.scriptsTousLesSites || (p.tousLesSites && p.permissions.includes("scripting")))
  );
}

export function libellesPortee(p: Portee, source: SourceExtension): string[] {
  const has = (...noms: string[]) => noms.some((n) => p.permissions.includes(n));
  const sortie: string[] = [];
  const ajoute = (cond: boolean, texte: string) => {
    if (cond && !sortie.includes(texte)) sortie.push(texte);
  };
  ajoute(has("scripting") || p.scriptsTousLesSites || !!p.scripts, "Modifier l'apparence et le contenu des pages");
  ajoute(p.permissions.some((x) => x.startsWith("declarativeNetRequest")), "Bloquer ou modifier des requêtes");
  ajoute(has("storage", "unlimitedStorage"), "Garder ses réglages");
  ajoute(has("tabs"), "Voir la liste des onglets et leurs adresses");
  ajoute(has("notifications"), "Afficher des notifications");
  ajoute(has("contextMenus"), "Ajouter des entrées au menu du clic droit");
  ajoute(has("cookies"), "Lire et modifier les cookies");
  ajoute(has("webNavigation"), "Suivre la navigation des onglets");
  ajoute(has("alarms", "offscreen"), "Tourner en arrière-plan");
  ajoute(has("clipboardRead"), "Lire le presse-papiers");
  ajoute(has("clipboardWrite"), "Écrire dans le presse-papiers");
  ajoute(
    has("activeTab"),
    "Agir sur l'onglet affiché quand tu cliques sur son bouton (non pris en charge par WebAiOs)",
  );
  if (source === "store") {
    ajoute(has("webRequest"), "Observer les requêtes des pages");
    ajoute(has("downloads"), "Gérer les téléchargements");
    ajoute(has("nativeMessaging"), "Parler à un programme du Mac (non pris en charge)");
  }
  const connus = new Set([
    "scripting", "storage", "unlimitedStorage", "tabs", "notifications", "contextMenus", "cookies",
    "webNavigation", "alarms", "offscreen", "clipboardRead", "clipboardWrite", "activeTab",
  ]);
  if (source === "store") for (const n of ["webRequest", "downloads", "nativeMessaging"]) connus.add(n);
  for (const perm of p.permissions) {
    if (connus.has(perm) || perm.startsWith("declarativeNetRequest")) continue;
    ajoute(true, `Droit « ${perm} »`);
  }
  return sortie;
}
