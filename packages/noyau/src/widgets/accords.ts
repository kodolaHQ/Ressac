import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * The user's grant for a widget to read with its account: the `compte` and `publiques` domains of the declaration at the
 * time of the grant, and the chosen login profile. Stored in `<dossierWidgets>/accords.json` (`<dossierActions>/accords.json` for the actions), outside the workspace.
 */
export const Accord = z.object({
  domaines: z.array(z.string()),
  publiques: z.array(z.string()),
  profil: z.string().min(1),
});
export type Accord = z.infer<typeof Accord>;

const ID = /^[a-z0-9-]+$/;
const file = (dossierWidgets: string) => join(dossierWidgets, "accords.json");

function verifierId(id: string): void {
  if (!ID.test(id)) throw new Error(`id de widget invalide : ${id}`);
}

/** The file's valid grants; an absent or damaged file counts as no grant. */
export async function lireAccords(dossierWidgets: string): Promise<Record<string, Accord>> {
  let brut: unknown;
  try {
    brut = JSON.parse(await readFile(file(dossierWidgets), "utf8"));
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

/** One write at a time per folder: two simultaneous grants do not erase each other. */
const files = new Map<string, Promise<unknown>>();

function modifier(dossierWidgets: string, changer: (a: Record<string, Accord>) => void): Promise<void> {
  const previous = files.get(dossierWidgets) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const accords = await lireAccords(dossierWidgets);
    changer(accords);
    await mkdir(dossierWidgets, { recursive: true });
    const temp = `${file(dossierWidgets)}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(accords, null, 2));
      await rename(temp, file(dossierWidgets));
    } finally {
      await rm(temp, { force: true });
    }
  });
  files.set(dossierWidgets, next);
  void next.finally(() => {
    if (files.get(dossierWidgets) === next) files.delete(dossierWidgets);
  }).catch(() => {});
  return next;
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

const same = (a: string[], b: string[]) => {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/**
 * The grant holds as long as the declaration (of a widget or an action) announces exactly the same domains
 * (`compte` and `publiques`).
 */
export function grantValid(declaration: { sources: { compte: string[]; publiques: string[] } }, accord?: Accord): accord is Accord {
  if (!accord) return false;
  return same(declaration.sources.compte, accord.domaines) && same(declaration.sources.publiques, accord.publiques);
}
