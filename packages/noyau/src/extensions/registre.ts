import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ID_SITE } from "../sites/schemas.js";
import type { Portee, SourceExtension } from "./manifeste.js";

export type IdProfil = string;
export type IdSite = string;

export const RESERVE_STORE_SITE = "Seules les extensions du Chrome Web Store vont dans une appli de site";

/**
 * La portée d'une appli de site, `site:<id>`, ne sert que de clé (`vues`, sessions des extensions). Aucun id de profil
 * de forme /^[\w-]+$/ ne contient « : », donc aucun ne peut la prendre.
 */
export const PREFIXE_PORTEE_SITE = "site:";

export function porteeSite(id: IdSite): IdProfil {
  if (!ID_SITE.test(id)) throw new Error(`id d'appli de site invalide : ${id}`);
  return `${PREFIXE_PORTEE_SITE}${id}`;
}

export function siteDePortee(p: string): IdSite | null {
  if (!p.startsWith(PREFIXE_PORTEE_SITE)) return null;
  const id = p.slice(PREFIXE_PORTEE_SITE.length);
  return ID_SITE.test(id) ? id : null;
}

export const ERREUR_PROFIL_PRIVE = "Donne à cet espace privé son propre profil pour y utiliser des extensions de l'agent";

const SchemaPortee = z.object({
  permissions: z.array(z.string()),
  hotes: z.array(z.string()),
  reseau: z.array(z.string()),
  tousLesSites: z.boolean(),
  scriptsTousLesSites: z.boolean(),
  scripts: z.boolean().optional(),
});

const EntreeSchema = z.object({
  source: z.enum(["store", "agent"]),
  idChrome: z.string().nullable(),
  nom: z.string(),
  version: z.string(),
  accord: SchemaPortee.nullable(),
  profils: z.array(z.string()),
  epinglee: z.boolean(),
  modifieeLe: z.string().nullable(),
  desactivee: z.object({ raison: z.enum(["portee-elargie", "plantages"]), le: z.string() }).nullable(),
  majEnAttente: z.object({ version: z.string(), portee: SchemaPortee, chemin: z.string() }).nullable(),
  vues: z.record(z.string(), z.string()),
  applis: z.record(z.string(), z.string()).optional(),
  consoleMasquee: z.array(z.string()).optional(),
});

export interface EntreeExtension {
  source: SourceExtension;
  /** Agent : null avant le premier chargement. */
  idChrome: string | null;
  nom: string;
  version: string;
  /** Portée acceptée par l'utilisateur ; null : jamais accordée. */
  accord: Portee | null;
  /** Profils où l'extension est active. */
  profils: IdProfil[];
  epinglee: boolean;
  /** ISO ; agent : dernière copie rechargée. */
  modifieeLe: string | null;
  desactivee: { raison: "portee-elargie" | "plantages"; le: string } | null;
  /** Store. */
  majEnAttente: { version: string; portee: Portee; chemin: string } | null;
  /** Dernière version démarrée dans chaque profil. */
  vues: Record<IdProfil, string>;
  /**
   * Store : applis de site où elle est active, avec l'empreinte de leurs domaines (`empreinteExtensionsSite`) au moment
   * de l'activation. Absent : aucune.
   */
  applis?: Record<IdSite, string>;
  /**
   * Agent : profils où elle a tourné dans un onglet que l'agent ne peut pas lire. Sa console de service worker et de
   * pages lui reste masquée ; jamais remis à zéro (son stockage a pu garder ce qu'elle y a lu), effacé avec l'entrée.
   */
  consoleMasquee?: IdProfil[];
}

export interface EtatExtensions {
  version: 1;
  toutesCoupees: boolean;
  extensions: Record<string, EntreeExtension>;
  /**
   * Ids Chromium des extensions de l'agent dont la console de service worker et de pages lui reste masquée (elles ont
   * tourné dans un onglet qu'il ne peut pas lire). Survit à la suppression de l'entrée : une copie recréée au même
   * endroit a le même id. Jamais vidé.
   */
  consolesMasquees?: string[];
}

