import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Portee, SourceExtension } from "./manifeste.js";

export type IdProfil = string;

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
}

export interface EtatExtensions {
  version: 1;
  toutesCoupees: boolean;
  extensions: Record<string, EntreeExtension>;
}

const ID_STORE = /^[a-p]{32}$/;
const ID_AGENT = /^[a-z0-9-]{1,40}$/;

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
  return avec(e, cle, (y) => ({ ...y, profils: [] }));
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
export function chargeesDans(e: EtatExtensions, profil: IdProfil): string[] {
  if (e.toutesCoupees) return [];
  return Object.entries(e.extensions)
    .filter(([, x]) => x.profils.includes(profil) && x.accord !== null && x.desactivee === null)
    .map(([cle]) => cle);
}

const fichier = (dossier: string) => join(dossier, "etat.json");

/** L'état du fichier ; absent ou abîmé : état vide, sans rien effacer. Les entrées invalides sont ignorées. */
export async function lireEtatExtensions(dossier: string): Promise<EtatExtensions> {
  let brut: unknown;
  try {
    brut = JSON.parse(await readFile(fichier(dossier), "utf8"));
  } catch {
    return vide();
  }
  if (!brut || typeof brut !== "object" || Array.isArray(brut)) return vide();
  const b = brut as { version?: unknown; toutesCoupees?: unknown; extensions?: unknown };
  if (b.version !== 1) return vide();
  const extensions: Record<string, EntreeExtension> = {};
  if (b.extensions && typeof b.extensions === "object" && !Array.isArray(b.extensions)) {
    for (const [cle, valeur] of Object.entries(b.extensions)) {
      const cleLue = lireCle(cle);
      const r = EntreeSchema.safeParse(valeur);
      if (cleLue && r.success && r.data.source === cleLue.source) extensions[cle] = r.data;
    }
  }
  return { version: 1, toutesCoupees: b.toutesCoupees === true, extensions };
}

/** Une écriture à la fois par dossier ; fichier temporaire puis `rename`. */
const files = new Map<string, Promise<unknown>>();

export function modifierEtatExtensions(
  dossier: string,
  changer: (e: EtatExtensions) => EtatExtensions,
): Promise<EtatExtensions> {
  const precedente = files.get(dossier) ?? Promise.resolve();
  const suivante = precedente.catch(() => {}).then(async () => {
    const nouveau = changer(await lireEtatExtensions(dossier));
    await mkdir(dossier, { recursive: true });
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
