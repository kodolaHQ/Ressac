import fs from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { EtatNavigateur } from "../../commun/modele";
import { etatInitial } from "./etat-initial";

const FICHIER = "session.json";

const SchemaFavori = z.object({ id: z.string(), url: z.string(), titre: z.string(), favicon: z.string().nullable() });

const SchemaSession = z
  .object({
    version: z.literal(1),
    espaces: z.array(z.object({ id: z.string(), nom: z.string(), icone: z.string(), epingles: z.array(SchemaFavori) })).min(1),
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
        }),
      )
      .min(1),
    reglages: z.object({ moteur: z.enum(["google", "duckduckgo", "qwant"]) }),
  });

/** Les champs volatils d'un onglet ne sont pas enregistrés : ils repartent de leur valeur par défaut. */
const VOLATILS = { chargement: false, peutReculer: false, peutAvancer: false, plante: false };

export async function chargerSession(dossier: string): Promise<EtatNavigateur> {
  const chemin = join(dossier, FICHIER);
  let texte: string;
  try {
    texte = await fs.readFile(chemin, "utf8");
  } catch {
    return etatInitial();
  }
  try {
    const lu = SchemaSession.parse(JSON.parse(texte));
    return {
      ...lu,
      onglets: Object.fromEntries(Object.entries(lu.onglets).map(([id, o]) => [id, { ...o, ...VOLATILS }])),
    };
  } catch {
    // On garde le fichier illisible de côté plutôt que de l'écraser au prochain enregistrement.
    await fs.writeFile(`${chemin}.corrompu`, texte);
    return etatInitial();
  }
}

/** Enregistre la session au plus une fois par `delaiMs`, de façon atomique (fichier temporaire + rename). */
export class EnregistreurSession {
  private enAttente: EtatNavigateur | null = null;
  private minuterie: NodeJS.Timeout | undefined;

  constructor(
    private readonly dossier: string,
    private readonly delaiMs = 500,
  ) {}

  planifier(etat: EtatNavigateur): void {
    this.enAttente = etat;
    this.minuterie ??= setTimeout(() => void this.vider(), this.delaiMs);
  }

  async vider(): Promise<void> {
    clearTimeout(this.minuterie);
    this.minuterie = undefined;
    const etat = this.enAttente;
    if (!etat) return;
    this.enAttente = null;
    const onglets = Object.fromEntries(
      Object.entries(etat.onglets).map(([id, { chargement, peutReculer, peutAvancer, plante, ...reste }]) => [id, reste]),
    );
    const cible = join(this.dossier, FICHIER);
    const temporaire = `${cible}.${process.pid}.tmp`;
    await fs.mkdir(this.dossier, { recursive: true });
    await fs.writeFile(temporaire, JSON.stringify({ ...etat, onglets }, null, 2));
    await fs.rename(temporaire, cible);
  }
}