const ID_STORE = /^[a-p]{32}$/;
const ID_AGENT = /^[a-z0-9-]{1,40}$/;
/** WebAiOs-Firefox: an agent extension's add-on id (`<id>@agent.webaios`), its id in `consolesMasquees`. */
const ID_FIREFOX_AGENT = /^[a-z0-9-]{1,40}@agent\.webaios$/;

export function lireCle(cle: string): { source: SourceExtension; id: string } | null {
  const i = cle.indexOf(":");
  if (i < 0) return null;
  const source = cle.slice(0, i);
  const id = cle.slice(i + 1);
  if (source === "store" && ID_STORE.test(id)) return { source, id };
  if (source === "agent" && ID_AGENT.test(id)) return { source, id };
  return null;
}

export function cleExtension(source: SourceExtension, id: string): string {
  const cle = `${source}:${id}`;
  if (!lireCle(cle)) throw new Error(`identifiant d'extension invalide : ${cle}`);
  return cle;
}

const vide = (): EtatExtensions => ({ version: 1, toutesCoupees: false, extensions: {} });

function entreeDe(e: EtatExtensions, cle: string): EntreeExtension {
  const x = e.extensions[cle];
  if (!x) throw new Error(`extension inconnue : ${cle}`);
  return x;
}

function avec(e: EtatExtensions, cle: string, changer: (x: EntreeExtension) => EntreeExtension): EtatExtensions {
  return { ...e, extensions: { ...e.extensions, [cle]: changer(entreeDe(e, cle)) } };
}

export function activer(e: EtatExtensions, cle: string, profil: IdProfil, profilsPrives: ReadonlySet<IdProfil>): EtatExtensions {
  const x = entreeDe(e, cle);
  if (x.source === "agent" && profilsPrives.has(profil)) throw new Error(ERREUR_PROFIL_PRIVE);
  if (!x.accord) throw new Error(`extension sans accord : ${cle}`);
  return avec(e, cle, (y) => (y.profils.includes(profil) ? y : { ...y, profils: [...y.profils, profil] }));
}

export function desactiver(e: EtatExtensions, cle: string, profil: IdProfil): EtatExtensions {
  return avec(e, cle, (y) => ({ ...y, profils: y.profils.filter((p) => p !== profil) }));
}

export function desactiverPartout(e: EtatExtensions, cle: string): EtatExtensions {
  return avec(e, cle, (y) => {
    const { applis: _, ...reste } = y;
    return { ...reste, profils: [] };
  });
}

/** Active une extension du Store dans une appli de site, pour l'empreinte de ses domaines d'aujourd'hui. */
export function activerDansSite(e: EtatExtensions, cle: string, site: IdSite, empreinte: string): EtatExtensions {
  const x = entreeDe(e, cle);
  if (x.source !== "store") throw new Error(RESERVE_STORE_SITE);
  if (!x.accord) throw new Error(`extension sans accord : ${cle}`);
  return avec(e, cle, (y) => ({ ...y, applis: { ...y.applis, [site]: empreinte } }));
}

export function desactiverDansSite(e: EtatExtensions, cle: string, site: IdSite): EtatExtensions {
  return avec(e, cle, (y) => sansAppli(y, site));
}

function sansAppli(x: EntreeExtension, site: IdSite): EntreeExtension {
  const { applis, ...reste } = x;
  if (!applis) return x;
  const { [site]: _, ...autres } = applis;
  return Object.keys(autres).length ? { ...reste, applis: autres } : reste;
}

