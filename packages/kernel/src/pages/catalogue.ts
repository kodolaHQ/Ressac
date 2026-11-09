// The catalog of built-in components: what Gemma can put in a page, and with which properties. Pure.

export type PropertyKind = "reference" | "champ" | "texte" | "nombre" | "case" | "choix" | "colonnes" | "chiffres";
export type Property = { genre: PropertyKind; description: string; requis: boolean; choix?: string[]; max?: number };
export type ComponentDefinition = { nom: string; description: string; proprietes: Record<string, Property>; origine: "integre" | "agent" };

const p = (kind: PropertyKind, description: string, required = false, extra: { choix?: string[]; max?: number } = {}): Property => ({
  genre: kind, description, requis: required, ...extra,
});

function builtIn(name: string, description: string, properties: Record<string, Property>): ComponentDefinition {
  return { nom: name, description, proprietes: properties, origine: "integre" };
}

export const BUILTIN_COMPONENTS: ComponentDefinition[] = [
  builtIn("titre", "Un titre de section.", { texte: p("texte", "Le titre", true, { max: 80 }) }),
  builtIn("paragraphe", "Un court texte, écrit ou lu dans les résultats.", {
    texte: p("texte", "Le texte (ou valeur)", false, { max: 400 }),
    valeur: p("reference", "Une valeur des résultats, à la place de texte"),
  }),
  builtIn("encadre", "Un encadré mis en valeur (information, avis, attention).", {
    niveau: p("choix", "Le ton", true, { choix: ["info", "avis", "attention"] }),
    titre: p("texte", "Son titre", false, { max: 80 }),
    texte: p("texte", "Son texte", false, { max: 400 }),
    elements: p("reference", "Une liste courte à montrer dedans"),
    champ: p("champ", "Le champ à montrer pour chaque élément"),
  }),
  builtIn("chiffre", "Un grand chiffre avec son libellé.", {
    valeur: p("reference", "La valeur", true),
    libelle: p("texte", "Ce que mesure le chiffre", true, { max: 60 }),
  }),
  builtIn("chiffres", "Plusieurs chiffres côte à côte (6 au plus).", {
    chiffres: p("chiffres", "Liste de { valeur: référence, libelle: texte ≤ 60 }", true, { max: 6 }),
  }),
  builtIn("liste", "Une liste de lignes ; une référence finissant par regrouper donne une section par valeur.", {
    elements: p("reference", "La liste", true),
    titre: p("champ", "Champ du titre", true),
    sousTitre: p("champ", "Champ du sous-titre"),
    lien: p("champ", "Champ de l'adresse du lien"),
  }),
  builtIn("cartes", "Des cartes ; une référence finissant par regrouper donne une section par valeur.", {
    elements: p("reference", "La liste", true),
    titre: p("champ", "Champ du titre", true),
    sousTitre: p("champ", "Champ du sous-titre"),
    image: p("champ", "Champ de l'image"),
    valeur: p("champ", "Champ de la valeur"),
    etiquettes: p("champ", "Champ des étiquettes"),
    lien: p("champ", "Champ de l'adresse du lien"),
  }),
  builtIn("tableau", "Un tableau ; une référence finissant par regrouper donne une section par valeur.", {
    elements: p("reference", "La liste", true),
    colonnes: p("colonnes", "Liste de { champ, libelle }", true, { max: 8 }),
    lien: p("champ", "Champ de l'adresse du lien"),
  }),
  builtIn("champs", "Les champs d'un objet, en clair.", {
    objet: p("reference", "L'objet", true),
    champs: p("colonnes", "Liste de { champ, libelle } (absent : tous les champs simples)", false, { max: 12 }),
  }),
  builtIn("etiquettes", "Des étiquettes.", {
    valeurs: p("reference", "Une liste de textes"),
    elements: p("reference", "Une liste d'objets, avec champ"),
    champ: p("champ", "Le champ à montrer"),
  }),
  builtIn("lien", "Un lien vers une adresse lue dans les résultats.", {
    objet: p("reference", "L'objet qui porte l'adresse", true),
    url: p("champ", "Champ de l'adresse", true),
    texte: p("texte", "Texte du lien", false, { max: 80 }),
    champTexte: p("champ", "Champ de l'objet qui donne le texte du lien (l'emporte sur texte si les deux sont donnés)"),
  }),
  builtIn("groupe", "Un groupe de blocs sous un titre (blocs).", {
    titre: p("texte", "Le titre", true, { max: 80 }),
    replie: p("case", "Replié au départ"),
  }),
  builtIn("colonnes", "Deux colonnes de blocs (gauche, droite).", {}),
];

const SHAPES: Partial<Record<PropertyKind, string>> = {
  colonnes: "colonnes [{champ, libelle}]",
  chiffres: "chiffres [{valeur: référence, libelle}]",
};
/** « One or the other » rules that the properties alone do not state. */
const RULES: Record<string, string> = {
  paragraphe: "texte OU valeur.",
  etiquettes: "valeurs OU elements + champ.",
  lien: "texte OU champTexte (champTexte l'emporte).",
};

/** The catalog for Gemma: one line per component. */
export function catalogText(defs: ComponentDefinition[]): string {
  return defs
    .map((d) => {
      const props = Object.entries(d.proprietes).map(([name, pr]) => {
        const base = pr.choix ? `${pr.genre} ${pr.choix.join("/")}` : (SHAPES[pr.genre] ?? pr.genre);
        const max = pr.max !== undefined ? ` ≤${pr.max}` : "";
        return `${name} (${base}${max}${pr.requis ? ", requis" : ""})`;
      });
      const rule = d.origine === "integre" && RULES[d.nom] ? ` ${RULES[d.nom]}` : "";
      return `${d.nom} : ${d.description}${props.length ? ` Propriétés : ${props.join(", ")}.` : ""}${rule}`;
    })
    .join("\n");
}
