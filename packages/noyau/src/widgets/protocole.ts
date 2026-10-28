import { z } from "zod";

/** Taille maximale d'une ligne du protocole récolteur <-> noyau. */
export const LIGNE_MAX_OCTETS = 4 * 1024 * 1024;

export const FonctionRecolteur = z.enum(["lirePage", "recuperer", "kev", "gemma"]);
export type FonctionRecolteur = z.infer<typeof FonctionRecolteur>;

/** Sortie standard du récolteur : une ligne JSON par message. */
export const MessageRecolteur = z.discriminatedUnion("t", [
  z.object({ t: z.literal("appel"), n: z.number().int(), f: FonctionRecolteur, a: z.unknown() }),
  z.object({ t: z.literal("fin"), donnees: z.unknown() }),
  z.object({ t: z.literal("echec"), erreur: z.string() }),
]);
export type MessageRecolteur = z.infer<typeof MessageRecolteur>;

/** Entrée standard du récolteur : la ligne initiale, puis les réponses. */
export const MessageNoyau = z.union([
  z.object({ t: z.literal("debut"), precedent: z.unknown(), maintenant: z.string() }),
  z.object({ t: z.literal("reponse"), n: z.number().int(), ok: z.unknown() }),
  z.object({ t: z.literal("reponse"), n: z.number().int(), erreur: z.string() }),
]);
export type MessageNoyau = z.infer<typeof MessageNoyau>;

/** Arguments des appels, selon la fonction. */
export const ArgsLirePage = z.object({ url: z.string(), compte: z.boolean().optional() });
export const ArgsRecuperer = z.object({ url: z.string(), format: z.enum(["texte", "json"]).optional() });
export const ArgsKev = z.object({ state: z.string(), questions: z.record(z.string(), z.unknown()) });
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

export function ligneDebut(precedent: unknown, maintenant: string): string {
  return JSON.stringify({ t: "debut", precedent: precedent ?? null, maintenant }) + "\n";
}
