import { stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { dossierTemporaire } from "../aide/temporaire.js";
import { ReviewComments, EMPTY_REMARK, rejoin, type Comment } from "../../src/relecture/commentaires.js";
import { parserDiff } from "../../src/relecture/diff.js";

const ctx = (lignes: string[]) => lignes.map((t) => ` ${t}`);
function patch(debut: number, lignes: string[]): string {
  return [`@@ -${debut},${lignes.length} +${debut},${lignes.length} @@`, ...lignes, ""].join("\n");
}
function com(debut: number, lignes: Comment["lignes"]): Comment {
  return { id: "c-1", fichier: "f.txt", debut, fin: debut + lignes.length - 1, lignes, texte: "t", cree: "", envoye: false, resolu: false, ligneChangee: false };
}
const L = (marque: " " | "+" | "-", texte: string) => ({ marque, texte });

describe("recoller", () => {
  test("same content, shifted 5 lines by an addition above: re-attached 5 lines lower, ligneChangee false", () => {
    const blocs = parserDiff(patch(15, ctx(["a", "b", "c"])));
    const r = rejoin(com(10, [L(" ", "b"), L(" ", "c")]), blocs);
    expect([r.debut, r.fin, r.ligneChangee]).toEqual([16, 17, false]);
  });
  test("two identical windows: the one closest to the old start wins", () => {
    const blocs = parserDiff(patch(1, ctx(["x", "y", "z", "x", "y"])));
    expect(rejoin(com(5, [L(" ", "x"), L(" ", "y")]), blocs).debut).toBe(4);
    expect(rejoin(com(1, [L(" ", "x"), L(" ", "y")]), blocs).debut).toBe(1);
  });
  test("modified content: attached to the closest line, ligneChangee true", () => {
    const blocs = parserDiff(patch(1, ctx(["a", "b", "c", "d"])));
    const r = rejoin(com(3, [L(" ", "autre")]), blocs);
    expect([r.debut, r.fin, r.ligneChangee]).toEqual([3, 3, true]);
  });
  test("3-line range with one changed: brought back to one line, ligneChangee true", () => {
    const blocs = parserDiff(patch(1, ctx(["a", "b", "CHANGE", "d"])));
    const r = rejoin(com(1, [L(" ", "a"), L(" ", "b"), L(" ", "c")]), blocs);
    expect([r.debut, r.fin, r.ligneChangee]).toEqual([1, 1, true]);
  });
  test("comment on a « - » line: found again as long as the deletion is displayed", () => {
    const blocs = parserDiff("@@ -1,3 +1,2 @@\n a\n-b\n c\n");
    const r = rejoin(com(2, [L("-", "b")]), blocs);
    expect([r.debut, r.ligneChangee]).toEqual([2, false]);
  });
  test("window compared on the text alone: a « + » line that became context after a review is found again, ligneChangee false", () => {
    const blocs = parserDiff(patch(20, ctx(["x", "nouveau", "y"])));
    const r = rejoin({ ...com(15, [L("+", "nouveau"), L(" ", "y")]), ligneChangee: true }, blocs);
    expect([r.debut, r.fin, r.ligneChangee]).toEqual([21, 22, false]);
  });
  test("without any block: unchanged, ligneChangee true", () => {
    const r = rejoin(com(7, [L(" ", "a")]), []);
    expect([r.debut, r.fin, r.ligneChangee]).toEqual([7, 7, true]);
  });
});

describe("CommentairesRelecture", () => {
  const brut = { fichier: "f.txt", debut: 1, fin: 1, lignes: [L(" ", "a")], texte: "à revoir" };
  async function depot() {
    const dossier = await dossierTemporaire();
    return { fichier: join(dossier, "p", "x.commentaires.json") };
  }

  test("file without a diff (diff null): the comment stays, attached to the file, ligneChangee true", async () => {
    const { fichier } = await depot();
    const r = new ReviewComments(fichier);
    await r.ajouter(brut);
    await r.ajouter({ ...brut, fichier: "autre.txt" });
    const res = await r.recollerFichier("f.txt", null);
    expect(res).toHaveLength(1);
    expect(res[0]!.ligneChangee).toBe(true);
    const tous = await r.liste();
    expect(tous).toHaveLength(2);
    expect(tous.find((c) => c.fichier === "autre.txt")!.ligneChangee).toBe(false);
  });
  test("ajouter refuses an empty or whitespace text with REMARQUE_VIDE", async () => {
    const r = new ReviewComments((await depot()).fichier);
    await expect(r.ajouter({ ...brut, texte: "" })).rejects.toThrow(EMPTY_REMARK);
    await expect(r.ajouter({ ...brut, texte: "  \n " })).rejects.toThrow(EMPTY_REMARK);
    expect(await r.liste()).toEqual([]);
  });
  test("aEnvoyer returns the unresolved ones, sent included; after marquerEnvoyes, envoye true; a resolved one is never returned", async () => {
    const r = new ReviewComments((await depot()).fichier);
    const a = await r.ajouter(brut);
    const b = await r.ajouter(brut);
    expect((await r.aEnvoyer()).map((c) => c.id)).toEqual([a.id, b.id]);
    await r.marquerEnvoyes([a.id]);
    const apres = await r.aEnvoyer();
    expect(apres.map((c) => c.envoye)).toEqual([true, false]);
    await r.resoudre(a.id, true);
    expect((await r.aEnvoyer()).map((c) => c.id)).toEqual([b.id]);
  });
  test("apresRelu deletes the resolved ones and keeps the unresolved ones", async () => {
    const r = new ReviewComments((await depot()).fichier);
    const a = await r.ajouter(brut);
    const b = await r.ajouter(brut);
    await r.resoudre(a.id, true);
    await r.apresRelu();
    expect((await r.liste()).map((c) => c.id)).toEqual([b.id]);
  });
  test("marquerEnvoyesSiInchanges: a comment modified since the read is not marked sent", async () => {
    const r = new ReviewComments((await depot()).fichier);
    const a = await r.ajouter(brut);
    const b = await r.ajouter(brut);
    const lus = await r.aEnvoyer();
    await r.modifier(b.id, "texte changé");
    await r.marquerEnvoyesSiInchanges(lus.map((c) => ({ id: c.id, texte: c.texte })));
    const l = await r.liste();
    expect(l.find((c) => c.id === a.id)!.envoye).toBe(true);
    expect(l.find((c) => c.id === b.id)).toMatchObject({ envoye: false, texte: "texte changé" });
  });
  test("modify and delete", async () => {
    const r = new ReviewComments((await depot()).fichier);
    const a = await r.ajouter(brut);
    await r.modifier(a.id, "autre");
    expect((await r.liste())[0]!.texte).toBe("autre");
    await expect(r.modifier(a.id, " ")).rejects.toThrow(EMPTY_REMARK);
    await r.supprimer(a.id);
    expect(await r.liste()).toEqual([]);
  });
  test("the file has mode 0600 and survives a re-read from disk", async () => {
    const { fichier } = await depot();
    await new ReviewComments(fichier).ajouter(brut);
    expect((await stat(fichier)).mode & 0o777).toBe(0o600);
    expect((await new ReviewComments(fichier).liste())[0]!.texte).toBe("à revoir");
  });
});
