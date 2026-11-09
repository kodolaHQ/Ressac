import { createHash } from "node:crypto";

export type SourceExtension = "store" | "agent";

export interface Portee {
  permissions: string[];
  hotes: string[];
  reseau: string[];
  tousLesSites: boolean;
  scriptsTousLesSites: boolean;
  /** True if the manifest declares content_scripts (absent: false). */
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
/** Common second levels under a country domain (`*.co.uk`, `*.com.au`, `*.gouv.fr`…): their wildcard means « all sites ». */
const SECONDS_NIVEAUX = ["co", "com", "net", "org", "gov", "edu", "ac", "gouv", "ne", "or"];
/**
 * True if the pattern covers all sites: <all_urls>, or a host (port removed, `*:*` included) `*`, `*.<a single label>`
 * (TLD wildcards) or `*.<common second level>.<2-letter country>` (`*.co.uk`).
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

/** The locales consulted for a French interface, before the manifest's `default_locale`. */
const LOCALES_PREFEREES = ["fr", "fr_FR"];
/** A locale of `_locales/` (`en`, `pt_BR`, `es_419`): never a path. */
const LOCALE = /^[A-Za-z]{2,3}(_[A-Za-z0-9]{2,8})?$/;

/**
 * The message catalogs to read to resolve `__MSG_…__` (paths relative to the extension folder), in
 * the order they are consulted: `fr`, `fr_FR`, then `default_locale` (if it is a locale, and not already listed).
 */
export function fichiersMessages(brut: unknown): string[] {
  const m = objet(brut);
  const defaut = m && typeof m.default_locale === "string" && LOCALE.test(m.default_locale) ? [m.default_locale] : [];
  return [...new Set([...LOCALES_PREFEREES, ...defaut])].map((l) => `_locales/${l}/messages.json`);
}

/**
 * `__MSG_key__` replaced by the message of the first catalog that has the key (case-insensitive, like Chrome);
 * a key not found stays as is. `catalogues`: the content of the `messages.json` files in the order of `fichiersMessages`.
 */
export function resoudreMessages(texte: string, catalogues: readonly unknown[]): string {
  return texte.replace(/__MSG_([A-Za-z0-9_@]+)__/g, (tout, cle: string) => {
    const voulue = cle.toLowerCase();
    for (const c of catalogues) {
      const o = objet(c);
      if (!o) continue;
      for (const [k, v] of Object.entries(o)) {
        const message = k.toLowerCase() === voulue ? objet(v)?.message : undefined;
        if (typeof message === "string") return message;
      }
    }
    return tout;
  });
}

export function analyserManifeste(
  brut: unknown,
  o: {
    source: SourceExtension;
    webaios?: unknown;
    regles?: Record<string, unknown>;
    /** The content of the catalogs of `fichiersMessages` (absent or unreadable: `undefined`), for a `__MSG_…__` name. */
    messages?: readonly unknown[];
  },
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
  // No message for the key: the message id rather than `__MSG_…__`.
  const resolu = resoudreMessages(nomBrut, o.messages ?? []);
  const msg = /^__MSG_(.+)__$/.exec(resolu);
  const nom = msg ? msg[1]! : resolu;

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
 * Hash of a scope (hexadecimal sha-256 of a canonical JSON: sorted keys, sorted lists, `scripts` absent = false).
 * The grant card carries it: a caller records the grant only if the scope it writes has the same hash as
 * the one shown to the user.
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

/** Reinforced grant (agent): scripts everywhere, or injection possible everywhere through `scripting`. */
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
  ajoute(has("declarativeNetRequestFeedback"), "Voir quelles requêtes de tous les onglets ses règles ont touchées");
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