/** Oublie l'appli : ses activations et la dernière version démarrée dans sa portée. */
export function retirerSite(e: EtatExtensions, site: IdSite): EtatExtensions {
  const portee = porteeSite(site);
  const extensions: Record<string, EntreeExtension> = {};
  for (const [cle, x] of Object.entries(e.extensions)) {
    const { [portee]: _, ...vues } = x.vues;
    extensions[cle] = { ...sansAppli(x, site), vues };
  }
  return { ...e, extensions };
}

/** Ni profil ni appli. */
export function activeNullePart(x: EntreeExtension): boolean {
  return x.profils.length === 0 && Object.keys(x.applis ?? {}).length === 0;
}

export function couperTout(e: EtatExtensions, oui: boolean): EtatExtensions {
  return { ...e, toutesCoupees: oui };
}

export function retirer(e: EtatExtensions, cle: string): EtatExtensions {
  const { [cle]: _, ...reste } = e.extensions;
  return { ...e, extensions: reste };
}

export function epingler(e: EtatExtensions, cle: string, oui: boolean): EtatExtensions {
  return avec(e, cle, (y) => ({ ...y, epinglee: oui }));
}

export function retirerProfil(e: EtatExtensions, profil: IdProfil): EtatExtensions {
  const extensions: Record<string, EntreeExtension> = {};
  for (const [cle, x] of Object.entries(e.extensions)) {
    const vues = Object.fromEntries(Object.entries(x.vues).filter(([p]) => p !== profil));
    extensions[cle] = { ...x, profils: x.profils.filter((p) => p !== profil), vues };
  }
  return { ...e, extensions };
}

/** Retire chaque extension de l'agent des profils privés ; celles du Store restent. */
export function appliquerProfilsPrives(
  e: EtatExtensions,
  profilsPrives: ReadonlySet<IdProfil>,
): { etat: EtatExtensions; retirees: { cle: string; profil: IdProfil }[] } {
  const retirees: { cle: string; profil: IdProfil }[] = [];
  const extensions: Record<string, EntreeExtension> = {};
  for (const [cle, x] of Object.entries(e.extensions)) {
    if (x.source !== "agent") {
      extensions[cle] = x;
      continue;
    }
    for (const profil of x.profils) if (profilsPrives.has(profil)) retirees.push({ cle, profil });
    extensions[cle] = { ...x, profils: x.profils.filter((p) => !profilsPrives.has(p)) };
  }
  return { etat: { ...e, extensions }, retirees };
}

/** Clés actives dans ce profil, avec un accord, non désactivées ; rien pendant la coupure générale. */
export function chargeesDans(e: EtatExtensions, profil: IdProfil, profilPrive: boolean): string[] {
  if (e.toutesCoupees) return [];
  return Object.entries(e.extensions)
    .filter(([, x]) => !(profilPrive && x.source === "agent"))
    .filter(([, x]) => x.profils.includes(profil) && x.accord !== null && x.desactivee === null)
    .map(([cle]) => cle);
}

/** Clés du Store actives dans cette appli pour cette empreinte, avec un accord, non désactivées ; rien pendant la coupure générale. */
export function chargeesDansSite(e: EtatExtensions, site: IdSite, empreinte: string | null): string[] {
  if (e.toutesCoupees || empreinte === null) return [];
  return Object.entries(e.extensions)
    .filter(([, x]) => x.source === "store" && x.accord !== null && x.desactivee === null && x.applis?.[site] === empreinte)
    .map(([cle]) => cle);
}

const fichier = (dossier: string) => join(dossier, "etat.json");

interface Lecture {
  etat: EtatExtensions;
  /** Fichier présent mais illisible, de forme inconnue, ou dont des entrées ont été ignorées. */
  abime: boolean;
  /** Fichier d'une version plus récente : lecture vide, écriture refusée. */
  futur: boolean;
}

