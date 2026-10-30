import { z } from "zod";
import type { MemoireBlocs } from "./memoire.js";
import type { Bloc, Lien } from "./schema.js";

/** Taille maximale des données d'un widget (son `donnees.json`, une publication au fil de l'eau). */
export const TAILLE_MAX_DONNEES = 2 * 1024 * 1024;

/** Taille maximale d'une ligne du protocole récolteur <-> noyau. */
export const LIGNE_MAX_OCTETS = 4 * 1024 * 1024;

export const FonctionRecolteur = z.enum(["lirePage", "recuperer", "kev", "gemma", "chercherWeb"]);
export type FonctionRecolteur = z.infer<typeof FonctionRecolteur>;

const MemoireEnvoyee = z.record(z.string(), z.object({ type: z.string(), valeur: z.unknown() }));

/** Statut d'un bloc à sa fin, tel que l'envoie le conteneur. */
export const StatutBlocConteneur = z.enum(["reussi", "partiel", "echoue"]);

/**
 * Sortie standard du récolteur : une ligne JSON par message. Pour un workflow, des traces (`bloc`, `journal`) et la
 * mémoire des blocs (`memoire`, juste avant `fin` ; aussi en cours de route pour une exécution progressive, la dernière
 * reçue vaut) ; pendant la chaîne au fil de l'eau, des `publication` ; la fin reste `fin` / `echec`.
 */
export const MessageRecolteur = z.union([
  z.object({ t: z.literal("appel"), n: z.number().int(), f: FonctionRecolteur, a: z.unknown() }),
  z.object({ t: z.literal("bloc"), id: z.string(), etape: z.literal("debut") }),
  z.object({
    t: z.literal("bloc"),
    id: z.string(),
    etape: z.literal("fin"),
    statut: StatutBlocConteneur,
    sortie: z.unknown().optional(),
    sortieTropGrosse: z.literal(true).optional(),
    erreur: z.string().optional(),
  }),
  // Action seulement (`avancement` dans `debut`) : un bloc par élément en est à `faits` éléments sur `total`.
  z
    .object({ t: z.literal("bloc"), id: z.string(), etape: z.literal("avancement"), faits: z.number().int().min(0), total: z.number().int().min(0) })
    .refine((m) => m.faits <= m.total),
  z.object({ t: z.literal("journal"), bloc: z.string(), texte: z.string() }),
  z.object({ t: z.literal("memoire"), memoire: MemoireEnvoyee }),
  z.object({ t: z.literal("publication"), donnees: z.unknown(), faits: z.number().int().min(0), total: z.number().int().min(0) }),
  z.object({ t: z.literal("fin"), donnees: z.unknown() }),
  z.object({ t: z.literal("echec"), erreur: z.string() }),
]);
export type MessageRecolteur = z.infer<typeof MessageRecolteur>;

/** Ce que le conteneur reçoit d'un workflow validé : ses blocs, ses liens et l'ordre d'exécution. */
export type WorkflowEnvoye = { blocs: Bloc[]; liens: Lien[]; ordre: string[] };

/** Pour un essai : les blocs à relancer (dans l'ordre) et les sorties reprises de l'exécution d'origine, par bloc. */
export type RejeuEnvoye = { relances: string[]; sorties: Record<string, unknown> };

/**
 * Entrée standard du récolteur : la ligne initiale (toujours avec son workflow, implicite pour un `recolte.mjs` seul),
 * puis la mémoire des blocs, puis les réponses.
 */
export const MessageNoyau = z.union([
  z.object({
    t: z.literal("debut"),
    precedent: z.unknown(),
    maintenant: z.string(),
    config: z.unknown().optional(),
    workflow: z.object({ blocs: z.array(z.unknown()), liens: z.array(z.unknown()), ordre: z.array(z.string()) }),
    rejeu: z.object({ relances: z.array(z.string()), sorties: z.record(z.string(), z.unknown()) }).optional(),
    limiteMs: z.number().int().positive().optional(),
    progressif: z.literal(true).optional(),
    saisie: z.string().optional(),
    avancement: z.literal(true).optional(),
  }),
  z.object({ t: z.literal("memoire"), memoire: MemoireEnvoyee }),
  z.object({ t: z.literal("reponse"), n: z.number().int(), ok: z.unknown() }),
  z.object({ t: z.literal("reponse"), n: z.number().int(), erreur: z.string() }),
]);
export type MessageNoyau = z.infer<typeof MessageNoyau>;

