// The catalog of built-in components: what Gemma can put in a page, and with which properties. Pure.

export type PropertyKind = "reference" | "field" | "text" | "number" | "checkbox" | "choice" | "columns" | "figures";
export type Property = { kind: PropertyKind; description: string; required: boolean; choices?: string[]; max?: number };
export type ComponentDefinition = { name: string; description: string; properties: Record<string, Property>; origin: "builtin" | "agent" };

const p = (kind: PropertyKind, description: string, required = false, extra: { choices?: string[]; max?: number } = {}): Property => ({
  kind: kind, description, required: required, ...extra,
});

function builtIn(name: string, description: string, properties: Record<string, Property>): ComponentDefinition {
  return { name: name, description, properties: properties, origin: "builtin" };
}

export const BUILTIN_COMPONENTS: ComponentDefinition[] = [
  builtIn("title", "Un titre de section.", { text: p("text", "Le titre", true, { max: 80 }) }),
  builtIn("paragraph", "Un court texte, écrit ou lu dans les résultats.", {
    text: p("text", "Le texte (ou valeur)", false, { max: 400 }),
    value: p("reference", "Une valeur des résultats, à la place de text"),
  }),
  builtIn("callout", "Un encadré mis en valeur (information, avis, attention).", {
    level: p("choice", "Le ton", true, { choices: ["info", "notice", "warning"] }),
    title: p("text", "Son titre", false, { max: 80 }),
    text: p("text", "Son texte", false, { max: 400 }),
    items: p("reference", "Une liste courte à montrer dedans"),
    field: p("field", "Le champ à montrer pour chaque élément"),
  }),
  builtIn("figure", "Un grand chiffre avec son libellé.", {
    value: p("reference", "La valeur", true),
    label: p("text", "Ce que mesure le chiffre", true, { max: 60 }),
  }),
  builtIn("figures", "Plusieurs chiffres côte à côte (6 au plus).", {
    figures: p("figures", "Liste de { value: référence, label: texte ≤ 60 }", true, { max: 6 }),
  }),
  builtIn("list", "Une liste de lignes ; une référence finissant par group donne une section par valeur.", {
    items: p("reference", "La liste", true),
    title: p("field", "Champ du titre", true),
    subtitle: p("field", "Champ du sous-titre"),
    link: p("field", "Champ de l'adresse du lien"),
  }),
  builtIn("cards", "Des cartes ; une référence finissant par group donne une section par valeur.", {
    items: p("reference", "La liste", true),
    title: p("field", "Champ du titre", true),
    subtitle: p("field", "Champ du sous-titre"),
    image: p("field", "Champ de l'image"),
    value: p("field", "Champ de la valeur"),
    tags: p("field", "Champ des étiquettes"),
    warnings: p("field", "Champ des avertissements (liste de textes)"),
    link: p("field", "Champ de l'adresse du lien"),
  }),
  builtIn("highlight", "La fiche mise en vedette : une seule par page, seulement quand un élément se détache.", {
    object: p("reference", "L'objet mis en vedette", true),
    label: p("text", "Pourquoi il se détache", false, { max: 40 }),
    title: p("field", "Champ du titre", true),
    subtitle: p("field", "Champ du sous-titre"),
    image: p("field", "Champ de l'image"),
    value: p("field", "Champ de la valeur"),
    text: p("field", "Champ d'un court texte"),
    link: p("field", "Champ de l'adresse du lien"),
  }),
  builtIn("table", "Un tableau ; une référence finissant par group donne une section par valeur.", {
    items: p("reference", "La liste", true),
    columns: p("columns", "Liste de { field, label }", true, { max: 8 }),
    link: p("field", "Champ de l'adresse du lien"),
  }),
  builtIn("fields", "Les champs d'un objet, en clair.", {
    object: p("reference", "L'objet", true),
    fields: p("columns", "Liste de { field, label } (absent : tous les champs simples)", false, { max: 12 }),
  }),
  builtIn("tags", "Des étiquettes.", {
    values: p("reference", "Une liste de textes"),
    items: p("reference", "Une liste d'objets, avec field"),
    field: p("field", "Le champ à montrer"),
  }),
  builtIn("link", "Un lien vers une adresse lue dans les résultats.", {
    object: p("reference", "L'objet qui porte l'adresse", true),
    url: p("field", "Champ de l'adresse", true),
    text: p("text", "Texte du lien", false, { max: 80 }),
    textField: p("field", "Champ de l'objet qui donne le texte du lien (l'emporte sur text si les deux sont donnés)"),
  }),
  builtIn("group", "Un groupe de blocs sous un titre (blocks).", {
    title: p("text", "Le titre", true, { max: 80 }),
    collapsed: p("checkbox", "Replié au départ"),
  }),
  builtIn("columns", "Deux colonnes de blocs (left, right).", {}),
];

const SHAPES: Partial<Record<PropertyKind, string>> = {
  columns: "columns [{field, label}]",
  figures: "figures [{value: référence, label}]",
};
/** « One or the other » rules that the properties alone do not state. */
const RULES: Record<string, string> = {
  paragraph: "text OU value.",
  tags: "values OU items + field.",
  link: "text OU textField (textField l'emporte).",
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
      const rule = d.origin === "builtin" && RULES[d.name] ? ` ${RULES[d.name]}` : "";
      return `${d.name} : ${d.description}${props.length ? ` Propriétés : ${props.join(", ")}.` : ""}${rule}`;
    })
    .join("\n");
}
