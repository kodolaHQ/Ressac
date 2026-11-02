import { afterEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Remarques, type CheminsEspace, type Lot, type ProjetSuivi } from "@webaios/noyau";
import { COMPARAISON_INCONNUE, PLAGE_HORS_BLOC, ServiceRelecture } from "../../src/main/design/relecture";

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
  const dossiersDesign = { remarquesEspace: join(racine, "remarques"), prive: join(racine, "prive") };
  const remarques = new Remarques({ dossiers: dossiersDesign });
  const envois: { projet: ProjetSuivi; lot: Lot }[] = [];
  const service = new ServiceRelecture({
    dossiers: dossiersDesign,
    chemins: { projets } as CheminsEspace,
    registre: () => null,
    remarques,
    envoyer: async (projet, lot) => void envois.push({ projet, lot }),
  });
  return {
    service, remarques, envois,
    ecrire: (texte: string, nom = "a.txt") => writeFileSync(join(projets, "essai", nom), texte),
  };
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

const TRENTE = Array.from({ length: 30 }, (_, i) => `ligne ${i + 1}`);
/** a.txt de 30 lignes, avec les lignes `modifiees` (numéros) réécrites. */
const trente = (...modifiees: number[]) => TRENTE.map((l, i) => (modifiees.includes(i + 1) ? `${l} modifiée` : l)).join("\n") + "\n";

async function ouvert(service: ServiceRelecture) {
  const v = await service.ouvrir("app-essai");
  if (v.etat !== "ok") throw new Error(v.raison);
  return v;
}

test("commenter une plage qui déborde du bloc → refus", async () => {
  const { service, ecrire } = preparer();
  ecrire(trente());
  await service.priseEnCharge(["essai"]);
  ecrire(trente(5, 25));
  const v = await ouvert(service);
  // Deux blocs : lignes 2 à 8 et 22 à 28.
  expect(await service.commenter("app-essai", v.jeton, { fichier: "a.txt", debut: 5, fin: 25, texte: "trop large" })).toEqual({ ok: false, erreur: PLAGE_HORS_BLOC });
  expect(await service.commenter("app-essai", v.jeton, { fichier: "a.txt", debut: 1, fin: 3, texte: "hors du diff" })).toEqual({ ok: false, erreur: PLAGE_HORS_BLOC });
  expect(await service.commenter("app-essai", v.jeton, { fichier: "a.txt", debut: 4, fin: 5, texte: "  " })).toMatchObject({ ok: false });
  const inconnu = `${"a".repeat(40)}:${"b".repeat(40)}`;
  expect(await service.commenter("app-essai", inconnu, { fichier: "a.txt", debut: 4, fin: 5, texte: "x" })).toEqual({ ok: false, erreur: COMPARAISON_INCONNUE });
  expect(await service.commenter("app-essai", v.jeton, { fichier: "a.txt", debut: 4, fin: 5, texte: "bien" })).toEqual({ ok: true });
  const [c] = await service.commentaires("app-essai");
  expect(c).toMatchObject({ fichier: "a.txt", debut: 4, fin: 5, texte: "bien", envoye: false, resolu: false });
  // Les lignes viennent du diff gardé, pas de la page.
  expect(c!.lignes).toEqual([{ marque: " ", texte: "ligne 4" }, { marque: "-", texte: "ligne 5" }, { marque: "+", texte: "ligne 5 modifiée" }]);
});

test("relu retient l'arbre montré : un fichier modifié après ouvrir() reste dans le diff suivant", async () => {
  const { service, ecrire } = preparer();
  await service.priseEnCharge(["essai"]);
  ecrire("deux\n");
  const v = await ouvert(service);
  ecrire("autre\n", "b.txt");
  const apres = await service.relu("app-essai", v.jeton);
  if (apres.etat !== "ok") throw new Error(apres.raison);
  expect(apres.comparaison.fichiers.map((f) => f.chemin)).toEqual(["b.txt"]);
  // L'ancien jeton ne sert plus (ni à relire, ni à lire un fichier).
  await expect(service.relu("app-essai", v.jeton)).rejects.toThrow(COMPARAISON_INCONNUE);
  await expect(service.relu("app-essai", `${"a".repeat(40)}:${"b".repeat(40)}`)).rejects.toThrow(COMPARAISON_INCONNUE);
});

test("relu : les commentaires résolus disparaissent, les autres restent", async () => {
  const { service, ecrire } = preparer();
  ecrire(trente());
  await service.priseEnCharge(["essai"]);
  ecrire(trente(15));
  const v = await ouvert(service);
  await service.commenter("app-essai", v.jeton, { fichier: "a.txt", debut: 15, fin: 15, texte: "un" });
  await service.commenter("app-essai", v.jeton, { fichier: "a.txt", debut: 14, fin: 14, texte: "deux" });
  const [un] = await service.commentaires("app-essai");
  await service.resoudre("app-essai", un!.id, true);
  const apres = await service.relu("app-essai", v.jeton);
  if (apres.etat !== "ok") throw new Error(apres.raison);
  expect(apres.comparaison.fichiers).toEqual([]);
  expect(apres.commentaires.map((c) => [c.texte, c.fichier])).toEqual([["deux", "a.txt"]]);
});

test("envoyer : un lot relecture avec fichier, debut, fin, lignes marquées ; les commentaires restent, envoyés ; un second envoi reprend les non résolus", async () => {
  const { service, remarques, envois, ecrire } = preparer();
  ecrire(trente());
  await service.priseEnCharge(["essai"]);
  ecrire(trente(15));
  const v = await ouvert(service);
  expect(v).toMatchObject({ destination: "l'agent", sansDestination: null });
  expect(await service.envoyer("app-essai")).toMatchObject({ ok: false });
  await service.commenter("app-essai", v.jeton, { fichier: "a.txt", debut: 15, fin: 15, texte: "garder l'ancien nom" });
  await service.commenter("app-essai", v.jeton, { fichier: "a.txt", debut: 13, fin: 14, texte: "et ici" });
  expect(await service.envoyer("app-essai")).toEqual({ ok: true });
  const lots = await remarques.lots("app-essai");
  expect(lots).toHaveLength(1);
  expect(lots[0]).toMatchObject({ destination: "agent" });
  expect(lots[0]!.elements.map((e) => ({ type: e.type, texte: e.texte, contexte: e.contexte }))).toEqual([
    { type: "relecture", texte: "garder l'ancien nom", contexte: { fichier: "a.txt", debut: 15, fin: 15, lignes: [{ marque: "-", texte: "ligne 15" }, { marque: "+", texte: "ligne 15 modifiée" }] } },
    { type: "relecture", texte: "et ici", contexte: { fichier: "a.txt", debut: 13, fin: 14, lignes: [{ marque: " ", texte: "ligne 13" }, { marque: " ", texte: "ligne 14" }] } },
  ]);
  expect(envois).toHaveLength(1);
  expect(envois[0]!.projet).toMatchObject({ type: "app", projet: "app-essai", dossier: "essai" });
  expect(envois[0]!.lot.id).toBe(lots[0]!.id);
  const restants = await service.commentaires("app-essai");
  expect(restants.map((c) => c.envoye)).toEqual([true, true]);
  await service.resoudre("app-essai", restants[0]!.id, true);
  expect(await service.envoyer("app-essai")).toEqual({ ok: true });
  const tous = await remarques.lots("app-essai");
  expect(tous).toHaveLength(2);
  const second = tous.find((l) => l.id !== lots[0]!.id)!;
  expect(second.elements.map((e) => e.texte)).toEqual(["et ici"]);
});
