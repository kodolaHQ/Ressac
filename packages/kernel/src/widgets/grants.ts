import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * The user's grant for a widget to read with its account: the `compte` and `publiques` domains of the declaration at the
 * time of the grant, and the chosen login profile. Stored in `<dossierWidgets>/accords.json` (`<dossierActions>/accords.json` for the actions), outside the workspace.
 */
export const Grant = z.object({
  domains: z.array(z.string()),
  public: z.array(z.string()),
  profile: z.string().min(1),
});
export type Grant = z.infer<typeof Grant>;

const ID = /^[a-z0-9-]+$/;
const file = (widgetsFolder: string) => join(widgetsFolder, "accords.json");

function checkId(id: string): void {
  if (!ID.test(id)) throw new Error(`id de widget invalide : ${id}`);
}

/** The file's valid grants; an absent or damaged file counts as no grant. */
export async function readGrants(widgetsFolder: string): Promise<Record<string, Grant>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file(widgetsFolder), "utf8"));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const grants: Record<string, Grant> = {};
  for (const [id, value] of Object.entries(raw)) {
    const r = Grant.safeParse(value);
    if (ID.test(id) && r.success) grants[id] = r.data;
  }
  return grants;
}

/** One write at a time per folder: two simultaneous grants do not erase each other. */
const files = new Map<string, Promise<unknown>>();

function modify(widgetsFolder: string, change: (a: Record<string, Grant>) => void): Promise<void> {
  const previous = files.get(widgetsFolder) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const grants = await readGrants(widgetsFolder);
    change(grants);
    await mkdir(widgetsFolder, { recursive: true });
    const temp = `${file(widgetsFolder)}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(grants, null, 2));
      await rename(temp, file(widgetsFolder));
    } finally {
      await rm(temp, { force: true });
    }
  });
  files.set(widgetsFolder, next);
  void next.finally(() => {
    if (files.get(widgetsFolder) === next) files.delete(widgetsFolder);
  }).catch(() => {});
  return next;
}

export async function giveGrant(widgetsFolder: string, id: string, grant: Grant): Promise<void> {
  checkId(id);
  const a = Grant.parse(grant);
  return modify(widgetsFolder, (grants) => {
    grants[id] = { domains: [...a.domains], public: [...a.public], profile: a.profile };
  });
}

export async function removeGrant(widgetsFolder: string, id: string): Promise<void> {
  checkId(id);
  return modify(widgetsFolder, (grants) => {
    delete grants[id];
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
export function grantValid(declaration: { sources: { account: string[]; public: string[] } }, grant?: Grant): grant is Grant {
  if (!grant) return false;
  return same(declaration.sources.account, grant.domains) && same(declaration.sources.public, grant.public);
}