async function lire(dossier: string): Promise<Lecture> {
  let texte: string;
  try {
    texte = await readFile(fichier(dossier), "utf8");
  } catch (erreur) {
    if ((erreur as NodeJS.ErrnoException).code === "ENOENT") return { etat: vide(), abime: false, futur: false };
    throw erreur;
  }
  let brut: unknown;
  try {
    brut = JSON.parse(texte);
  } catch {
    return { etat: vide(), abime: true, futur: false };
  }
  if (!brut || typeof brut !== "object" || Array.isArray(brut)) return { etat: vide(), abime: true, futur: false };
  const b = brut as { version?: unknown; toutesCoupees?: unknown; extensions?: unknown; consolesMasquees?: unknown };
  if (typeof b.version === "number" && b.version > 1) return { etat: vide(), abime: false, futur: true };
  if (b.version !== 1) return { etat: vide(), abime: true, futur: false };
  const extensions: Record<string, EntreeExtension> = {};
  let abime = false;
  if (b.extensions && typeof b.extensions === "object" && !Array.isArray(b.extensions)) {
    for (const [cle, valeur] of Object.entries(b.extensions)) {
      const cleLue = lireCle(cle);
      const r = EntreeSchema.safeParse(valeur);
      if (cleLue && r.success && r.data.source === cleLue.source) extensions[cle] = r.data;
      else abime = true;
    }
  } else if (b.extensions !== undefined) abime = true;
  const masquees = Array.isArray(b.consolesMasquees) ? b.consolesMasquees.filter((x): x is string => typeof x === "string" && (ID_STORE.test(x) || ID_FIREFOX_AGENT.test(x))) : [];
  const etat: EtatExtensions = { version: 1, toutesCoupees: b.toutesCoupees === true, extensions };
  if (masquees.length) etat.consolesMasquees = [...new Set(masquees)];
  return { etat, abime, futur: false };
}

/**
 * L'état du fichier. Absent (ENOENT) : état vide. Abîmé ou de version future : état vide aussi, sans rien effacer
 * (voir `modifierEtatExtensions`). Lève pour toute erreur de lecture autre que ENOENT.
 */
export async function lireEtatExtensions(dossier: string): Promise<EtatExtensions> {
  return (await lire(dossier)).etat;
}

/** Une écriture à la fois par dossier ; fichier temporaire puis `rename`. */
const files = new Map<string, Promise<unknown>>();

/**
 * Modifie l'état, une écriture à la fois. `changer` reçoit l'état et les profils privés ; `profilsPrives` est un
 * fournisseur évalué DANS la modification sérialisée (jamais capturé avant), et `appliquerProfilsPrives` est
 * rappliqué au résultat. Un fichier abîmé (ou aux entrées ignorées) est copié en `etat.json.abime-<horodatage>` avant
 * d'être remplacé ; un fichier de version plus récente refuse l'écriture.
 */
export function modifierEtatExtensions(
  dossier: string,
  changer: (e: EtatExtensions, profilsPrives: ReadonlySet<IdProfil>) => EtatExtensions,
  profilsPrives: () => ReadonlySet<IdProfil>,
): Promise<EtatExtensions> {
  const precedente = files.get(dossier) ?? Promise.resolve();
  const suivante = precedente.catch(() => {}).then(async () => {
    const lu = await lire(dossier);
    if (lu.futur) throw new Error("état des extensions d'une version plus récente");
    const prives = profilsPrives();
    const nouveau = appliquerProfilsPrives(changer(lu.etat, prives), prives).etat;
    await mkdir(dossier, { recursive: true });
    if (lu.abime) await copyFile(fichier(dossier), `${fichier(dossier)}.abime-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    const temporaire = `${fichier(dossier)}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaire, JSON.stringify(nouveau, null, 2));
      await rename(temporaire, fichier(dossier));
    } finally {
      await rm(temporaire, { force: true });
    }
    return nouveau;
  });
  files.set(dossier, suivante);
  void suivante.finally(() => {
    if (files.get(dossier) === suivante) files.delete(dossier);
  }).catch(() => {});
  return suivante;
}
