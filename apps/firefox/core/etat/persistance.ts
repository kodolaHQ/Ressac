import fs from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { PROFIL_DEFAUT, type EtatNavigateur } from "../../shared/modele";
import { etatInitial } from "./etat-initial";

const FICHIER = "session.json";

const SchemaFavori = z.object({ id: z.string(), url: z.string(), titre: z.string(), favicon: z.string().nullable() });

const SchemaEspaceV1 = z.object({ id: z.string(), nom: z.string(), icone: z.string(), epingles: z.array(SchemaFavori) });

/** The fields common to versions 1 and 2. */
const SchemaCommun = z
  .object({
    essentiels: z.array(SchemaFavori),
    onglets: z.record(
      z.string(),
      z.object({
        id: z.string(),
        fenetreId: z.string(),
        espaceId: z.string(),
        url: z.string(),
        titre: z.string(),
        favicon: z.string().nullable(),
        lien: z.object({ type: z.enum(["essentiel", "epingle"]), id: z.string() }).nullable(),
        ouvertParAgent: z.boolean(),
        zoom: z.number(),
      }),
    ),
    fenetres: z
      .array(
        z.object({
          id: z.string(),
          espaceActif: z.string(),
          ordre: z.record(z.string(), z.array(z.string())),
          actif: z.record(z.string(), z.string().nullable()),
          compact: z.boolean(),
          panneauAgentOuvert: z.boolean(),
          fermesRecemment: z.array(z.object({ url: z.string(), espaceId: z.string() })),
          cadre: z.object({ x: z.number(), y: z.number(), largeur: z.number(), hauteur: z.number() }).nullable().default(null),
        }),
      )
      .min(1),
    reglages: z.object({ moteur: z.enum(["google", "duckduckgo", "qwant"]), profilAgent: z.string().min(1).default("claude"),
      largeurPanneauAgent: z.number().default(420),
    }),
  });

/** Version 1: before private spaces and login profiles. */
const SchemaV1 = SchemaCommun.extend({ version: z.literal(1), espaces: z.array(SchemaEspaceV1).min(1) });
const SchemaV2 = SchemaCommun.extend({
  version: z.literal(2),
  espaces: z.array(SchemaEspaceV1.extend({ prive: z.boolean(), profil: z.string().min(1) })).min(1),
  profils: z.array(z.object({ id: z.string().min(1) })),
});
const SchemaSession = z.discriminatedUnion("version", [SchemaV1, SchemaV2]);

/** Reads a saved session, whatever its version, as version 2. */
function enV2(lu: z.infer<typeof SchemaSession>): z.infer<typeof SchemaV2> {
  if (lu.version === 2) {
    // A login profile used by a space is always listed: otherwise it would be taken for a profile to erase.
    const manquants = [...new Set(lu.espaces.map((e) => e.profil))].filter((id) => !lu.profils.some((p) => p.id === id));
    return manquants.length ? { ...lu, profils: [...lu.profils, ...manquants.map((id) => ({ id }))] } : lu;
  }
  // The earlier spaces stay visible to the agent, on the always-used partition: no login is lost.
  return { ...lu, version: 2, espaces: lu.espaces.map((e) => ({ ...e, prive: false, profil: PROFIL_DEFAUT })), profils: [{ id: PROFIL_DEFAUT }] };
}

/** A tab's volatile fields are not saved: they restart from their default value. */
const VOLATILS = { chargement: false, peutReculer: false, peutAvancer: false, plante: false, erreur: null };

/** Sets the session file aside under a unique name: the next save will not overwrite it. Returns that name. */
async function mettreDeCote(chemin: string, raison: "corrompu" | "illisible"): Promise<string | null> {
  const horodatage = new Date().toISOString().replace(/[:.]/g, "-");
  for (let i = 0; ; i++) {
    const nom = `${chemin}.${horodatage}${i ? `-${i}` : ""}.${raison}`;
    try {
      await fs.access(nom);
    } catch {
      return fs.rename(chemin, nom).then(
        () => nom,
        (e) => (console.error(`[session] impossible de garder ${chemin} de côté :`, e), null),
      );
    }
  }
}

/** `garde` receives the name under which an unreadable session was set aside, to tell the user. */
export async function chargerSession(dossier: string, garde?: (chemin: string) => void): Promise<EtatNavigateur> {
  const chemin = join(dossier, FICHIER);
  let texte: string;
  try {
    texte = await fs.readFile(chemin, "utf8");
  } catch (e) {
    // Absent: first launch. Otherwise (permissions…), keep it rather than overwrite it at the next save.
    const nom = (e as NodeJS.ErrnoException).code !== "ENOENT" && (await mettreDeCote(chemin, "illisible"));
    if (nom) garde?.(nom);
    return etatInitial();
  }
  try {
    const lu = enV2(SchemaSession.parse(JSON.parse(texte)));
    return {
      ...lu,
      onglets: Object.fromEntries(Object.entries(lu.onglets).map(([id, o]) => [id, { ...o, ...VOLATILS }])),
    };
  } catch {
    const nom = await mettreDeCote(chemin, "corrompu");
    if (nom) garde?.(nom);
    return etatInitial();
  }
}

/** Saves the session at most once per `delaiMs`, atomically (temporary file + rename). */
export class EnregistreurSession {
  private enAttente: EtatNavigateur | null = null;
  private minuterie: NodeJS.Timeout | undefined;
  /** Chained writes, never simultaneous. */
  private ecriture: Promise<void> = Promise.resolve();
  private numero = 0;

  constructor(
    private readonly dossier: string,
    private readonly delaiMs = 500,
  ) {}

  planifier(etat: EtatNavigateur): void {
    this.enAttente = etat;
    this.minuterie ??= setTimeout(() => void this.vider(), this.delaiMs);
  }

  /** Writes the pending state; always waits for the end of the writes in progress (the app's exit depends on it). */
  vider(): Promise<void> {
    clearTimeout(this.minuterie);
    this.minuterie = undefined;
    const etat = this.enAttente;
    this.enAttente = null;
    if (etat) {
      this.ecriture = this.ecriture
        .then(() => this.ecrire(etat))
        .catch((e) => {
          console.error("[session] écriture impossible :", e);
          // Retried at the next write or at exit, unless a more recent state is already there.
          this.enAttente ??= etat;
        });
    }
    return this.ecriture;
  }

  private async ecrire(etat: EtatNavigateur): Promise<void> {
    const onglets = Object.fromEntries(
      Object.entries(etat.onglets).map(([id, { chargement, peutReculer, peutAvancer, plante, erreur, ...reste }]) => [id, reste]),
    );
    const cible = join(this.dossier, FICHIER);
    const temporaire = `${cible}.${process.pid}.${++this.numero}.tmp`;
    await fs.mkdir(this.dossier, { recursive: true });
    try {
      const fichier = await fs.open(temporaire, "w");
      try {
        await fichier.writeFile(JSON.stringify({ ...etat, onglets }, null, 2));
        await fichier.sync(); // on disk before the rename: a power cut does not leave an empty file
      } finally {
        await fichier.close();
      }
      await fs.rename(temporaire, cible);
    } catch (e) {
      await fs.rm(temporaire, { force: true });
      throw e;
    }
  }
}
