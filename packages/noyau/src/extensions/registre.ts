import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Portee, SourceExtension } from "./manifeste.js";

export type IdProfil = string;
export type IdSite = string;

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
  /** Agent: null before the first load. */
  idChrome: string | null;
  nom: string;
  version: string;
  /** Scope accepted by the user; null: never granted. */
  accord: Portee | null;
  /** Profiles where the extension is active. */
  profils: IdProfil[];
  epinglee: boolean;
  /** ISO; agent: last copy reloaded. */
  modifieeLe: string | null;
  desactivee: { raison: "portee-elargie" | "plantages"; le: string } | null;
  /** Store. */
  majEnAttente: { version: string; portee: Portee; chemin: string } | null;
  /** Last version started in each profile. */
  vues: Record<IdProfil, string>;
  /**
   * Store: site apps where it is active, with the hash of their domains (`empreinteExtensionsSite`) at the time
   * of activation. Absent: none.
   */
  applis?: Record<IdSite, string>;
  /**
   * Agent: profiles where it ran in a tab the agent cannot read. Its service worker and pages console
   * stays hidden from it; never reset (its storage may have kept what it read there), erased with the entry.
   */
  consoleMasquee?: IdProfil[];
}

export interface EtatExtensions {
  version: 1;
  toutesCoupees: boolean;
  extensions: Record<string, EntreeExtension>;
  /**
   * Chromium ids of the agent's extensions whose service worker and pages console stays hidden from it (they
   * ran in a tab it cannot read). Survives the entry's deletion: a copy recreated at the same
   * place has the same id. Never emptied.
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

/** Removes each agent extension from private profiles; the Store ones stay. */
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

const fichier = (dossier: string) => join(dossier, "etat.json");

interface Lecture {
  etat: EtatExtensions;
  /** File present but unreadable, of unknown shape, or with entries that were ignored. */
  abime: boolean;
  /** File of a newer version: empty read, write denied. */
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
 * The state of the file. Absent (ENOENT): empty state. Damaged or of a future version: empty state too, erasing nothing
 * (see `modifierEtatExtensions`). Throws for any read error other than ENOENT.
 */
export async function lireEtatExtensions(dossier: string): Promise<EtatExtensions> {
  return (await lire(dossier)).etat;
}

/** One write at a time per folder; temporary file then `rename`. */
const files = new Map<string, Promise<unknown>>();

/**
 * Modifies the state, one write at a time. `changer` receives the state and the private profiles; `profilsPrives` is a
 * provider evaluated INSIDE the serialized modification (never captured before), and `appliquerProfilsPrives` is
 * re-applied to the result. A damaged file (or one with ignored entries) is copied to `etat.json.abime-<timestamp>` before
 * being replaced; a file of a newer version refuses the write.
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
