import { createHash } from "node:crypto";

export type SourceExtension = "store" | "agent";

export interface Scope {
  permissions: string[];
  hotes: string[];
  reseau: string[];
  tousLesSites: boolean;
  scriptsTousLesSites: boolean;
  /** True if the manifest declares content_scripts (absent: false). */
  scripts?: boolean;
}

export interface ManifestAnalysis {
  nom: string;
  version: string;
  portee: Scope;
  refus: string[];
  avertissements: string[];
}

export const NETWORK_MAX = 10;

const AGENT_DENIED_PERMISSIONS = [
  "downloads",
  "webRequest",
  "webRequestBlocking",
  "nativeMessaging",
  "debugger",
  "proxy",
];
const AGENT_KEYS_DENIED = ["externally_connectable", "sandbox", "chrome_url_overrides", "devtools_page"];
/** Common second levels under a country domain (`*.co.uk`, `*.com.au`, `*.gouv.fr`…): their wildcard means « all sites ». */
const SECONDS_LEVELS = ["co", "com", "net", "org", "gov", "edu", "ac", "gouv", "ne", "or"];
/**
 * True if the pattern covers all sites: <all_urls>, or a host (port removed, `*:*` included) `*`, `*.<a single label>`
 * (TLD wildcards) or `*.<common second level>.<2-letter country>` (`*.co.uk`).
 */
