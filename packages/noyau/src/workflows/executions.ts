import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Proprietaire } from "./schema.js";

export const SORTIE_MAX_OCTETS = 256 * 1024;
export const EXECUTION_MAX_OCTETS = 4 * 1024 * 1024;
/** The reason for an action run stopped by the user. */
export const ACTION_ARRETEE = "Arrêtée à ta demande";
export const EXECUTIONS_GARDEES = 20;
/** Tries (builder replays) have their own quota: they never push out a real run. */
export const ESSAIS_GARDES = 10;
export const ID_EXECUTION = /^[0-9TZ-]+(?:-essai)?$/;
const SUFFIXE_ESSAI = "-essai";

export const TraceBloc = z.object({
  id: z.string(),
  type: z.string(),
  // « interrompu »: started, not finished, when WebAiOs stopped during the run.
  // « repris »: output taken from the original run of a try, without being copied (`elements` is).
  statut: z.enum(["reussi", "partiel", "echoue", "interrompu", "pas-lance", "repris"]),
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
  proprietaire: z.object({ type: z.enum(["widget", "action"]), id: z.string() }),
  // The input of an action launched with a text (clio lyon).
  saisie: z.string().max(200).optional(),
  declencheur: z.enum(["planifiee", "manuelle", "agent", "rejeu"]),
  // Only for a try: the start block and the run whose upstream outputs are taken.
  essai: z.object({ depart: z.string(), origine: z.string() }).optional(),
  debut: z.string(),
  fin: z.string().nullable(),
  statut: z.enum(["reussie", "partielle", "echouee", "interrompue", "accord-requis"]),
  erreur: z.string().optional(),
  erreurNoyau: z.literal(true).optional(),
  blocs: z.array(TraceBloc),
});
export type Execution = Omit<z.infer<typeof Execution>, "proprietaire"> & { proprietaire: Proprietaire };

export type ResumeExecution = Pick<Execution, "id" | "declencheur" | "debut" | "fin" | "statut" | "essai" | "saisie"> & {
  blocs: { id: string; statut: TraceBloc["statut"]; elements: number | null }[];
};

/** A run's identifier: its ISO start, without « : » or « . » (safe as a file name). */
export function idExecution(debutIso: string): string {
  return debutIso.replace(/[:.]/g, "-");
}

/** A try's identifier: that of the run that has the same start, followed by « -essai ». */
export function idEssai(debutIso: string): string {
  return idExecution(debutIso) + SUFFIXE_ESSAI;
}

const dossierExecutions = (dossierDonnees: string) => join(dossierDonnees, "executions");

