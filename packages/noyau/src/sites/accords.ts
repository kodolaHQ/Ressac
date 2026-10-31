import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ecrireAtomique } from "../workflows/executions.js";
import { ID_SITE, type DeclarationSite } from "./schemas.js";

/**
 * Ce que l'utilisateur a autorisé pour les retouches d'une appli de site : les domaines, les domaines de connexion, les motifs
 * de cadres et la reprise des vidéos au moment de l'accord. Changer `correspond` ou le code ne redemande rien.
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

/** Au moins une retouche, ou la reprise des vidéos. */
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

/** L'accord couvre la déclaration si elle ne demande rien de plus que ce qui a été accordé. */
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

/** Sans prototype : un id comme « constructor » ou « __proto__ » n'a pas d'accord et ne lève rien. */
async function lire(profil: string, strict: boolean): Promise<Record<string, DroitsSite>> {
  const accords: Record<string, DroitsSite> = Object.create(null);
  let brut: unknown;
  try {
    brut = JSON.parse(await readFile(fichierAccordsSites(profil), "utf8"));
  } catch (e) {
    // absent ou abîmé : aucun accord ; toute autre panne (EMFILE, EACCES…) fait échouer une écriture
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

/** Les accords valides ; un fichier absent ou abîmé vaut aucun accord. */
export const lireAccordsSites = (profil: string): Promise<Record<string, DroitsSite>> => lire(profil, false);

/** Une écriture à la fois par fichier : deux accords simultanés ne s'effacent pas. */
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
