// Ancien modèle « blocs » de la page d'accueil. Le noyau ne s'en sert plus ; apps/navigateur l'utilise encore jusqu'à la tâche 8.
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { CheminsEspace } from "../chemins.js";

const urlWeb = z.string().refine((u) => {
  try {
    return ["http:", "https:"].includes(new URL(u).protocol);
  } catch {
    return false;
  }
}, "URL http(s) attendue");

export const ConfigBloc = z.discriminatedUnion("type", [
  z.object({
    titre: z.string().min(1).max(80),
    type: z.literal("agent"),
    consigne: z.string().min(1),
    rafraichissement: z.object({ heures: z.number().positive() }).optional(),
  }),
  z.object({
    titre: z.string().min(1).max(80),
    type: z.literal("app"),
    url: urlWeb,
  }),
]);
export type ConfigBloc = z.infer<typeof ConfigBloc>;
export type ConfigBlocAgent = Extract<ConfigBloc, { type: "agent" }>;

export const EtatBloc = z.object({
  derniereMaj: z.string().nullable(),
  derniereTentative: z.string().nullable(),
  statut: z.enum(["ok", "en-cours", "erreur"]),
  erreur: z.string().optional(),
});
export type EtatBloc = z.infer<typeof EtatBloc>;

export const ETAT_PAR_DEFAUT: EtatBloc = { derniereMaj: null, derniereTentative: null, statut: "ok" };

export const DispositionBlocs = z.object({ ordre: z.array(z.string()) });
export type DispositionBlocs = z.infer<typeof DispositionBlocs>;

export type BlocLu =
  | { id: string; dossier: string; config: ConfigBloc; etat: EtatBloc; cheminHtml: string | null }
  | { id: string; dossier: string; erreur: string };

export interface EtatAccueilBlocs {
  ordre: string[];
  blocs: BlocLu[];
}


async function lireJson(chemin: string): Promise<unknown> {
  return JSON.parse(await readFile(chemin, "utf8"));
}

async function lireBloc(c: CheminsEspace, id: string): Promise<BlocLu> {
  const dossier = join(c.blocs, id);
  let config: ConfigBloc;
  try {
    config = ConfigBloc.parse(await lireJson(join(dossier, "bloc.json")));
  } catch (e) {
    return { id, dossier, erreur: `bloc.json invalide : ${(e as Error).message}` };
  }
  let etat = ETAT_PAR_DEFAUT;
  try {
    etat = EtatBloc.parse(await lireJson(join(dossier, "etat.json")));
  } catch {
    // etat.json absent ou abîmé : on repart de l'état par défaut.
  }
  const html = join(dossier, "index.html");
  const cheminHtml = config.type === "agent" && existsSync(html) ? html : null;
  return { id, dossier, config, etat, cheminHtml };
}

async function lireOrdre(c: CheminsEspace): Promise<string[]> {
  try {
    return DispositionBlocs.parse(await lireJson(c.disposition)).ordre;
  } catch {
    return [];
  }
}

/** Lit la page d'accueil. Un bloc cassé est signalé, il n'empêche pas de lire les autres. */
export async function lireAccueilBlocs(c: CheminsEspace): Promise<EtatAccueilBlocs> {
  if (!existsSync(c.blocs)) return { ordre: [], blocs: [] };
  const ids = (await readdir(c.blocs, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const voulus = (await lireOrdre(c)).filter((id) => ids.includes(id));
  const ordre = [...new Set(voulus), ...ids.filter((id) => !voulus.includes(id))];
  return { ordre, blocs: await Promise.all(ordre.map((id) => lireBloc(c, id))) };
}

export async function ecrireEtatBloc(c: CheminsEspace, id: string, etat: EtatBloc): Promise<void> {
  const cible = join(c.blocs, id, "etat.json");
  const temporaire = `${cible}.${process.pid}.tmp`;
  await writeFile(temporaire, JSON.stringify(etat, null, 2));
  await rename(temporaire, cible);
}
