import { afterEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheminsEspace } from "@webaios/noyau";
import { COMPARAISON_INCONNUE, ServiceRelecture } from "../../src/main/design/relecture";

const dossiers: string[] = [];
afterEach(() => {
  for (const d of dossiers.splice(0)) rmSync(d, { recursive: true, force: true });
});

function preparer() {
  const racine = realpathSync(mkdtempSync(join(tmpdir(), "webaios-relecture-")));
  dossiers.push(racine);
  const projets = join(racine, "projets");
  mkdirSync(join(projets, "essai"), { recursive: true });
  writeFileSync(join(projets, "essai", "a.txt"), "un\n");
  const service = new ServiceRelecture({
    dossiers: { remarquesEspace: join(racine, "remarques"), prive: join(racine, "prive") },
    chemins: { projets } as CheminsEspace,
    registre: () => null,
  });
  return { service, ecrire: (texte: string) => writeFileSync(join(projets, "essai", "a.txt"), texte) };
}

test("deux ouvertures donnent deux jetons ; fichier avec le premier montre encore la première comparaison ; un jeton inconnu est refusé", async () => {
  const { service, ecrire } = preparer();
  await service.priseEnCharge(["essai"]);
  ecrire("deux\n");
  const v1 = await service.ouvrir("app-essai");
  if (v1.etat !== "ok") throw new Error(v1.raison);
  ecrire("trois\n");
  const v2 = await service.ouvrir("app-essai");
  if (v2.etat !== "ok") throw new Error(v2.raison);
  expect(v1.jeton).toMatch(/^[0-9a-f]{40}:[0-9a-f]{40}$/);
  expect(v2.jeton).not.toBe(v1.jeton);
  const textes = async (jeton: string) => (await service.fichier("app-essai", jeton, "a.txt")).blocs.flatMap((b) => b.lignes.filter((l) => l.marque === "+").map((l) => l.texte));
  expect(await textes(v1.jeton)).toEqual(["deux"]);
  expect(await textes(v2.jeton)).toEqual(["trois"]);
  expect(await service.lignes("app-essai", v1.jeton, "a.txt", 1, 5)).toEqual(["deux"]);
  // Un jeton connu : la même comparaison, sans comparer de nouveau.
  ecrire("quatre\n");
  const v3 = await service.ouvrir("app-essai", v1.jeton);
  expect(v3).toMatchObject({ etat: "ok", jeton: v1.jeton });
  expect(await textes(v1.jeton)).toEqual(["deux"]);
  const inconnu = `${"a".repeat(40)}:${"b".repeat(40)}`;
  await expect(service.fichier("app-essai", inconnu, "a.txt")).rejects.toThrow(COMPARAISON_INCONNUE);
  await expect(service.lignes("app-essai", inconnu, "a.txt", 1, 2)).rejects.toThrow(COMPARAISON_INCONNUE);
});

test("au plus 8 comparaisons gardées par projet : la plus ancienne tombe", async () => {
  const { service, ecrire } = preparer();
  await service.priseEnCharge(["essai"]);
  const jetons: string[] = [];
  for (let i = 0; i < 9; i++) {
    ecrire(`v${i}\n`);
    const v = await service.ouvrir("app-essai");
    if (v.etat !== "ok") throw new Error(v.raison);
    jetons.push(v.jeton);
  }
  await expect(service.fichier("app-essai", jetons[0]!, "a.txt")).rejects.toThrow(COMPARAISON_INCONNUE);
  expect((await service.fichier("app-essai", jetons[1]!, "a.txt")).chemin).toBe("a.txt");
});
