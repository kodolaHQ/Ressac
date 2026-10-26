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
          cadre: z.object({ x: z.number(), y: z.number(), largeur: z.number(), hauteur: z.number() }).nullable().default(null),
        }),
      )
      .min(1),
    reglages: z.object({ moteur: z.enum(["google", "duckduckgo", "qwant"]), profilAgent: z.string().min(1).default("claude"),
      largeurPanneauAgent: z.number().default(420),
    }),
  });

/** Les champs volatils d'un onglet ne sont pas enregistrés : ils repartent de leur valeur par défaut. */
const VOLATILS = { chargement: false, peutReculer: false, peutAvancer: false, plante: false, erreur: null };

/** Met le fichier de session de côté sous un nom unique : le prochain enregistrement ne l'écrasera pas. */
async function mettreDeCote(chemin: string, raison: "corrompu" | "illisible"): Promise<void> {
  const horodatage = new Date().toISOString().replace(/[:.]/g, "-");
  for (let i = 0; ; i++) {
    const nom = `${chemin}.${horodatage}${i ? `-${i}` : ""}.${raison}`;
    try {
      await fs.access(nom);
    } catch {
      await fs.rename(chemin, nom).catch((e) => console.error(`[session] impossible de garder ${chemin} de côté :`, e));
      return;
    }
  }
}

export async function chargerSession(dossier: string): Promise<EtatNavigateur> {
  const chemin = join(dossier, FICHIER);
  let texte: string;
  try {
    texte = await fs.readFile(chemin, "utf8");
  } catch (e) {
    // Absent : premier lancement. Sinon (droits…), on le garde plutôt que de l'écraser au prochain enregistrement.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") await mettreDeCote(chemin, "illisible");
    return etatInitial();
  }
  try {
    const lu = SchemaSession.parse(JSON.parse(texte));
    return {
      ...lu,
      onglets: Object.fromEntries(Object.entries(lu.onglets).map(([id, o]) => [id, { ...o, ...VOLATILS }])),
    };
  } catch {
    await mettreDeCote(chemin, "corrompu");
    return etatInitial();
  }
}

/** Enregistre la session au plus une fois par `delaiMs`, de façon atomique (fichier temporaire + rename). */
export class EnregistreurSession {
  private enAttente: EtatNavigateur | null = null;
  private minuterie: NodeJS.Timeout | undefined;
  /** Écritures enchaînées, jamais simultanées. */
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

  /** Écrit l'état en attente ; attend toujours la fin des écritures en cours (la sortie de l'app en dépend). */
  vider(): Promise<void> {
    clearTimeout(this.minuterie);
    this.minuterie = undefined;
    const etat = this.enAttente;
    this.enAttente = null;
    if (etat) this.ecriture = this.ecriture.then(() => this.ecrire(etat)).catch((e) => console.error("[session] écriture impossible :", e));
    return this.ecriture;
  }

  private async ecrire(etat: EtatNavigateur): Promise<void> {
    const onglets = Object.fromEntries(
      Object.entries(etat.onglets).map(([id, { chargement, peutReculer, peutAvancer, plante, erreur, ...reste }]) => [id, reste]),
    );
    const cible = join(this.dossier, FICHIER);
    const temporaire = `${cible}.${process.pid}.${++this.numero}.tmp`;
    await fs.mkdir(this.dossier, { recursive: true });
    const fichier = await fs.open(temporaire, "w");
    try {
      await fichier.writeFile(JSON.stringify({ ...etat, onglets }, null, 2));
      await fichier.sync(); // sur disque avant le rename : une coupure de courant ne laisse pas un fichier vide
    } finally {
      await fichier.close();
    }
    await fs.rename(temporaire, cible);
  }
}
