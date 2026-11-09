import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Owner } from "./schema.js";

export const SORTIE_MAX_OCTETS = 256 * 1024;
export const EXECUTION_MAX_OCTETS = 4 * 1024 * 1024;
/** The reason for an action run stopped by the user. */
export const ACTION_STOPPED = "Arrêtée à ta demande";
export const KEPT_RUNS = 20;
/** Tries (builder replays) have their own quota: they never push out a real run. */
export const KEPT_ATTEMPTS = 10;
export const ID_EXECUTION = /^[0-9TZ-]+(?:-essai)?$/;
const ATTEMPT_SUFFIX = "-essai";

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
export type Execution = Omit<z.infer<typeof Execution>, "proprietaire"> & { proprietaire: Owner };

export type ResumeExecution = Pick<Execution, "id" | "declencheur" | "debut" | "fin" | "statut" | "essai" | "saisie"> & {
  blocs: { id: string; statut: TraceBloc["statut"]; elements: number | null }[];
};

/** A run's identifier: its ISO start, without « : » or « . » (safe as a file name). */
export function idExecution(debutIso: string): string {
  return debutIso.replace(/[:.]/g, "-");
}

/** A try's identifier: that of the run that has the same start, followed by « -essai ». */
export function attemptId(debutIso: string): string {
  return idExecution(debutIso) + ATTEMPT_SUFFIX;
}

const dossierExecutions = (dataFolder: string) => join(dataFolder, "executions");

// A temporary name specific to each write, as for donnees.json.
export async function writeAtomic(target: string, text: string): Promise<void> {
  await mkdir(join(target, ".."), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text);
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true });
  }
}

const LIGNE_MAX_OCTETS = 2 * 1024;
const MAX_ERROR_BYTES = 2 * 1024;
const LIGNES_MAX = 200;

/** The start of a text, `octets` bytes at most. */
export function coupe(text: string, octets: number): string {
  let s = text.slice(0, octets);
  while (Buffer.byteLength(s) > octets) s = s.slice(0, Math.floor(s.length * 0.9));
  return s;
}

// Safety net: an output that is too big is kept as text (the start of its JSON) and marked; if the file
// still exceeds 4 MB, the biggest outputs go first.
function truncate(entree: Execution): Execution {
  const e: Execution = entree.erreur === undefined ? entree : { ...entree, erreur: coupe(entree.erreur, MAX_ERROR_BYTES) };
  const tailles: number[] = [];
  const blocs = e.blocs.map((b0, i) => {
    const b = clampText(b0);
    tailles[i] = 0;
    if (b.sortie === undefined) return b;
    const text = JSON.stringify(b.sortie) ?? "null";
    const octets = Buffer.byteLength(text);
    if (octets <= SORTIE_MAX_OCTETS) {
      tailles[i] = octets;
      return b;
    }
    const coupee = coupe(text, SORTIE_MAX_OCTETS);
    tailles[i] = Buffer.byteLength(JSON.stringify(coupee));
    return { ...b, sortie: coupee, sortieTronquee: true as const };
  });
  let courant: Execution = { ...e, blocs };
  while (Buffer.byteLength(JSON.stringify(courant, null, 2)) > EXECUTION_MAX_OCTETS) {
    let worst = -1;
    for (let i = 0; i < blocs.length; i++) if (tailles[i]! > 0 && (worst < 0 || tailles[i]! > tailles[worst]!)) worst = i;
    if (worst < 0) break;
    const { sortie: _removed, ...rest } = blocs[worst]!;
    blocs[worst] = { ...rest, sortieTronquee: true };
    tailles[worst] = 0;
    courant = { ...e, blocs };
  }
  // Still too big: the longest logs are replaced by a remark line.
  while (Buffer.byteLength(JSON.stringify(courant, null, 2)) > EXECUTION_MAX_OCTETS) {
    let worst = -1;
    let max = 0;
    for (let i = 0; i < blocs.length; i++) {
      const t = Buffer.byteLength(JSON.stringify(blocs[i]!.journal));
      if (t > max) {
        max = t;
        worst = i;
      }
    }
    if (worst < 0 || blocs[worst]!.journal.length <= 1) break;
    blocs[worst] = { ...blocs[worst]!, journal: [`… ${blocs[worst]!.journal.length} lignes coupées`] };
    courant = { ...e, blocs };
  }
  return courant;
}

