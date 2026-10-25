import { expect, test, vi } from "vitest";
import { entreesMenuPage, type ParametresMenuPage } from "../src/main/onglets/menu-page";

const base: ParametresMenuPage = {
  linkURL: "",
  srcURL: "",
  mediaType: "none",
  selectionText: "",
  isEditable: false,
  misspelledWord: "",
  dictionarySuggestions: [],
  x: 10,
  y: 20,
};
const actions = () => ({
  ouvrirOnglet: vi.fn(),
  copier: vi.fn(),
  remplacerMot: vi.fn(),
  inspecter: vi.fn(),
  copierImage: vi.fn(),
});
const cliquer = (x: { click?: unknown } | undefined) => (x!.click as () => void)();
const libelles = (e: { label?: string; type?: string; role?: string }[]) => e.map((x) => x.label ?? x.role ?? x.type);

test("sur un lien : ouvrir dans un nouvel onglet et copier l'adresse", () => {
  const a = actions();
  const e = entreesMenuPage({ ...base, linkURL: "https://a.fr/x" }, a);
  expect(libelles(e)).toEqual(["Ouvrir le lien dans un nouvel onglet", "Copier l'adresse du lien", "separator", "Inspecter"]);
  cliquer(e[0]);
  cliquer(e[1]);
  expect(a.ouvrirOnglet).toHaveBeenCalledWith("https://a.fr/x");
  expect(a.copier).toHaveBeenCalledWith("https://a.fr/x");
});

test("sur une image : ouvrir, copier l'image et son adresse", () => {
  const a = actions();
  const e = entreesMenuPage({ ...base, mediaType: "image", srcURL: "https://a.fr/i.png" }, a);
  expect(libelles(e)).toEqual(["Ouvrir l'image dans un nouvel onglet", "Copier l'image", "Copier l'adresse de l'image", "separator", "Inspecter"]);
  cliquer(e[1]);
  expect(a.copierImage).toHaveBeenCalledWith(10, 20);
});

test("texte sélectionné : copier ; champ éditable : couper/copier/coller ; mot mal orthographié : suggestions en tête", () => {
  expect(libelles(entreesMenuPage({ ...base, selectionText: "bonjour" }, actions()))).toEqual(["copy", "separator", "Inspecter"]);
  const a = actions();
  const e = entreesMenuPage({ ...base, isEditable: true, misspelledWord: "bonjuor", dictionarySuggestions: ["bonjour"] }, a);
  expect(libelles(e)).toEqual(["bonjour", "separator", "cut", "copy", "paste", "selectAll", "separator", "Inspecter"]);
  cliquer(e[0]);
  expect(a.remplacerMot).toHaveBeenCalledWith("bonjour");
});

test("un lien javascript: n'est pas proposé à l'ouverture", () => {
  expect(libelles(entreesMenuPage({ ...base, linkURL: "javascript:alert(1)" }, actions()))).toEqual(["Inspecter"]);
});
