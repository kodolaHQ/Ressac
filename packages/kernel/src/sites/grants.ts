import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeAtomic } from "../workflows/executions.js";
import { ID_SITE, type DeclarationSite } from "./schemas.js";

/**
 * What the user authorized for the tweaks of a site app: the domains, the login domains, the frame
 * patterns and the video resume at the time of the grant. Changing `correspond` or the code asks for nothing again.
 */
export const SiteRights = z.object({
  domaines: z.array(z.string()),
  connexion: z.array(z.string()),
  cadres: z.array(z.string()),
  reprise: z.boolean(),
});
export type SiteRights = z.infer<typeof SiteRights>;

export const siteGrantsFile = (profile: string) => join(profile, "sites-accords.json");

function checkId(id: string): void {
  if (!ID_SITE.test(id)) throw new Error(`id d'appli de site invalide : ${id}`);
}

const unique = (l: string[]) => [...new Set(l)];

/**
 * The hash of what the « L'agent veut voir l'appli de site » card commits to: its name, its domains and its login
 * domains (sha256 of a canonical JSON: lowercase domains, no duplicates, sorted). The agent's read grant
 * is only valid for this hash: site.json rewritten with another name or other domains asks for the card again.
 */
export function siteReadHash(d: DeclarationSite): string {
  const canon = (l: string[]) => unique(l.map((x) => x.toLowerCase())).sort();
  return createHash("sha256").update(JSON.stringify({ nom: d.nom, domaines: canon(d.domaines), connexion: canon(d.connexion) })).digest("hex");
}

/**
 * The hash of an app's domains, for the Store extensions enabled in its session: its domains and its
 * login domains (sha256 of a canonical JSON, lowercase, no duplicates, sorted). Neither the name, nor the tweaks, nor the
 * resume is part of it.
 */
export function siteExtensionsHash(d: DeclarationSite): string {
  const canon = (l: string[]) => unique(l.map((x) => x.toLowerCase())).sort();
  return createHash("sha256").update(JSON.stringify({ domaines: canon(d.domaines), connexion: canon(d.connexion) })).digest("hex");
}

/** At least one tweak, or the video resume. */
export function grantNeeded(d: DeclarationSite): boolean {
  return d.retouches.length > 0 || d.reprise;
}

export function rightsOf(d: DeclarationSite): SiteRights {
  return {
    domaines: unique(d.domaines.map((x) => x.toLowerCase())),
    connexion: unique(d.connexion.map((x) => x.toLowerCase())),
    cadres: unique(d.retouches.flatMap((r) => (r.cadres === false ? [] : r.cadres))),
    reprise: d.reprise,
  };
}

/** The grant covers the declaration if it asks for nothing more than what was granted. */
export function grantCovers(a: SiteRights | null, d: DeclarationSite): boolean {
  if (!a) return false;
  const wanted = rightsOf(d);
  const inside = (x: string[], y: string[]) => x.every((v) => y.includes(v));
  const granted = {
    domaines: a.domaines.map((x) => x.toLowerCase()),
    connexion: a.connexion.map((x) => x.toLowerCase()),
    cadres: a.cadres,
  };
  return (
    inside(wanted.domaines, granted.domaines) &&
    inside(wanted.connexion, granted.connexion) &&
    inside(wanted.cadres, granted.cadres) &&
    (!wanted.reprise || a.reprise)
  );
}

/** Without a prototype: an id like « constructor » or « __proto__ » has no grant and throws nothing. */
async function read(profile: string, strict: boolean): Promise<Record<string, SiteRights>> {
  const grants: Record<string, SiteRights> = Object.create(null);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(siteGrantsFile(profile), "utf8"));
  } catch (e) {
    // absent or damaged: no grant; any other failure (EMFILE, EACCES…) makes a write fail
    if (strict && !(e instanceof SyntaxError) && (e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return grants;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return grants;
  for (const [id, value] of Object.entries(raw)) {
    const r = SiteRights.safeParse(value);
    if (ID_SITE.test(id) && r.success) grants[id] = r.data;
  }
  return grants;
}

/** The valid grants; an absent or damaged file counts as no grant. */
export const readSiteGrants = (profile: string): Promise<Record<string, SiteRights>> => read(profile, false);

/** One write at a time per file: two simultaneous grants do not erase each other. */
const files = new Map<string, Promise<unknown>>();

function modify(profile: string, change: (a: Record<string, SiteRights>) => void): Promise<void> {
  const key = siteGrantsFile(profile);
  const previous = files.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const grants = await read(profile, true);
    change(grants);
    await writeAtomic(key, JSON.stringify({ ...grants }, null, 2));
  });
  files.set(key, next);
  void next.finally(() => {
    if (files.get(key) === next) files.delete(key);
  }).catch(() => {});
  return next;
}

export async function storeSiteGrant(profile: string, id: string, d: DeclarationSite): Promise<void> {
  checkId(id);
  const rights = rightsOf(d);
  return modify(profile, (grants) => {
    grants[id] = rights;
  });
}

export async function removeSiteGrant(profile: string, id: string): Promise<void> {
  checkId(id);
  return modify(profile, (grants) => {
    delete grants[id];
  });
}
