import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Proprietaire } from "./schema.js";

export const SORTIE_MAX_OCTETS = 256 * 1024;
export const EXECUTION_MAX_OCTETS = 4 * 1024 * 1024;
export const EXECUTIONS_GARDEES = 20;
export const ID_EXECUTION = /^[0-9TZ-]+$/;

export const TraceBloc = z.object({
  id: z.string(),
  type: z.string(),
  statut: z.enum(["reussi", "partiel", "echoue", "pas-lance"]),
  debut: z.string().nullable(),
  fin: z.string().nullable(),
  elements: z.number().nullable(),
  sortie: z.unknown().optional(),
  sortieTronquee: z.literal(true).optional(),
  erreur: z.string().optional(),
  journal: z.array(z.string()),
});
export type TraceBloc = z.infer<typeof TraceBloc>;

export const Execution = z.object({
  version: z.literal(1),
  id: z.string(),
  proprietaire: z.object({ type: z.literal("widget"), id: z.string() }),
  declencheur: z.enum(["planifiee", "manuelle", "agent"]),
  debut: z.string(),
  fin: z.string().nullable(),
  statut: z.enum(["reussie", "partielle", "echouee", "interrompue", "accord-requis"]),
  erreur: z.string().optional(),
  erreurNoyau: z.literal(true).optional(),
  blocs: z.array(TraceBloc),
});
export type Execution = Omit<z.infer<typeof Execution>, "proprietaire"> & { proprietaire: Proprietaire };

export type ResumeExecution = Pick<Execution, "id" | "declencheur" | "debut" | "fin" | "statut"> & {
  blocs: { id: string; statut: TraceBloc["statut"]; elements: number | null }[];
};

/** Identifiant d'une exécution : son début ISO, sans « : » ni « . » (sûr comme nom de fichier). */
export function idExecution(debutIso: string): string {
  return debutIso.replace(/[:.]/g, "-");
}

const dossierExecutions = (dossierDonnees: string) => join(dossierDonnees, "executions");

// Un nom temporaire propre à chaque écriture, comme pour donnees.json.
async function ecrireAtomique(cible: string, texte: string): Promise<void> {
  await mkdir(join(cible, ".."), { recursive: true });
  const temporaire = `${cible}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaire, texte);
    await rename(temporaire, cible);
  } finally {
    await rm(temporaire, { force: true });
  }
}

function coupe(texte: string, octets: number): string {
  let s = texte.slice(0, octets);
  while (Buffer.byteLength(s) > octets) s = s.slice(0, Math.floor(s.length * 0.9));
  return s;
}

// Filet de sécurité : une sortie trop grosse est gardée en texte (le début de son JSON) et marquée ; si le fichier
// dépasse encore 4 Mo, les plus grosses sorties partent d'abord.
function tronquer(e: Execution): Execution {
  const tailles: number[] = [];
  const blocs = e.blocs.map((b, i) => {
    tailles[i] = 0;
    if (b.sortie === undefined) return b;
    const texte = JSON.stringify(b.sortie) ?? "null";
    const octets = Buffer.byteLength(texte);
    if (octets <= SORTIE_MAX_OCTETS) {
      tailles[i] = octets;
      return b;
    }
    const coupee = coupe(texte, SORTIE_MAX_OCTETS);
    tailles[i] = Buffer.byteLength(JSON.stringify(coupee));
    return { ...b, sortie: coupee, sortieTronquee: true as const };
  });
  let courant: Execution = { ...e, blocs };
  while (Buffer.byteLength(JSON.stringify(courant, null, 2)) > EXECUTION_MAX_OCTETS) {
    let pire = -1;
    for (let i = 0; i < blocs.length; i++) if (tailles[i]! > 0 && (pire < 0 || tailles[i]! > tailles[pire]!)) pire = i;
    if (pire < 0) break;
    const { sortie: _retiree, ...reste } = blocs[pire]!;
    blocs[pire] = { ...reste, sortieTronquee: true };
    tailles[pire] = 0;
    courant = { ...e, blocs };
  }
  return courant;
}

/** Écrit une exécution (tronquée au besoin) et ne garde que les 20 plus récentes. */
export async function ecrireExecution(dossierDonnees: string, e: Execution): Promise<void> {
  if (!ID_EXECUTION.test(e.id)) throw new Error(`id d'exécution invalide : ${e.id}`);
  const dossier = dossierExecutions(dossierDonnees);
  await ecrireAtomique(join(dossier, `${e.id}.json`), JSON.stringify(tronquer(e), null, 2));
  const noms = (await nomsExecutions(dossier)).sort();
  for (const nom of noms.slice(0, Math.max(0, noms.length - EXECUTIONS_GARDEES))) {
    await rm(join(dossier, nom), { force: true });
  }
}

async function nomsExecutions(dossier: string): Promise<string[]> {
  try {
    return (await readdir(dossier)).filter((n) => n.endsWith(".json") && ID_EXECUTION.test(n.slice(0, -5)));
  } catch {
    return [];
  }
}

export async function lireExecution(dossierDonnees: string, id: string): Promise<Execution | null> {
  if (!ID_EXECUTION.test(id)) return null;
  try {
    const lue = Execution.parse(JSON.parse(await readFile(join(dossierExecutions(dossierDonnees), `${id}.json`), "utf8")));
    return lue as Execution;
  } catch {
    return null;
  }
}

/** Résumés des exécutions gardées, la plus récente d'abord ; un fichier abîmé est ignoré. */
export async function listerExecutions(dossierDonnees: string): Promise<ResumeExecution[]> {
  const noms = (await nomsExecutions(dossierExecutions(dossierDonnees))).sort().reverse();
  const resumes: ResumeExecution[] = [];
  for (const nom of noms) {
    const e = await lireExecution(dossierDonnees, nom.slice(0, -5));
    if (!e) continue;
    resumes.push({
      id: e.id,
      declencheur: e.declencheur,
      debut: e.debut,
      fin: e.fin,
      statut: e.statut,
      blocs: e.blocs.map((b) => ({ id: b.id, statut: b.statut, elements: b.elements })),
    });
  }
  return resumes;
}
