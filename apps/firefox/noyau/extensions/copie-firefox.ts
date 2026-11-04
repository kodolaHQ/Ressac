import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { GECKO_ID, VERSION_QUATRE } from "./amo";

export const SUFFIXE_ID = "@agent.webaios";
export const addonIdDe = (dossier: string) => `${dossier}${SUFFIXE_ID}`;

const GARDE_FOND = "webaios-garde-fond.js";
const FOND = "webaios-fond.js";
const PAGE_GENEREE = "_generated_background_page.html";

const objet = (v: unknown): Record<string, any> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : undefined);

/** Refusals preparerCopie does not make (GECKO_ID, VERSION_QUATRE, a file named _generated_background_page.html). */
export function refusFirefox(manifeste: Record<string, unknown>, fichiers: readonly string[]): string[] {
  const refus: string[] = [];
  const gecko = objet(objet(manifeste.browser_specific_settings)?.gecko) ?? objet(objet(manifeste.applications)?.gecko);
  if (gecko && "id" in gecko) refus.push(GECKO_ID);
  if (typeof manifeste.version === "string" && manifeste.version.split(".").length > 3) refus.push(VERSION_QUATRE);
  // Same text as preparerCopie's reserved names (packages/noyau/src/extensions/copie.ts); the guard finds the background by this name.
  if (fichiers.includes(PAGE_GENEREE)) refus.push(`Nom de fichier réservé à WebAiOs : ${PAGE_GENEREE}`);
  return refus;
}

/**
 * The copy's manifest for Firefox (decisions 2, 3): gecko id, background.scripts, version `<a>.<b>.<c>.<n>`. Pure.
 * `m` is preparerCopie's manifest; `fondOriginal` (required, so a forgotten argument cannot drop the background) is the agent's `background.service_worker` (only the generated
 * webaios-fond.js knows it after the copy), used for a classic background.
 */
export function manifesteFirefox(m: Record<string, unknown>, dossier: string, n: number, fondOriginal: string | undefined): Record<string, unknown> {
  const fond = objet(m.background);
  const nombres = String(m.version ?? "").split(".");
  const version = [0, 1, 2].map((i) => nombres[i] || "0").concat(String(n)).join(".");
  const bss = objet(m.browser_specific_settings) ?? {};
  const copie: Record<string, unknown> = {
    ...m,
    version,
    browser_specific_settings: { ...bss, gecko: { ...bss.gecko, id: addonIdDe(dossier), data_collection_permissions: { required: ["none"] } } },
  };
  if (fond?.service_worker === FOND && fond.type === "module") copie.background = { scripts: [FOND], type: "module" };
  else if (fond?.service_worker === FOND && fondOriginal) copie.background = { scripts: [GARDE_FOND, fondOriginal.replace(/^(\.\/|\/)+/, "")] };
  else copie.background = { scripts: [GARDE_FOND] };
  return copie;
}

let file: Promise<unknown> = Promise.resolve();

/** amo-versions.json in `dossier`: the counter of `id` + 1, written (atomic rename) before it is returned; never lowered nor cleared. */
export function prochaineVersion(dossier: string, id: string): Promise<number> {
  const suite = file.then(async () => {
    const fichier = path.join(dossier, "amo-versions.json");
    let compteurs: Record<string, number> = {};
    // An unreadable file throws: starting over would reuse numbers AMO already took.
    try {
      compteurs = JSON.parse(await readFile(fichier, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const n = (compteurs[id] ?? 0) + 1;
    await mkdir(dossier, { recursive: true });
    const tmp = `${fichier}.tmp`;
    await writeFile(tmp, JSON.stringify({ ...compteurs, [id]: n }));
    await rename(tmp, fichier);
    return n;
  });
  file = suite.catch(() => {});
  return suite;
}

/** `zip -qrX` of the copy (like e2e/addons.ts), manifest first. */
export async function zipper(copie: string, xpi: string): Promise<void> {
  await rm(xpi, { force: true });
  await promisify(execFile)("zip", ["-qrX", xpi, "manifest.json", "."], { cwd: copie });
}
