import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

export type ParametresMenuPage = Pick<
  ContextMenuParams,
  "linkURL" | "srcURL" | "mediaType" | "selectionText" | "isEditable" | "misspelledWord" | "dictionarySuggestions" | "x" | "y"
>;

export interface ActionsMenuPage {
  ouvrirOnglet(url: string): void;
  copier(texte: string): void;
  copierImage(x: number, y: number): void;
  remplacerMot(mot: string): void;
  inspecter(x: number, y: number): void;
}

const ouvrable = (url: string) => /^(https?|file):/i.test(url);

/** Entrées du clic droit sur une page web, selon ce qui est sous la souris. */
export function entreesMenuPage(p: ParametresMenuPage, a: ActionsMenuPage): MenuItemConstructorOptions[] {
  const groupes: MenuItemConstructorOptions[][] = [];
  if (p.isEditable && p.misspelledWord)
    groupes.push(p.dictionarySuggestions.slice(0, 5).map((mot) => ({ label: mot, click: () => a.remplacerMot(mot) })));
  if (p.linkURL && ouvrable(p.linkURL))
    groupes.push([
      { label: "Ouvrir le lien dans un nouvel onglet", click: () => a.ouvrirOnglet(p.linkURL) },
      { label: "Copier l'adresse du lien", click: () => a.copier(p.linkURL) },
    ]);
  if (p.mediaType === "image" && p.srcURL)
    groupes.push([
      ...(ouvrable(p.srcURL) ? [{ label: "Ouvrir l'image dans un nouvel onglet", click: () => a.ouvrirOnglet(p.srcURL) }] : []),
      { label: "Copier l'image", click: () => a.copierImage(p.x, p.y) },
      { label: "Copier l'adresse de l'image", click: () => a.copier(p.srcURL) },
    ]);
  if (p.isEditable) groupes.push([{ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }]);
  else if (p.selectionText) groupes.push([{ role: "copy" }]);
  groupes.push([{ label: "Inspecter", click: () => a.inspecter(p.x, p.y) }]);
  return groupes.filter((g) => g.length).flatMap((g, i) => (i === 0 ? g : [{ type: "separator" as const }, ...g]));
}