// Error and log of a block: lines of 2 KB at most, 200 lines at most (the last ones are kept).
function clampText(b: TraceBloc): TraceBloc {
  let journal = b.journal.map((l) => (Buffer.byteLength(l) > LIGNE_MAX_OCTETS ? coupe(l, LIGNE_MAX_OCTETS) : l));
  if (journal.length > LIGNES_MAX) {
    journal = [`… ${journal.length - LIGNES_MAX} lignes coupées`, ...journal.slice(-LIGNES_MAX)];
  }
  return { ...b, journal, ...(b.erreur === undefined ? {} : { erreur: coupe(b.erreur, MAX_ERROR_BYTES) }) };
}

/** Writes a run (truncated if needed) and only keeps the 20 most recent real ones, and the 10 most recent tries. */
export async function writeRun(dataFolder: string, e: Execution): Promise<void> {
  if (!ID_EXECUTION.test(e.id)) throw new Error(`id d'exécution invalide : ${e.id}`);
  const dossier = dossierExecutions(dataFolder);
  await writeAtomic(join(dossier, `${e.id}.json`), JSON.stringify(truncate(e), null, 2));
  const names = await runNames(dossier);
  for (const [group, kept] of [
    [names.filter((n) => !n.endsWith(`${ATTEMPT_SUFFIX}.json`)), KEPT_RUNS],
    [names.filter((n) => n.endsWith(`${ATTEMPT_SUFFIX}.json`)), KEPT_ATTEMPTS],
  ] as const) {
    const sorted = [...group].sort();
    for (const name of sorted.slice(0, Math.max(0, sorted.length - kept))) await rm(join(dossier, name), { force: true });
  }
}

async function runNames(dossier: string): Promise<string[]> {
  try {
    return (await readdir(dossier)).filter((n) => n.endsWith(".json") && ID_EXECUTION.test(n.slice(0, -5)));
  } catch {
    return [];
  }
}

export async function lireExecution(dataFolder: string, id: string): Promise<Execution | null> {
  if (!ID_EXECUTION.test(id)) return null;
  try {
    const path = join(dossierExecutions(dataFolder), `${id}.json`);
    if ((await stat(path)).size > EXECUTION_MAX_OCTETS) return null;
    const lue = Execution.parse(JSON.parse(await readFile(path, "utf8")));
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
export async function listerExecutions(dataFolder: string): Promise<ResumeExecution[]> {
  const dossier = dossierExecutions(dataFolder);
  const names = (await runNames(dossier)).sort().reverse();
  const resumes: ResumeExecution[] = [];
  for (const name of names) {
    const path = join(dossier, name);
    let s;
    try {
      s = await stat(path);
    } catch {
      continue;
    }
    const known = resumesLus.get(path);
    let resume: ResumeExecution | null;
    if (known && known.ino === s.ino && known.mtimeMs === s.mtimeMs && known.size === s.size) resume = known.resume;
    else {
      const e = await lireExecution(dataFolder, name.slice(0, -5));
      resume = e ? resumer(e) : null;
      resumesLus.delete(path);
      resumesLus.set(path, { ino: s.ino, mtimeMs: s.mtimeMs, size: s.size, resume });
      // The oldest entries go first.
      while (resumesLus.size > RESUMES_LUS_MAX) resumesLus.delete(resumesLus.keys().next().value!);
    }
    if (resume) resumes.push(resume);
  }
  return resumes;
}
