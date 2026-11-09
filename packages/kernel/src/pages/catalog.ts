// The catalog of built-in components: what Gemma can put in a page, and with which properties. Pure.

export type PropertyKind = "reference" | "champ" | "texte" | "nombre" | "case" | "choix" | "colonnes" | "chiffres";
export type Property = { kind: PropertyKind; description: string; required: boolean; choices?: string[]; max?: number };
export type ComponentDefinition = { name: string; description: string; properties: Record<string, Property>; origin: "integre" | "agent" };

const p = (kind: PropertyKind, description: string, required = false, extra: { choices?: string[]; max?: number } = {}): Property => ({
  kind: kind, description, required: required, ...extra,
});

function builtIn(name: string, description: string, properties: Record<string, Property>): ComponentDefinition {
  return { name: name, description, properties: properties, origin: "integre" };
}

export const BUILTIN_COMPONENTS: ComponentDefinition[] = [
  builtIn("titre", "Un titre de section.", { text: p("texte", "Le titre", true, { max: 80 }) }),
  builtIn("paragraphe", "Un court texte, écrit ou lu dans les résultats.", {
    text: p("texte", "Le texte (ou valeur)", false, { max: 400 }),
    value: p("reference", "Une valeur des résultats, à la place de texte"),
  }),
  builtIn("encadre", "Un encadré mis en valeur (information, avis, attention).", {
    level: p("choix", "Le ton", true, { choices: ["info", "avis", "attention"] }),
    title: p("texte", "Son titre", false, { max: 80 }),
    text: p("texte", "Son texte", false, { max: 400 }),
    items: p("reference", "Une liste courte à montrer dedans"),
    field: p("champ", "Le champ à montrer pour chaque élément"),
  }),
  builtIn("chiffre", "Un grand chiffre avec son libellé.", {
    value: p("reference", "La valeur", true),
    label: p("texte", "Ce que mesure le chiffre", true, { max: 60 }),
  }),
  builtIn("chiffres", "Plusieurs chiffres côte à côte (6 au plus).", {
    figures: p("chiffres", "Liste de { valeur: référence, libelle: texte ≤ 60 }", true, { max: 6 }),
  }),
  builtIn("liste", "Une liste de lignes ; une référence finissant par regrouper donne une section par valeur.", {
    items: p("reference", "La liste", true),
    title: p("champ", "Champ du titre", true),
    subtitle: p("champ", "Champ du sous-titre"),
    link: p("champ", "Champ de l'adresse du lien"),
  }),
  builtIn("cartes", "Des cartes ; une référence finissant par regrouper donne une section par valeur.", {
    items: p("reference", "La liste", true),
    title: p("champ", "Champ du titre", true),
    subtitle: p("champ", "Champ du sous-titre"),
    image: p("champ", "Champ de l'image"),
    value: p("champ", "Champ de la valeur"),
    tags: p("champ", "Champ des étiquettes"),
    link: p("champ", "Champ de l'adresse du lien"),
  }),
  builtIn("tableau", "Un tableau ; une référence finissant par regrouper donne une section par valeur.", {
    items: p("reference", "La liste", true),
    columns: p("colonnes", "Liste de { champ, libelle }", true, { max: 8 }),
    link: p("champ", "Champ de l'adresse du lien"),
  }),
  builtIn("champs", "Les champs d'un objet, en clair.", {
    object: p("reference", "L'objet", true),
    fields: p("colonnes", "Liste de { champ, libelle } (absent : tous les champs simples)", false, { max: 12 }),
  }),
  builtIn("etiquettes", "Des étiquettes.", {
    values: p("reference", "Une liste de textes"),
    items: p("reference", "Une liste d'objets, avec champ"),
    field: p("champ", "Le champ à montrer"),
  }),
  builtIn("lien", "Un lien vers une adresse lue dans les résultats.", {
    object: p("reference", "L'objet qui porte l'adresse", true),
    url: p("champ", "Champ de l'adresse", true),
    text: p("texte", "Texte du lien", false, { max: 80 }),
    textField: p("champ", "Champ de l'objet qui donne le texte du lien (l'emporte sur texte si les deux sont donnés)"),
  }),
  builtIn("groupe", "Un groupe de blocs sous un titre (blocs).", {
    title: p("texte", "Le titre", true, { max: 80 }),
    collapsed: p("case", "Replié au départ"),
  }),
  builtIn("colonnes", "Deux colonnes de blocs (gauche, droite).", {}),
];

const SHAPES: Partial<Record<PropertyKind, string>> = {
  colonnes: "colonnes [{champ, libelle}]",
  chiffres: "chiffres [{valeur: référence, libelle}]",
};
/** « One or the other » rules that the properties alone do not state. */
const RULES: Record<string, string> = {
  paragraph: "texte OU valeur.",
  tags: "valeurs OU elements + champ.",
  link: "texte OU champTexte (champTexte l'emporte).",
};

/** The catalog for Gemma: one line per component. */
export function catalogText(defs: ComponentDefinition[]): string {
  return defs
    .map((d) => {
      const props = Object.entries(d.properties).map(([name, pr]) => {
        const base = pr.choices ? `${pr.kind} ${pr.choices.join("/")}` : (SHAPES[pr.kind] ?? pr.kind);
        const max = pr.max !== undefined ? ` ≤${pr.max}` : "";
        return `${name} (${base}${max}${pr.required ? ", requis" : ""})`;
      });
      const rule = d.origin === "integre" && RULES[d.name] ? ` ${RULES[d.name]}` : "";
      return `${d.name} : ${d.description}${props.length ? ` Propriétés : ${props.join(", ")}.` : ""}${rule}`;
    })
    .join("\n");
}
