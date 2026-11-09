import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeAtomic } from "../workflows/executions.js";
import { retirerAccordSite } from "./accords.js";
import { effectiveDomains, type UrlState } from "./adresses.js";
import { ID_SITE, type DeclarationSite } from "./schemas.js";

export type { UrlState };

const State = z.object({
  actuel: z.string().min(1).max(253),
  anciens: z.array(z.string().max(253)).max(100),
  depuis: z.string().nullable(),
});

function verifierId(id: string): void {
  if (!ID_SITE.test(id)) throw new Error(`id d'appli de site invalide : ${id}`);
}

const urlFile = (dossierSites: string, id: string) => join(dossierSites, id, "adresse.json");

/** `<dossierSites>/<id>/adresse.json`; absent or damaged: null (the site keeps its declared domains). */
export async function readUrlState(dossierSites: string, id: string): Promise<UrlState | null> {
  verifierId(id);
  try {
    const r = State.safeParse(JSON.parse(await readFile(urlFile(dossierSites, id), "utf8")));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

const OLD_MAX = 100;
const files = new Map<string, Promise<unknown>>();

/** One operation at a time per app (address change, deletion). */
function enFile<T>(key: string, travail: () => Promise<T>): Promise<T> {
  const previous = files.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(travail);
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
export function changeUrl(dossierSites: string, id: string, d: DeclarationSite, fresh: string): Promise<UrlState> {
  verifierId(id);
  const key = urlFile(dossierSites, id);
  return enFile(join(dossierSites, id), async () => {
    const [clean] = effectiveDomains({ ...d, domaines: [] }, { actuel: fresh, anciens: [], depuis: null });
    if (!clean) throw new Error(`domaine invalide : ${fresh}`);
    const courant = await readUrlState(dossierSites, id);
    let before: string;
    try {
      before = new URL(d.adresse).hostname.toLowerCase().replace(/\.+$/, "");
    } catch {
      before = d.domaines[0] ?? "";
    }
    const current = courant?.actuel ?? before;
    const old = courant?.anciens ?? [];
    if (clean === current) return courant ?? { actuel: current, anciens: old, depuis: null };
    const state: UrlState = {
      actuel: clean,
      anciens: [...new Set([...old, current])].filter((x) => x && x !== clean).slice(-OLD_MAX),
      depuis: new Date().toISOString(),
    };
    await writeAtomic(key, JSON.stringify(state, null, 2));
    return state;
  });
}

/** Forgets what WebAiOs keeps about an app: memory, address (under `<profil>/sites/<id>/`) and grant. */
export async function deleteSiteData(profile: string, id: string): Promise<void> {
  verifierId(id);
  const dossierSites = join(profile, "sites");
  await enFile(join(dossierSites, id), () => rm(join(dossierSites, id), { recursive: true, force: true }));
  await retirerAccordSite(profile, id);
}
