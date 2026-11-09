import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeAtomic } from "../workflows/executions.js";
import { removeSiteGrant } from "./grants.js";
import { effectiveDomains, type UrlState } from "./urls.js";
import { ID_SITE, type DeclarationSite } from "./schemas.js";

export type { UrlState };

const State = z.object({
  current: z.string().min(1).max(253),
  previous: z.array(z.string().max(253)).max(100),
  since: z.string().nullable(),
});

function checkId(id: string): void {
  if (!ID_SITE.test(id)) throw new Error(`id d'appli de site invalide : ${id}`);
}

const urlFile = (sitesFolder: string, id: string) => join(sitesFolder, id, "adresse.json");

/** `<dossierSites>/<id>/adresse.json`; absent or damaged: null (the site keeps its declared domains). */
export async function readUrlState(sitesFolder: string, id: string): Promise<UrlState | null> {
  checkId(id);
  try {
    const r = State.safeParse(JSON.parse(await readFile(urlFile(sitesFolder, id), "utf8")));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

const OLD_MAX = 100;
const files = new Map<string, Promise<unknown>>();

/** One operation at a time per app (address change, deletion). */
function queued<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = files.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  files.set(key, next);
  void next.finally(() => {
    if (files.get(key) === next) files.delete(key);
  }).catch(() => {});
  return next;
}

/**
 * The site changed domain: `nouveau` becomes the current one, the old current one (failing that the host of the declared address)
 * joins the old ones without duplicates. The writes of a same site go one after the other.
 */
export function changeUrl(sitesFolder: string, id: string, d: DeclarationSite, fresh: string): Promise<UrlState> {
  checkId(id);
  const key = urlFile(sitesFolder, id);
  return queued(join(sitesFolder, id), async () => {
    const [clean] = effectiveDomains({ ...d, domains: [] }, { current: fresh, previous: [], since: null });
    if (!clean) throw new Error(`domaine invalide : ${fresh}`);
    const currentUrl = await readUrlState(sitesFolder, id);
    let before: string;
    try {
      before = new URL(d.url).hostname.toLowerCase().replace(/\.+$/, "");
    } catch {
      before = d.domains[0] ?? "";
    }
    const current = currentUrl?.current ?? before;
    const old = currentUrl?.previous ?? [];
    if (clean === current) return currentUrl ?? { current: current, previous: old, since: null };
    const state: UrlState = {
      current: clean,
      previous: [...new Set([...old, current])].filter((x) => x && x !== clean).slice(-OLD_MAX),
      since: new Date().toISOString(),
    };
    await writeAtomic(key, JSON.stringify(state, null, 2));
    return state;
  });
}

/** Forgets what WebAiOs keeps about an app: memory, address (under `<profil>/sites/<id>/`) and grant. */
export async function deleteSiteData(profile: string, id: string): Promise<void> {
  checkId(id);
  const sitesFolder = join(profile, "sites");
  await queued(join(sitesFolder, id), () => rm(join(sitesFolder, id), { recursive: true, force: true }));
  await removeSiteGrant(profile, id);
}
