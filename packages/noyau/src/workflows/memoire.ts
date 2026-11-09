import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

export const MEMOIRE_MAX_OCTETS = 3 * 1024 * 1024;

/**
 * Memory of a widget's blocks: by block id, its type, what it kept from one run to the next and
 * the hash of the params with which it kept it (absent from an old memory).
 */
export type MemoireBlocs = Record<string, { type: string; valeur: unknown; empreinte?: string }>;

const FichierMemoire = z.object({
  version: z.literal(1),
  blocs: z.record(z.string(), z.object({ type: z.string(), valeur: z.unknown(), empreinte: z.string().optional() })),
});

function canonique(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonique);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonique((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/** JSON text of a value, keys sorted recursively: two equal values give the same text. */
export const jsonCanonique = (v: unknown): string => JSON.stringify(canonique(v));

/**
 * Hash (16 characters) of a block's params: a block's memory is only valid for its settings. `garderJours`
 * is not part of it: changing the lifetime of the kept results does not erase them.
 */
export function empreinteParametres(p: Record<string, unknown>): string {
  const { garderJours: _garderJours, ...reglages } = p;
  return createHash("sha256").update(jsonCanonique(reglages)).digest("hex").slice(0, 16);
}

const verrous = new Map<string, Promise<unknown>>();

/**
 * Runs `f` alone on this widget's memory: the write of a run's memory and the erasure of a
 * builder record go one after the other (no read-modify-write loses another).
 */
export function avecMemoire<T>(dossierDonnees: string, f: () => Promise<T>): Promise<T> {
  const cle = resolve(dossierDonnees);
  const suivante = (verrous.get(cle) ?? Promise.resolve()).catch(() => {}).then(f);
  const fin = suivante.catch(() => {});
  verrous.set(cle, fin);
  void fin.then(() => {
    if (verrous.get(cle) === fin) verrous.delete(cle);
  });
  return suivante;
}

/** The blocks' memory, or empty if absent, damaged or too big. */
export async function lireMemoire(dossierDonnees: string): Promise<MemoireBlocs> {
  const chemin = join(dossierDonnees, "memoire.json");
  try {
    if ((await stat(chemin)).size > MEMOIRE_MAX_OCTETS) return {};
    return FichierMemoire.parse(JSON.parse(await readFile(chemin, "utf8"))).blocs as MemoireBlocs;
  } catch {
    return {};
  }
}

/** Writes the memory; false, without writing anything, if it exceeds 3 MB. */
export async function ecrireMemoire(dossierDonnees: string, m: MemoireBlocs): Promise<boolean> {
  const texte = JSON.stringify({ version: 1, blocs: m });
  if (Buffer.byteLength(texte) > MEMOIRE_MAX_OCTETS) return false;
  const cible = join(dossierDonnees, "memoire.json");
  await mkdir(dossierDonnees, { recursive: true });
  const temporaire = `${cible}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaire, texte);
    await rename(temporaire, cible);
  } finally {
    await rm(temporaire, { force: true });
  }
  return true;
}

/** Erases the runs and the memory (grant withdrawal, widget removed). */
export async function effacerExecutionsEtMemoire(dossierDonnees: string): Promise<void> {
  await rm(join(dossierDonnees, "executions"), { recursive: true, force: true });
  await rm(join(dossierDonnees, "memoire.json"), { force: true });
}
