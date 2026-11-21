import { mkdirSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { watch } from "chokidar";
import { z } from "zod";
import type { SpacePaths } from "../paths.js";
import { LEGACY_MANIFEST_FILE, MANIFEST_FILE } from "../manifest-file.js";
import { inFolder, readFiles, writeEntries } from "../workspace/confined.js";

const GROUPING_MS = 150;
const FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MANIFEST_MAX = 64 * 1024;
const NAMES = [MANIFEST_FILE, LEGACY_MANIFEST_FILE];

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
    name: z.string().optional(),
    type: z.enum(["app", "poc"]),
    launch: z.string().min(1),
    origin: urlWeb.optional(),
  })
  .passthrough();
export type Manifest = z.infer<typeof Manifest>;

export type ProjectRead = { folder: string; path: string; createdAt: string; name: string } & (
  | { manifest: Manifest }
  | { noManifest: string }
);

/** A folder is launched only if its name passes in a shell command without quotes. */
export function validFolder(folder: string): boolean {
  return FOLDER_NAME.test(folder);
}

type Found = { name: string; text: string; mtime: number } | undefined;

/** The projects folder's walk from the space root, for the confined child. */
const projectsWalk = (c: SpacePaths) => relative(c.root, c.projects).split(sep);

/**
 * The manifest of each of `folders` (ressac.json first), read by a child that never follows a link the agent put in
 * place of a folder or a file: a link, a device or a file over 64 KB counts as absent.
 */
async function readManifests(c: SpacePaths, folders: string[]): Promise<Found[]> {
  const paths = folders.flatMap((f) => NAMES.map((n) => `${f}/${n}`));
  const r = await inFolder(c.root, projectsWalk(c), readFiles, [paths, MANIFEST_MAX, 8 * 1024 * 1024, true]);
  const files = r && "files" in r ? r.files : [];
  return folders.map((_, i) => {
    for (const [k, name] of NAMES.entries()) {
      const f = files[i * NAMES.length + k];
      if (f) return { name, ...f };
    }
    return undefined;
  });
}

async function readProject(c: SpacePaths, folder: string, found: Found): Promise<ProjectRead> {
  const path = join(c.projects, folder);
  const createdAt = found ? new Date(found.mtime) : (await lstat(path)).mtime;
  const base = { folder: folder, path: path, createdAt: createdAt.toISOString() };
  if (!validFolder(folder)) return { ...base, name: folder, noManifest: "nom de dossier non pris en charge" };
  if (!found) return { ...base, name: folder, noManifest: `pas de ${MANIFEST_FILE}` };
  try {
    const manifest = Manifest.parse(JSON.parse(found.text));
    return { ...base, name: manifest.name ?? folder, manifest: manifest };
  } catch (e) {
    return { ...base, name: folder, noManifest: `${found.name} invalide : ${(e as Error).message}` };
  }
}

/** Lists the projects. A missing or broken manifest gives a project « sans fiche », never an error. */
export async function readProjects(c: SpacePaths): Promise<ProjectRead[]> {
  let entries;
  try {
    entries = await readdir(c.projects, { withFileTypes: true });
  } catch {
    return [];
  }
  const folders = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
  const found = await readManifests(c, folders);
  return Promise.all(folders.map((d, i) => readProject(c, d, found[i])));
}

/** Calls `rappel` after each burst of changes of the projects. Returns the stop function. */
export function watchProjects(c: SpacePaths, callback: () => void): () => Promise<void> {
  mkdirSync(c.projects, { recursive: true });
  let timer: NodeJS.Timeout | undefined;
  const observer = watch(c.projects, {
    ignoreInitial: true,
    depth: 1,
    ignored: (p) => p.split(/[\\/]/).includes("node_modules") || p.endsWith(".tmp"),
  });
  // A project made while the first scan ran is in no event (ignoreInitial): one more read once the watch is ready.
  observer.on("ready", callback);
  observer.on("all", (event, path) => {
    const name = path.split(/[\\/]/).pop();
    const relevant = event === "addDir" || event === "unlinkDir" || (name === MANIFEST_FILE || name === LEGACY_MANIFEST_FILE);
    if (!relevant) return;
    clearTimeout(timer);
    timer = setTimeout(callback, GROUPING_MS);
  });
  return async () => {
    clearTimeout(timer);
    await observer.close();
  };
}

/** Changes a project's type, keeping the other fields of the manifest; read and written through the confined child. */
export async function writeType(c: SpacePaths, folder: string, type: "app" | "poc"): Promise<void> {
  if (!validFolder(folder)) throw new Error("nom de dossier non pris en charge");
  const [found] = await readManifests(c, [folder]);
  if (!found) throw new Error(`pas de ${MANIFEST_FILE}`);
  // The file read is the one rewritten: a webaios.json stays the project's only manifest.
  const manifest = Manifest.parse(JSON.parse(found.text));
  const data = Buffer.from(JSON.stringify({ ...manifest, type }, null, 2)).toString("base64");
  const r = await inFolder(c.root, [...projectsWalk(c), folder], writeEntries, [[[found.name, data]], []]);
  if (r !== "done") throw new Error(`${found.name} non écrit`);
}
