import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ecrireAtomique } from "../workflows/executions.js";
import { ID_SITE, type DeclarationSite } from "./schemas.js";

/**
 * What the user authorized for the tweaks of a site app: the domains, the login domains, the frame
 * patterns and the video resume at the time of the grant. Changing `correspond` or the code asks for nothing again.
 */
export const DroitsSite = z.object({
  domaines: z.array(z.string()),
  connexion: z.array(z.string()),
  cadres: z.array(z.string()),
  reprise: z.boolean(),
});
export type DroitsSite = z.infer<typeof DroitsSite>;

export const fichierAccordsSites = (profil: string) => join(profil, "sites-accords.json");

function verifierId(id: string): void {
  if (!ID_SITE.test(id)) throw new Error(`id d'appli de site invalide : ${id}`);
}

const unique = (l: string[]) => [...new Set(l)];

/**
 * The hash of what the « L'agent veut voir l'appli de site » card commits to: its name, its domains and its login
 * domains (sha256 of a canonical JSON: lowercase domains, no duplicates, sorted). The agent's read grant
 * is only valid for this hash: site.json rewritten with another name or other domains asks for the card again.
 */
export function empreinteLectureSite(d: DeclarationSite): string {
  const canon = (l: string[]) => unique(l.map((x) => x.toLowerCase())).sort();
  return createHash("sha256").update(JSON.stringify({ nom: d.nom, domaines: canon(d.domaines), connexion: canon(d.connexion) })).digest("hex");
}

/**
 * The hash of an app's domains, for the Store extensions enabled in its session: its domains and its
 * login domains (sha256 of a canonical JSON, lowercase, no duplicates, sorted). Neither the name, nor the tweaks, nor the
 * resume is part of it.
 */
export function empreinteExtensionsSite(d: DeclarationSite): string {
  const canon = (l: string[]) => unique(l.map((x) => x.toLowerCase())).sort();
  return createHash("sha256").update(JSON.stringify({ domaines: canon(d.domaines), connexion: canon(d.connexion) })).digest("hex");
}

/** At least one tweak, or the video resume. */
export function accordNecessaire(d: DeclarationSite): boolean {
  return d.retouches.length > 0 || d.reprise;
}

export function droitsDe(d: DeclarationSite): DroitsSite {
  return {
    domaines: unique(d.domaines.map((x) => x.toLowerCase())),
    connexion: unique(d.connexion.map((x) => x.toLowerCase())),
    cadres: unique(d.retouches.flatMap((r) => (r.cadres === false ? [] : r.cadres))),
    reprise: d.reprise,
  };
}

/** The grant covers the declaration if it asks for nothing more than what was granted. */
export function accordCouvre(a: DroitsSite | null, d: DeclarationSite): boolean {
  if (!a) return false;
  const voulu = droitsDe(d);
  const dans = (x: string[], y: string[]) => x.every((v) => y.includes(v));
  const accorde = {
    domaines: a.domaines.map((x) => x.toLowerCase()),
    connexion: a.connexion.map((x) => x.toLowerCase()),
    cadres: a.cadres,
  };
  return (
    dans(voulu.domaines, accorde.domaines) &&
    dans(voulu.connexion, accorde.connexion) &&
    dans(voulu.cadres, accorde.cadres) &&
    (!voulu.reprise || a.reprise)
  );
}

/** Without a prototype: an id like « constructor » or « __proto__ » has no grant and throws nothing. */
async function lire(profil: string, strict: boolean): Promise<Record<string, DroitsSite>> {
  const accords: Record<string, DroitsSite> = Object.create(null);
  let brut: unknown;
  try {
    brut = JSON.parse(await readFile(fichierAccordsSites(profil), "utf8"));
  } catch (e) {
    // absent or damaged: no grant; any other failure (EMFILE, EACCES…) makes a write fail
    if (strict && !(e instanceof SyntaxError) && (e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return accords;
  }
  if (!brut || typeof brut !== "object" || Array.isArray(brut)) return accords;
  for (const [id, valeur] of Object.entries(brut)) {
    const r = DroitsSite.safeParse(valeur);
    if (ID_SITE.test(id) && r.success) accords[id] = r.data;
  }
  return accords;
}

/** The valid grants; an absent or damaged file counts as no grant. */
export const lireAccordsSites = (profil: string): Promise<Record<string, DroitsSite>> => lire(profil, false);

/** One write at a time per file: two simultaneous grants do not erase each other. */
const files = new Map<string, Promise<unknown>>();

function modifier(profil: string, changer: (a: Record<string, DroitsSite>) => void): Promise<void> {
  const cle = fichierAccordsSites(profil);
  const precedente = files.get(cle) ?? Promise.resolve();
  const suivante = precedente.catch(() => {}).then(async () => {
    const accords = await lire(profil, true);
    changer(accords);
    await ecrireAtomique(cle, JSON.stringify({ ...accords }, null, 2));
  });
  files.set(cle, suivante);
  void suivante.finally(() => {
    if (files.get(cle) === suivante) files.delete(cle);
  }).catch(() => {});
  return suivante;
}

export async function accorderSite(profil: string, id: string, d: DeclarationSite): Promise<void> {
  verifierId(id);
  const droits = droitsDe(d);
  return modifier(profil, (accords) => {
    accords[id] = droits;
  });
}

export async function retirerAccordSite(profil: string, id: string): Promise<void> {
  verifierId(id);
  return modifier(profil, (accords) => {
    delete accords[id];
  });
}
