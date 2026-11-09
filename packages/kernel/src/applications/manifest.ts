import { mkdirSync } from "node:fs";
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { watch } from "chokidar";
import { z } from "zod";
import type { SpacePaths } from "../paths.js";

const GROUPING_MS = 150;
const FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const urlWeb = z.string().refine((u) => {
  try {
    return ["http:", "https:"].includes(new URL(u).protocol);
  } catch {
    return false;
  }
}, "URL http(s) attendue");

/** Unknown fields are kept (`passthrough`) so the rewrite does not lose them. */
export const Manifest = z
  .object({
    nom: z.string().optional(),
    type: z.enum(["application", "poc"]),
    lancement: z.string().min(1),
    origine: urlWeb.optional(),
  })
  .passthrough();
export type Manifest = z.infer<typeof Manifest>;

export type ProjectRead = { dossier: string; chemin: string; creeLe: string; nom: string } & (
  | { manifeste: Manifest }
  | { sansFiche: string }
);

/** A folder is launched only if its name passes in a shell command without quotes. */
export function validFolder(dossier: string): boolean {
  return FOLDER_NAME.test(dossier);
}

async function readProject(c: SpacePaths, dossier: string): Promise<ProjectRead> {
  const path = join(c.projets, dossier);
  const file = join(path, "webaios.json");
  let creeLe: Date;
  let content: string | undefined;
  try {
    content = await readFile(file, "utf8");
    creeLe = (await stat(file)).mtime;
  } catch {
    creeLe = (await stat(path)).mtime;
  }
  const base = { dossier, chemin: path, creeLe: creeLe.toISOString() };
  if (!validFolder(dossier)) return { ...base, nom: dossier, sansFiche: "nom de dossier non pris en charge" };
  if (content === undefined) return { ...base, nom: dossier, sansFiche: "pas de webaios.json" };
  try {
    const manifest = Manifest.parse(JSON.parse(content));
    return { ...base, nom: manifest.nom ?? dossier, manifeste: manifest };
  } catch (e) {
    return { ...base, nom: dossier, sansFiche: `webaios.json invalide : ${(e as Error).message}` };
  }
}

/** Lists the projects. A missing or broken manifest gives a project « sans fiche », never an error. */
export async function readProjects(c: SpacePaths): Promise<ProjectRead[]> {
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
  return Promise.all(dossiers.map((d) => readProject(c, d)));
}

/** Calls `rappel` after each burst of changes of the projects. Returns the stop function. */
export function watchProjects(c: SpacePaths, rappel: () => void): () => Promise<void> {
  mkdirSync(c.projets, { recursive: true });
  let timer: NodeJS.Timeout | undefined;
  const observer = watch(c.projets, {
    ignoreInitial: true,
    depth: 1,
    ignored: (p) => p.split(/[\\/]/).includes("node_modules") || p.endsWith(".tmp"),
  });
  observer.on("all", (event, path) => {
    const name = path.split(/[\\/]/).pop();
    const pertinent = event === "addDir" || event === "unlinkDir" || name === "webaios.json";
    if (!pertinent) return;
    clearTimeout(timer);
    timer = setTimeout(rappel, GROUPING_MS);
  });
  return async () => {
    clearTimeout(timer);
    await observer.close();
  };
}

/** Changes a project's type, keeping the other fields of the manifest. */
export async function writeType(c: SpacePaths, dossier: string, type: "application" | "poc"): Promise<void> {
  const target = join(c.projets, dossier, "webaios.json");
  const manifest = Manifest.parse(JSON.parse(await readFile(target, "utf8")));
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify({ ...manifest, type }, null, 2));
  await rename(temp, target);
}
