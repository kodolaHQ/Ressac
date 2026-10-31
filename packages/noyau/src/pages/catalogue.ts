// Le catalogue des composants intégrés : ce que Gemma peut poser dans une page, et avec quelles propriétés. Pur.

export type GenrePropriete = "reference" | "champ" | "texte" | "nombre" | "case" | "choix" | "colonnes" | "chiffres";
export type Propriete = { genre: GenrePropriete; description: string; requis: boolean; choix?: string[]; max?: number };
export type DefinitionComposant = { nom: string; description: string; proprietes: Record<string, Propriete>; origine: "integre" | "agent" };

const p = (genre: GenrePropriete, description: string, requis = false, plus: { choix?: string[]; max?: number } = {}): Propriete => ({
  genre, description, requis, ...plus,
});

function integre(nom: string, description: string, proprietes: Record<string, Propriete>): DefinitionComposant {
  return { nom, description, proprietes, origine: "integre" };
}

export const COMPOSANTS_INTEGRES: DefinitionComposant[] = [
  integre("titre", "Un titre de section.", { texte: p("texte", "Le titre", true, { max: 80 }) }),
  integre("paragraphe", "Un court texte, écrit ou lu dans les résultats.", {
    texte: p("texte", "Le texte (ou valeur)", false, { max: 400 }),
    valeur: p("reference", "Une valeur des résultats, à la place de texte"),
  }),
  integre("encadre", "Un encadré mis en valeur (information, avis, attention).", {
    niveau: p("choix", "Le ton", true, { choix: ["info", "avis", "attention"] }),
    titre: p("texte", "Son titre", false, { max: 80 }),
    texte: p("texte", "Son texte", false, { max: 400 }),
    elements: p("reference", "Une liste courte à montrer dedans"),
    champ: p("champ", "Le champ à montrer pour chaque élément"),
  }),
  integre("chiffre", "Un grand chiffre avec son libellé.", {
    valeur: p("reference", "La valeur", true),
    libelle: p("texte", "Ce que mesure le chiffre", true, { max: 60 }),
  }),
  integre("chiffres", "Plusieurs chiffres côte à côte (6 au plus).", {
    chiffres: p("chiffres", "Liste de { valeur: référence, libelle: texte ≤ 60 }", true, { max: 6 }),
  }),
  integre("liste", "Une liste de lignes ; une référence finissant par regrouper donne une section par valeur.", {
    elements: p("reference", "La liste", true),
    titre: p("champ", "Champ du titre", true),
    sousTitre: p("champ", "Champ du sous-titre"),
    lien: p("champ", "Champ de l'adresse du lien"),
  }),
  integre("cartes", "Des cartes ; une référence finissant par regrouper donne une section par valeur.", {
    elements: p("reference", "La liste", true),
    titre: p("champ", "Champ du titre", true),
    sousTitre: p("champ", "Champ du sous-titre"),
    image: p("champ", "Champ de l'image"),
    valeur: p("champ", "Champ de la valeur"),
    etiquettes: p("champ", "Champ des étiquettes"),
    lien: p("champ", "Champ de l'adresse du lien"),
  }),
  integre("tableau", "Un tableau ; une référence finissant par regrouper donne une section par valeur.", {
    elements: p("reference", "La liste", true),
    colonnes: p("colonnes", "Liste de { champ, libelle }", true, { max: 8 }),
    lien: p("champ", "Champ de l'adresse du lien"),
  }),
  integre("champs", "Les champs d'un objet, en clair.", {
    objet: p("reference", "L'objet", true),
    champs: p("colonnes", "Liste de { champ, libelle } (absent : tous les champs simples)", false, { max: 12 }),
  }),
  integre("etiquettes", "Des étiquettes.", {
    valeurs: p("reference", "Une liste de textes"),
    elements: p("reference", "Une liste d'objets, avec champ"),
    champ: p("champ", "Le champ à montrer"),
  }),
  integre("lien", "Un lien vers une adresse lue dans les résultats.", {
    objet: p("reference", "L'objet qui porte l'adresse", true),
    url: p("champ", "Champ de l'adresse", true),
    texte: p("texte", "Texte du lien", false, { max: 80 }),
    champTexte: p("champ", "Champ de l'objet qui donne le texte du lien (l'emporte sur texte si les deux sont donnés)"),
  }),
  integre("groupe", "Un groupe de blocs sous un titre (blocs).", {
    titre: p("texte", "Le titre", true, { max: 80 }),
    replie: p("case", "Replié au départ"),
  }),
  integre("colonnes", "Deux colonnes de blocs (gauche, droite).", {}),
];

const FORMES: Partial<Record<GenrePropriete, string>> = {
  colonnes: "colonnes [{champ, libelle}]",
  chiffres: "chiffres [{valeur: référence, libelle}]",
};
/** Règles « l'un ou l'autre » que les propriétés seules ne disent pas. */
const REGLES: Record<string, string> = {
  paragraphe: "texte OU valeur.",
  etiquettes: "valeurs OU elements + champ.",
  lien: "texte OU champTexte (champTexte l'emporte).",
};

/** Le catalogue pour Gemma : une ligne par composant. */
export function catalogueTexte(defs: DefinitionComposant[]): string {
  return defs
    .map((d) => {
      const props = Object.entries(d.proprietes).map(([nom, pr]) => {
        const base = pr.choix ? `${pr.genre} ${pr.choix.join("/")}` : (FORMES[pr.genre] ?? pr.genre);
        const max = pr.max !== undefined ? ` ≤${pr.max}` : "";
        return `${nom} (${base}${max}${pr.requis ? ", requis" : ""})`;
      });
      const regle = d.origine === "integre" && REGLES[d.nom] ? ` ${REGLES[d.nom]}` : "";
      return `${d.nom} : ${d.description}${props.length ? ` Propriétés : ${props.join(", ")}.` : ""}${regle}`;
    })
    .join("\n");
}