/** Arguments des appels, selon la fonction. */
/** Au plus 20 écrans défilés par une lecture de page (`defiler`). */
export const DEFILER_MAX = 20;
export const ArgsLirePage = z.object({ url: z.string(), compte: z.boolean().optional(), defiler: z.number().int().min(0).max(DEFILER_MAX).optional() });
export const ArgsRecuperer = z.object({ url: z.string(), format: z.enum(["texte", "json"]).optional() });
export const ArgsKev = z.object({ state: z.string(), questions: z.record(z.string(), z.unknown()) });
/** Recherche web faite par le noyau ; réponse : `{ titre, url, extrait }[]`, au plus `nombre`. */
export const ArgsChercherWeb = z.object({ requete: z.string().min(1).max(500), nombre: z.number().int().min(1).max(20) });
export const ArgsGemma = z.object({ prompt: z.string(), images: z.array(z.string()).optional(), json: z.boolean().optional() });

export type PageLue = { url: string; titre: string; texte: string; liens: { texte: string; url: string }[] };

/** Analyse une ligne de la sortie du récolteur ; null si invalide. */
export function lireMessageRecolteur(ligne: string): MessageRecolteur | null {
  try {
    const r = MessageRecolteur.safeParse(JSON.parse(ligne));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function ligneReponse(n: number, resultat: { ok: unknown } | { erreur: string }): string {
  return JSON.stringify({ t: "reponse", n, ...resultat }) + "\n";
}

export type OptionsDebut = {
  precedent: unknown;
  maintenant: string;
  config: unknown;
  workflow: WorkflowEnvoye;
  rejeu?: RejeuEnvoye;
  /** Plus aucun élément lancé après ce délai (`dureeMaxMinutes × 60 000`). */
  limiteMs?: number;
  /** Mémoire envoyée en cours de route, publications au fil de l'eau. */
  progressif?: true;
  /** Action seulement : le texte tapé au lancement (`{saisie}` des gabarits, `ctx.saisie`). */
  saisie?: string;
  /** Action seulement : les blocs par élément envoient leur avancement. */
  avancement?: true;
};

/**
 * La ligne `debut` ; les clés `rejeu`, `limiteMs`, `progressif`, `saisie` et `avancement` n'y sont que si elles sont
 * données (la ligne d'un widget sans les nouveaux champs ne change pas).
 */
export function ligneDebut(o: OptionsDebut): string {
  return (
    JSON.stringify({
      t: "debut",
      precedent: o.precedent ?? null,
      maintenant: o.maintenant,
      config: o.config ?? null,
      workflow: o.workflow,
      ...(o.rejeu ? { rejeu: { relances: o.rejeu.relances, sorties: o.rejeu.sorties } } : {}),
      ...(o.limiteMs !== undefined ? { limiteMs: o.limiteMs } : {}),
      ...(o.progressif ? { progressif: true } : {}),
      ...(o.saisie !== undefined ? { saisie: o.saisie } : {}),
      ...(o.avancement ? { avancement: true } : {}),
    }) + "\n"
  );
}

/**
 * Octets de la ligne de début telle qu'elle est envoyée (avec, pour un rejeu, les sorties reprises) : le récolteur
 * refuse une ligne de plus de `LIGNE_MAX_OCTETS`. À mesurer avant de lancer un essai, pour refuser sans rien écrire.
 */
export function octetsLigneDebut(o: OptionsDebut): number {
  return Buffer.byteLength(ligneDebut(o));
}

export function debutTropGros(o: OptionsDebut): boolean {
  return octetsLigneDebut(o) > LIGNE_MAX_OCTETS;
}

export function ligneMemoire(m: MemoireBlocs): string {
  return JSON.stringify({ t: "memoire", memoire: m }) + "\n";
}
