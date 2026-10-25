import { join } from "node:path";
import { expect, test } from "vitest";
import { cheminLibre } from "../src/main/telechargements";

const D = "/tmp/dl";
const existants = (...noms: string[]) => (chemin: string) => noms.map((n) => join(D, n)).includes(chemin);

test("cheminLibre ajoute (1), (2)… sans écraser", () => {
  expect(cheminLibre(D, "rapport.pdf", existants())).toBe(join(D, "rapport.pdf"));
  expect(cheminLibre(D, "rapport.pdf", existants("rapport.pdf"))).toBe(join(D, "rapport (1).pdf"));
  expect(cheminLibre(D, "rapport.pdf", existants("rapport.pdf", "rapport (1).pdf"))).toBe(join(D, "rapport (2).pdf"));
});

test("cheminLibre garde l'extension, même pour un nom sans extension ou avec plusieurs points", () => {
  expect(cheminLibre(D, "LISEZMOI", existants("LISEZMOI"))).toBe(join(D, "LISEZMOI (1)"));
  expect(cheminLibre(D, "archive.tar.gz", existants("archive.tar.gz"))).toBe(join(D, "archive.tar (1).gz"));
  expect(cheminLibre(D, ".bashrc", existants(".bashrc"))).toBe(join(D, ".bashrc (1)"));
});

test("cheminLibre ne sort jamais du dossier, même avec un nom piégé", () => {
  expect(cheminLibre(D, "../../etc/passwd", existants())).toBe(join(D, "passwd"));
  expect(cheminLibre(D, "a\\b.txt", existants())).toBe(join(D, "a_b.txt"));
  expect(cheminLibre(D, "..", existants())).toBe(join(D, "telechargement"));
  expect(cheminLibre(D, "", existants())).toBe(join(D, "telechargement"));
});
