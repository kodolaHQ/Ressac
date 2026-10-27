import { mkdirSync } from "node:fs";
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { watch } from "chokidar";
import { z } from "zod";
import type { CheminsEspace } from "../chemins.js";

const REGROUPEMENT_MS = 150;
const NOM_DOSSIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const urlWeb = z.string().refine((u) => {
  try {
    return ["http:", "https:"].includes(new URL(u).protocol);
  } catch {
    return false;
  }
}, "URL http(s) attendue");

/** Les champs inconnus sont conservés (`passthrough`) pour que la réécriture ne les perde pas. */
export const Manifeste = z
  .object({
    nom: z.string().optional(),
    type: z.enum(["application", "poc"]),
    lancement: z.string().min(1),
    origine: urlWeb.optional(),
  })
  .passthrough();
export type Manifeste = z.infer<typeof Manifeste>;

export type ProjetLu = { dossier: string; chemin: string; creeLe: string; nom: string } & (
  | { manifeste: Manifeste }
  | { sansFiche: string }
);

/** Un dossier se lance seulement si son nom passe dans une commande shell sans guillemets. */
export function dossierValide(dossier: string): boolean {
  return NOM_DOSSIER.test(dossier);
}

async function lireProjet(c: CheminsEspace, dossier: string): Promise<ProjetLu> {
  const chemin = join(c.projets, dossier);
  const fichier = join(chemin, "webaios.json");
  let creeLe: Date;
  let contenu: string | undefined;
  try {
    contenu = await readFile(fichier, "utf8");
    creeLe = (await stat(fichier)).mtime;
  } catch {
    creeLe = (await stat(chemin)).mtime;
  }
  const base = { dossier, chemin, creeLe: creeLe.toISOString() };
  if (!dossierValide(dossier)) return { ...base, nom: dossier, sansFiche: "nom de dossier non pris en charge" };
  if (contenu === undefined) return { ...base, nom: dossier, sansFiche: "pas de webaios.json" };
  try {
    const manifeste = Manifeste.parse(JSON.parse(contenu));
    return { ...base, nom: manifeste.nom ?? dossier, manifeste };
  } catch (e) {
    return { ...base, nom: dossier, sansFiche: `webaios.json invalide : ${(e as Error).message}` };
  }
}

/** Liste les projets. Un manifeste absent ou cassé donne un projet « sans fiche », jamais une erreur. */
export async function lireProjets(c: CheminsEspace): Promise<ProjetLu[]> {
  let entrees;
  try {
    entrees = await readdir(c.projets, { withFileTypes: true });
  } catch {
    return [];
  }
  const dossiers = entrees
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
  return Promise.all(dossiers.map((d) => lireProjet(c, d)));
}

/** Appelle `rappel` après chaque rafale de changements des projets. Renvoie la fonction d'arrêt. */
export function surveillerProjets(c: CheminsEspace, rappel: () => void): () => Promise<void> {
  mkdirSync(c.projets, { recursive: true });
  let minuterie: NodeJS.Timeout | undefined;
  const observateur = watch(c.projets, {
    ignoreInitial: true,
    depth: 1,
    ignored: (p) => p.split(/[\\/]/).includes("node_modules") || p.endsWith(".tmp"),
  });
  observateur.on("all", (evenement, chemin) => {
    const nom = chemin.split(/[\\/]/).pop();
    const pertinent = evenement === "addDir" || evenement === "unlinkDir" || nom === "webaios.json";
    if (!pertinent) return;
    clearTimeout(minuterie);
    minuterie = setTimeout(rappel, REGROUPEMENT_MS);
  });
  return async () => {
    clearTimeout(minuterie);
    await observateur.close();
  };
}

/** Change le type d'un projet en gardant les autres champs du manifeste. */
export async function ecrireType(c: CheminsEspace, dossier: string, type: "application" | "poc"): Promise<void> {
  const cible = join(c.projets, dossier, "webaios.json");
  const manifeste = Manifeste.parse(JSON.parse(await readFile(cible, "utf8")));
  const temporaire = `${cible}.${process.pid}.tmp`;
  await writeFile(temporaire, JSON.stringify({ ...manifeste, type }, null, 2));
  await rename(temporaire, cible);
}
