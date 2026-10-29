import { z } from "zod";

/** Ce que le moteur sait d'un type de bloc : le schéma de ses paramètres et son rapport au mode « par élément ». */
export interface DefinitionBloc {
  type: string;
  libelle: string;
  famille: FamilleBloc;
  description: string;
  parametres: z.ZodType;
  parElement: "non" | "option" | "toujours";
  /** `parElement` : requise seulement quand le paramètre `parElement` vaut true. */
  entree: "requise" | "facultative" | "parElement";
  /** Les champs du formulaire du bloc : un par clé du schéma des paramètres. */
  champs: ChampFormulaire[];
  /**
   * Le bloc peut faire partie de la chaîne « au fil de l'eau » (quand `parElement` vaut true) : chaque élément le
   * traverse seul jusqu'à la sortie. Interne au moteur, le catalogue ne l'expose pas.
   */
  chaine: boolean;
}

export type FamilleBloc = "Sources" | "Listes" | "IA" | "Logique/Code" | "Sortie";

export type ChampFormulaire = {
  nom: string;
  libelle: string;
  aide?: string;
  requis: boolean;
  /** Valeur par défaut du schéma ; pour un champ requis, une valeur neutre qui pré-remplit un bloc neuf. */
  defaut?: unknown;
  genre: "texte" | "gabarit" | "nombre" | "case" | "choix" | "textes";
  choix?: string[];
  min?: number;
  max?: number;
  entier?: boolean;
  /** Seulement quand `parElement` vaut true (champ, siErreur, budgetSecondes, reutiliser). */
  parElementSeulement?: true;
};

/** Paramètres communs aux blocs qui peuvent travailler élément par élément. */
export const ParametresParElement = {
  parElement: z.boolean().default(false),
  siErreur: z.enum(["sauter", "echouer"]).default("sauter"),
  // 170 s au plus sans durée maximale du widget, sa durée sinon : la borne selon le widget est dans validerWorkflow.
  budgetSecondes: z.number().int().min(1).max(3600).optional(),
  reutiliser: z.string().regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, "chemin de clé invalide").optional(),
  /** Durée de vie d'un résultat réutilisé ; sans valeur, pour toujours. Seulement avec `reutiliser` (validerWorkflow). */
  garderJours: z.number().int().min(1).max(365).optional(),
};

/** Texte d'un gabarit (`{chemin}`) : borné, jamais exécuté. */
export const Gabarit = z.string().min(1).max(20_000);

/** Le champ `parElement` et les champs qui n'ont de sens que lorsqu'il vaut true. */
export const CHAMP_PAR_ELEMENT: ChampFormulaire = {
  nom: "parElement",
  libelle: "Un élément à la fois",
  aide: "Applique le bloc à chaque élément de la liste reçue.",
  requis: false,
  defaut: false,
  genre: "case",
};

export function champsParElementSeulement(): ChampFormulaire[] {
  return [
    { nom: "siErreur", libelle: "En cas d'erreur", requis: false, defaut: "sauter", genre: "choix", choix: ["sauter", "echouer"], parElementSeulement: true },
    { nom: "budgetSecondes", libelle: "Durée maximale (secondes)", aide: "170 s au plus, ou la durée maximale de l'exécution", requis: false, genre: "nombre", min: 1, max: 3600, entier: true, parElementSeulement: true },
    { nom: "reutiliser", libelle: "Réutiliser un résultat précédent", aide: "Chemin de la clé qui identifie l'élément.", requis: false, genre: "texte", parElementSeulement: true },
    { nom: "garderJours", libelle: "Garder (jours)", aide: "Sans valeur : pour toujours.", requis: false, genre: "nombre", min: 1, max: 365, entier: true, parElementSeulement: true },
  ];
}