export function allSitesPattern(pattern: string): boolean {
  if (pattern === "<all_urls>") return true;
  const m = /^(\*|https?|wss?|ftp):\/\/([^/]*)(\/.*)?$/.exec(pattern);
  if (!m) return false;
  const host = m[2]!.replace(/:[^:]*$/, "").toLowerCase();
  if (host === "*" || /^\*\.[^.*]+$/.test(host)) return true;
  const sld = /^\*\.([^.*]+)\.([a-z]{2})$/.exec(host);
  return !!sld && SECONDS_LEVELS.includes(sld[1]!);
}
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function object(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function chains(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function sortedUnique(l: string[]): string[] {
  return [...new Set(l)].sort();
}

function emptyScope(): Scope {
  return { permissions: [], hotes: [], reseau: [], tousLesSites: false, scriptsTousLesSites: false };
}

function parseRules(
  manifest: Record<string, unknown>,
  rules: Record<string, unknown>,
  denial: string[],
): void {
  const dnr = object(manifest.declarative_net_request);
  const resources = Array.isArray(dnr?.rule_resources) ? dnr.rule_resources : [];
  for (const res of resources) {
    const path = object(res)?.path;
    if (typeof path !== "string") continue;
    if (path.startsWith("/") || path.split(/[\\/]/).includes("..")) {
      denial.push(`Fichier de règles DNR refusé : chemin non permis « ${path} »`);
      continue;
    }
    const list = rules[path] ?? rules[path.replace(/^\.\//, "")];
    if (!Array.isArray(list)) {
      denial.push(`Fichier de règles DNR illisible ou absent : ${path}`);
      continue;
    }
    list.forEach((r, i) => {
      const rule = object(r);
      if (!rule) return;
      const num = typeof rule.id === "number" ? rule.id : i + 1;
      const action = object(rule.action);
      const type = action?.type;
      if (type === "redirect" || type === "modifyHeaders") {
        denial.push(`Règle DNR refusée (${type}) dans ${path}, règle ${num}`);
        return;
      }
      const redirection = object(action?.redirect);
      if (redirection && ("regexSubstitution" in redirection || "transform" in redirection)) {
        const what = "regexSubstitution" in redirection ? "regexSubstitution" : "transform";
        denial.push(`Règle DNR refusée (${what}) dans ${path}, règle ${num}`);
      }
    });
  }
}

function parseNetwork(webaios: unknown, denial: string[]): string[] {
  const o = object(webaios ?? {});
  if (!o) {
    denial.push("webaios.json : contenu invalide");
    return [];
  }
  if (o.reseau === undefined) return [];
  if (!Array.isArray(o.reseau)) {
    denial.push("webaios.json : « reseau » doit être une liste de domaines");
    return [];
  }
  if (o.reseau.length > NETWORK_MAX) {
    denial.push(`webaios.json : ${NETWORK_MAX} domaines au plus (${o.reseau.length} demandés)`);
  }
  const valid: string[] = [];
  for (const d of o.reseau) {
    if (typeof d === "string" && DOMAIN.test(d)) valid.push(d);
    else denial.push(`webaios.json : domaine invalide « ${String(d)} »`);
  }
  return sortedUnique(valid);
}

/** The locales consulted for a French interface, before the manifest's `default_locale`. */
const PREFERRED_LOCALES = ["fr", "fr_FR"];
/** A locale of `_locales/` (`en`, `pt_BR`, `es_419`): never a path. */
const LOCALE = /^[A-Za-z]{2,3}(_[A-Za-z0-9]{2,8})?$/;

/**
 * The message catalogs to read to resolve `__MSG_…__` (paths relative to the extension folder), in
 * the order they are consulted: `fr`, `fr_FR`, then `default_locale` (if it is a locale, and not already listed).
 */
export function messageFiles(raw: unknown): string[] {
  const m = object(raw);
  const defaultValue = m && typeof m.default_locale === "string" && LOCALE.test(m.default_locale) ? [m.default_locale] : [];
  return [...new Set([...PREFERRED_LOCALES, ...defaultValue])].map((l) => `_locales/${l}/messages.json`);
}

/**
 * `__MSG_key__` replaced by the message of the first catalog that has the key (case-insensitive, like Chrome);
 * a key not found stays as is. `catalogues`: the content of the `messages.json` files in the order of `fichiersMessages`.
 */
export function resolveMessages(text: string, catalogues: readonly unknown[]): string {
  return text.replace(/__MSG_([A-Za-z0-9_@]+)__/g, (all, key: string) => {
    const wanted = key.toLowerCase();
    for (const c of catalogues) {
      const o = object(c);
      if (!o) continue;
      for (const [k, v] of Object.entries(o)) {
        const message = k.toLowerCase() === wanted ? object(v)?.message : undefined;
        if (typeof message === "string") return message;
      }
    }
    return all;
  });
}

export function parseManifest(
  raw: unknown,
  o: {
    source: SourceExtension;
    webaios?: unknown;
    regles?: Record<string, unknown>;
    /** The content of the catalogs of `fichiersMessages` (absent or unreadable: `undefined`), for a `__MSG_…__` name. */
    messages?: readonly unknown[];
  },
): ManifestAnalysis {
  const m = object(raw);
  if (!m) {
    return {
      nom: "",
      version: "",
      portee: emptyScope(),
      refus: ["Manifeste illisible"],
      avertissements: [],
    };
  }
  const agent = o.source === "agent";
  const denial: string[] = [];
  const warnings: string[] = [];

  const rawName = typeof m.name === "string" ? m.name : "";
  const version = typeof m.version === "string" ? m.version : "";
  if (!rawName) denial.push("Manifeste sans « name »");
  if (!version) denial.push("Manifeste sans « version »");
  // No message for the key: the message id rather than `__MSG_…__`.
  const resolved = resolveMessages(rawName, o.messages ?? []);
  const msg = /^__MSG_(.+)__$/.exec(resolved);
  const name = msg ? msg[1]! : resolved;

  if (m.manifest_version !== 3) denial.push("Seules les extensions Manifest V3 sont prises en charge");

  const rawPerms = chains(m.permissions);
  const rawHosts = chains(m.host_permissions);
  const scripts = Array.isArray(m.content_scripts) ? m.content_scripts : [];
  const matchesScripts: string[] = [];
  let allScripts = false;
  for (const cs of scripts) {
    const c = object(cs);
    if (!c) continue;
    const matches = chains(c.matches);
    matchesScripts.push(...matches);
    if (matches.some((x) => allSitesPattern(x))) allScripts = true;
    if (agent && c.world === "MAIN") {
      denial.push('Script de contenu refusé : world "MAIN" n\'est pas permis');
    }
  }

  const allHosts = [...rawHosts, ...matchesScripts, ...rawPerms.filter((p) => p.includes("://") || p === "<all_urls>")];
  const permissions = sortedUnique(rawPerms.filter((p) => !p.includes("://") && p !== "<all_urls>"));
  const hosts = sortedUnique(allHosts);

  if (agent) {
    for (const p of permissions) {
      if (AGENT_DENIED_PERMISSIONS.includes(p)) denial.push(`Droit refusé : ${p}`);
    }
    for (const key of AGENT_KEYS_DENIED) {
      if (key in m) denial.push(`Clé refusée : ${key}`);
    }
    const background = object(m.background);
    if (background) {
      if ("scripts" in background || "page" in background) {
        denial.push("background refusé : seul « service_worker » est permis");
      } else if ("service_worker" in background && typeof background.service_worker !== "string") {
        denial.push("background.service_worker doit être un chemin de fichier");
      }
    }
    parseRules(m, o.regles ?? {}, denial);
    if (Array.isArray(m.optional_permissions) && m.optional_permissions.length > 0) {
      denial.push("optional_permissions refusé : déclare ces droits dans permissions");
    }
    if (Array.isArray(m.optional_host_permissions) && m.optional_host_permissions.length > 0) {
      denial.push("optional_host_permissions refusé : déclare ces hôtes dans host_permissions");
    }
  }
  const network = agent ? parseNetwork(o.webaios, denial) : [];

  const scope: Scope = {
    permissions,
    hotes: hosts,
    reseau: network,
    tousLesSites: hosts.some((h) => allSitesPattern(h)),
    scriptsTousLesSites: allScripts,
    scripts: scripts.length > 0,
  };
  return { nom: name, version, portee: scope, refus: denial, avertissements: warnings };
}

export function widenedScope(granted: Scope, fresh: Scope): boolean {
  const missing = (a: string[], n: string[]) => n.some((x) => !a.includes(x));
  return (
    missing(granted.permissions, fresh.permissions) ||
    missing(granted.hotes, fresh.hotes) ||
    missing(granted.reseau, fresh.reseau) ||
    (!granted.tousLesSites && fresh.tousLesSites) ||
    (!granted.scriptsTousLesSites && fresh.scriptsTousLesSites) ||
    (!granted.scripts && !!fresh.scripts)
  );
}

/**
 * Hash of a scope (hexadecimal sha-256 of a canonical JSON: sorted keys, sorted lists, `scripts` absent = false).
 * The grant card carries it: a caller records the grant only if the scope it writes has the same hash as
 * the one shown to the user.
 */
export function scopeHash(p: Scope): string {
  const sorted = (l: string[]) => [...l].sort();
  const canonical = JSON.stringify({
    hotes: sorted(p.hotes),
    permissions: sorted(p.permissions),
    reseau: sorted(p.reseau),
    scripts: !!p.scripts,
    scriptsTousLesSites: p.scriptsTousLesSites,
    tousLesSites: p.tousLesSites,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Reinforced grant (agent): scripts everywhere, or injection possible everywhere through `scripting`. */
export function grantStrengthened(p: Scope, source: SourceExtension): boolean {
  return (
    source === "agent" &&
    (p.scriptsTousLesSites || (p.tousLesSites && p.permissions.includes("scripting")))
  );
}

export function scopeLabels(p: Scope, source: SourceExtension): string[] {
  const has = (...names: string[]) => names.some((n) => p.permissions.includes(n));
  const output: string[] = [];
  const added = (cond: boolean, text: string) => {
    if (cond && !output.includes(text)) output.push(text);
  };
  added(has("scripting") || p.scriptsTousLesSites || !!p.scripts, "Modifier l'apparence et le contenu des pages");
  added(p.permissions.some((x) => x.startsWith("declarativeNetRequest")), "Bloquer ou modifier des requêtes");
  added(has("declarativeNetRequestFeedback"), "Voir quelles requêtes de tous les onglets ses règles ont touchées");
  added(has("storage", "unlimitedStorage"), "Garder ses réglages");
  added(has("tabs"), "Voir la liste des onglets et leurs adresses");
  added(has("notifications"), "Afficher des notifications");
  added(has("contextMenus"), "Ajouter des entrées au menu du clic droit");
  added(has("cookies"), "Lire et modifier les cookies");
  added(has("webNavigation"), "Suivre la navigation des onglets");
  added(has("alarms", "offscreen"), "Tourner en arrière-plan");
  added(has("clipboardRead"), "Lire le presse-papiers");
  added(has("clipboardWrite"), "Écrire dans le presse-papiers");
  added(
    has("activeTab"),
    "Agir sur l'onglet affiché quand tu cliques sur son bouton (non pris en charge par WebAiOs)",
  );
  if (source === "store") {
    added(has("webRequest"), "Observer les requêtes des pages");
    added(has("downloads"), "Gérer les téléchargements");
    added(has("nativeMessaging"), "Parler à un programme du Mac (non pris en charge)");
  }
  const known = new Set([
    "scripting", "storage", "unlimitedStorage", "tabs", "notifications", "contextMenus", "cookies",
    "webNavigation", "alarms", "offscreen", "clipboardRead", "clipboardWrite", "activeTab",
  ]);
  if (source === "store") for (const n of ["webRequest", "downloads", "nativeMessaging"]) known.add(n);
  for (const perm of p.permissions) {
    if (known.has(perm) || perm.startsWith("declarativeNetRequest")) continue;
    added(true, `Droit « ${perm} »`);
  }
  return output;
}
