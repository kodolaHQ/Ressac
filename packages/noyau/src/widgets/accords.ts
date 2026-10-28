import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { DeclarationWidget } from "../accueil/schemas.js";

/**
 * Accord de l'utilisateur pour qu'un widget lise avec son compte : les domaines `compte` et `publiques` de la déclaration au
 * moment de l'accord, et le profil de connexion choisi. Rangé dans `<dossierWidgets>/accords.json`, hors de l'espace.
 */
export const Accord = z.object({
  domaines: z.array(z.string()),
  publiques: z.array(z.string()),
  profil: z.string().min(1),
});
export type Accord = z.infer<typeof Accord>;

const ID = /^[a-z0-9-]+$/;
const fichier = (dossierWidgets: string) => join(dossierWidgets, "accords.json");

function verifierId(id: string): void {
  if (!ID.test(id)) throw new Error(`id de widget invalide : ${id}`);
}

/** Les accords valides du fichier ; un fichier absent ou abîmé vaut aucun accord. */
export async function lireAccords(dossierWidgets: string): Promise<Record<string, Accord>> {
  let brut: unknown;
  try {
    brut = JSON.parse(await readFile(fichier(dossierWidgets), "utf8"));
  } catch {
    return {};
  }
  if (!brut || typeof brut !== "object" || Array.isArray(brut)) return {};
  const accords: Record<string, Accord> = {};
  for (const [id, valeur] of Object.entries(brut)) {
    const r = Accord.safeParse(valeur);
    if (ID.test(id) && r.success) accords[id] = r.data;
  }
  return accords;
}

/** Une écriture à la fois par dossier : deux accords simultanés ne s'effacent pas. */
const files = new Map<string, Promise<unknown>>();

function modifier(dossierWidgets: string, changer: (a: Record<string, Accord>) => void): Promise<void> {
  const precedente = files.get(dossierWidgets) ?? Promise.resolve();
  const suivante = precedente.catch(() => {}).then(async () => {
    const accords = await lireAccords(dossierWidgets);
    changer(accords);
    await mkdir(dossierWidgets, { recursive: true });
    const temporaire = `${fichier(dossierWidgets)}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaire, JSON.stringify(accords, null, 2));
      await rename(temporaire, fichier(dossierWidgets));
    } finally {
      await rm(temporaire, { force: true });
    }
  });
  files.set(dossierWidgets, suivante);
  void suivante.finally(() => {
    if (files.get(dossierWidgets) === suivante) files.delete(dossierWidgets);
  }).catch(() => {});
  return suivante;
}

export async function accorder(dossierWidgets: string, id: string, accord: Accord): Promise<void> {
  verifierId(id);
  const a = Accord.parse(accord);
  return modifier(dossierWidgets, (accords) => {
    accords[id] = { domaines: [...a.domaines], publiques: [...a.publiques], profil: a.profil };
  });
}

export async function retirerAccord(dossierWidgets: string, id: string): Promise<void> {
  verifierId(id);
  return modifier(dossierWidgets, (accords) => {
    delete accords[id];
  });
}

const memes = (a: string[], b: string[]) => {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/** L'accord vaut tant que la déclaration annonce exactement les mêmes domaines (`compte` et `publiques`). */
export function accordValide(declaration: DeclarationWidget, accord?: Accord): accord is Accord {
  if (!accord) return false;
  return memes(declaration.sources.compte, accord.domaines) && memes(declaration.sources.publiques, accord.publiques);
}