// A temporary name specific to each write, as for donnees.json.
export async function ecrireAtomique(cible: string, texte: string): Promise<void> {
  await mkdir(join(cible, ".."), { recursive: true });
  const temporaire = `${cible}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaire, texte);
    await rename(temporaire, cible);
  } finally {
    await rm(temporaire, { force: true });
  }
}

const LIGNE_MAX_OCTETS = 2 * 1024;
const ERREUR_MAX_OCTETS = 2 * 1024;
const LIGNES_MAX = 200;

/** The start of a text, `octets` bytes at most. */
export function coupe(texte: string, octets: number): string {
  let s = texte.slice(0, octets);
  while (Buffer.byteLength(s) > octets) s = s.slice(0, Math.floor(s.length * 0.9));
  return s;
}

// Safety net: an output that is too big is kept as text (the start of its JSON) and marked; if the file
// still exceeds 4 MB, the biggest outputs go first.
function tronquer(entree: Execution): Execution {
  const e: Execution = entree.erreur === undefined ? entree : { ...entree, erreur: coupe(entree.erreur, ERREUR_MAX_OCTETS) };
  const tailles: number[] = [];
  const blocs = e.blocs.map((b0, i) => {
    const b = bornerTexte(b0);
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
  // Still too big: the longest logs are replaced by a remark line.
  while (Buffer.byteLength(JSON.stringify(courant, null, 2)) > EXECUTION_MAX_OCTETS) {
    let pire = -1;
    let max = 0;
    for (let i = 0; i < blocs.length; i++) {
      const t = Buffer.byteLength(JSON.stringify(blocs[i]!.journal));
      if (t > max) {
        max = t;
        pire = i;
      }
    }
    if (pire < 0 || blocs[pire]!.journal.length <= 1) break;
    blocs[pire] = { ...blocs[pire]!, journal: [`… ${blocs[pire]!.journal.length} lignes coupées`] };
    courant = { ...e, blocs };
  }
  return courant;
}

// Error and log of a block: lines of 2 KB at most, 200 lines at most (the last ones are kept).
function bornerTexte(b: TraceBloc): TraceBloc {
  let journal = b.journal.map((l) => (Buffer.byteLength(l) > LIGNE_MAX_OCTETS ? coupe(l, LIGNE_MAX_OCTETS) : l));
  if (journal.length > LIGNES_MAX) {
    journal = [`… ${journal.length - LIGNES_MAX} lignes coupées`, ...journal.slice(-LIGNES_MAX)];
  }
  return { ...b, journal, ...(b.erreur === undefined ? {} : { erreur: coupe(b.erreur, ERREUR_MAX_OCTETS) }) };
}

/** Writes a run (truncated if needed) and only keeps the 20 most recent real ones, and the 10 most recent tries. */
export async function ecrireExecution(dossierDonnees: string, e: Execution): Promise<void> {
  if (!ID_EXECUTION.test(e.id)) throw new Error(`id d'exécution invalide : ${e.id}`);
  const dossier = dossierExecutions(dossierDonnees);
  await ecrireAtomique(join(dossier, `${e.id}.json`), JSON.stringify(tronquer(e), null, 2));
  const noms = await nomsExecutions(dossier);
  for (const [groupe, gardees] of [
    [noms.filter((n) => !n.endsWith(`${SUFFIXE_ESSAI}.json`)), EXECUTIONS_GARDEES],
    [noms.filter((n) => n.endsWith(`${SUFFIXE_ESSAI}.json`)), ESSAIS_GARDES],
  ] as const) {
    const tries = [...groupe].sort();
    for (const nom of tries.slice(0, Math.max(0, tries.length - gardees))) await rm(join(dossier, nom), { force: true });
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
    const chemin = join(dossierExecutions(dossierDonnees), `${id}.json`);
    if ((await stat(chemin)).size > EXECUTION_MAX_OCTETS) return null;
    const lue = Execution.parse(JSON.parse(await readFile(chemin, "utf8")));
    return lue as Execution;
  } catch {
    return null;
  }
}

function resumer(e: Execution): ResumeExecution {
  return {
    id: e.id,
    declencheur: e.declencheur,
    ...(e.essai ? { essai: e.essai } : {}),
    ...(e.saisie !== undefined ? { saisie: e.saisie } : {}),
    debut: e.debut,
    fin: e.fin,
    statut: e.statut,
    blocs: e.blocs.map((b) => ({ id: b.id, statut: b.statut, elements: b.elements })),
  };
}

/**
 * Summaries already read, by path, with the file's inode, date and size: the list is re-read at each change
 * of a widget (up to 20 files of 4 MB each), only a new or rewritten file is re-read. null: damaged file.
 */
const resumesLus = new Map<string, { ino: number; mtimeMs: number; size: number; resume: ResumeExecution | null }>();
const RESUMES_LUS_MAX = 1000;

/** Summaries of the kept runs, most recent first; a damaged file is ignored. */
export async function listerExecutions(dossierDonnees: string): Promise<ResumeExecution[]> {
  const dossier = dossierExecutions(dossierDonnees);
  const noms = (await nomsExecutions(dossier)).sort().reverse();
  const resumes: ResumeExecution[] = [];
  for (const nom of noms) {
    const chemin = join(dossier, nom);
    let s;
    try {
      s = await stat(chemin);
    } catch {
      continue;
    }
    const connu = resumesLus.get(chemin);
    let resume: ResumeExecution | null;
    if (connu && connu.ino === s.ino && connu.mtimeMs === s.mtimeMs && connu.size === s.size) resume = connu.resume;
    else {
      const e = await lireExecution(dossierDonnees, nom.slice(0, -5));
      resume = e ? resumer(e) : null;
      resumesLus.delete(chemin);
      resumesLus.set(chemin, { ino: s.ino, mtimeMs: s.mtimeMs, size: s.size, resume });
      // The oldest entries go first.
      while (resumesLus.size > RESUMES_LUS_MAX) resumesLus.delete(resumesLus.keys().next().value!);
    }
    if (resume) resumes.push(resume);
  }
  return resumes;
}
