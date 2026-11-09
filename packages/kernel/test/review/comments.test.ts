import { stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { tempFolder } from "../helpers/temp.js";
import { ReviewComments, EMPTY_REMARK, rejoin, type Comment } from "../../src/review/comments.js";
import { parserDiff } from "../../src/review/diff.js";

const ctx = (lignes: string[]) => lignes.map((t) => ` ${t}`);
function patch(start: number, lignes: string[]): string {
  return [`@@ -${start},${lignes.length} +${start},${lignes.length} @@`, ...lignes, ""].join("\n");
}
function com(start: number, lignes: Comment["lignes"]): Comment {
  return { id: "c-1", fichier: "f.txt", debut: start, fin: start + lignes.length - 1, lignes, texte: "t", cree: "", envoye: false, resolu: false, ligneChangee: false };
}
const L = (mark: " " | "+" | "-", text: string) => ({ marque: mark, texte: text });

describe("recoller", () => {
  test("same content, shifted 5 lines by an addition above: re-attached 5 lines lower, ligneChangee false", () => {
    const blocks = parserDiff(patch(15, ctx(["a", "b", "c"])));
    const r = rejoin(com(10, [L(" ", "b"), L(" ", "c")]), blocks);
    expect([r.debut, r.fin, r.ligneChangee]).toEqual([16, 17, false]);
  });
  test("two identical windows: the one closest to the old start wins", () => {
    const blocks = parserDiff(patch(1, ctx(["x", "y", "z", "x", "y"])));
    expect(rejoin(com(5, [L(" ", "x"), L(" ", "y")]), blocks).debut).toBe(4);
    expect(rejoin(com(1, [L(" ", "x"), L(" ", "y")]), blocks).debut).toBe(1);
  });
  test("modified content: attached to the closest line, ligneChangee true", () => {
    const blocks = parserDiff(patch(1, ctx(["a", "b", "c", "d"])));
    const r = rejoin(com(3, [L(" ", "autre")]), blocks);
    expect([r.debut, r.fin, r.ligneChangee]).toEqual([3, 3, true]);
  });
  test("3-line range with one changed: brought back to one line, ligneChangee true", () => {
    const blocks = parserDiff(patch(1, ctx(["a", "b", "CHANGE", "d"])));
    const r = rejoin(com(1, [L(" ", "a"), L(" ", "b"), L(" ", "c")]), blocks);
    expect([r.debut, r.fin, r.ligneChangee]).toEqual([1, 1, true]);
  });
  test("comment on a « - » line: found again as long as the deletion is displayed", () => {
    const blocks = parserDiff("@@ -1,3 +1,2 @@\n a\n-b\n c\n");
    const r = rejoin(com(2, [L("-", "b")]), blocks);
    expect([r.debut, r.ligneChangee]).toEqual([2, false]);
  });
  test("window compared on the text alone: a « + » line that became context after a review is found again, ligneChangee false", () => {
    const blocks = parserDiff(patch(20, ctx(["x", "nouveau", "y"])));
    const r = rejoin({ ...com(15, [L("+", "nouveau"), L(" ", "y")]), ligneChangee: true }, blocks);
    expect([r.debut, r.fin, r.ligneChangee]).toEqual([21, 22, false]);
  });
  test("without any block: unchanged, ligneChangee true", () => {
    const r = rejoin(com(7, [L(" ", "a")]), []);
    expect([r.debut, r.fin, r.ligneChangee]).toEqual([7, 7, true]);
  });
});

describe("ReviewComments", () => {
  const raw = { fichier: "f.txt", debut: 1, fin: 1, lignes: [L(" ", "a")], texte: "à revoir" };
  async function depot() {
    const folder = await tempFolder();
    return { fichier: join(folder, "p", "x.commentaires.json") };
  }

  test("file without a diff (diff null): the comment stays, attached to the file, ligneChangee true", async () => {
    const { fichier: file } = await depot();
    const r = new ReviewComments(file);
    await r.ajouter(raw);
    await r.ajouter({ ...raw, fichier: "autre.txt" });
    const res = await r.recollerFichier("f.txt", null);
    expect(res).toHaveLength(1);
    expect(res[0]!.ligneChangee).toBe(true);
    const all = await r.liste();
    expect(all).toHaveLength(2);
    expect(all.find((c) => c.fichier === "autre.txt")!.ligneChangee).toBe(false);
  });
  test("ajouter refuses an empty or whitespace text with EMPTY_REMARK", async () => {
    const r = new ReviewComments((await depot()).fichier);
    await expect(r.ajouter({ ...raw, texte: "" })).rejects.toThrow(EMPTY_REMARK);
    await expect(r.ajouter({ ...raw, texte: "  \n " })).rejects.toThrow(EMPTY_REMARK);
    expect(await r.liste()).toEqual([]);
  });
  test("aEnvoyer returns the unresolved ones, sent included; after marquerEnvoyes, envoye true; a resolved one is never returned", async () => {
    const r = new ReviewComments((await depot()).fichier);
    const a = await r.ajouter(raw);
    const b = await r.ajouter(raw);
    expect((await r.aEnvoyer()).map((c) => c.id)).toEqual([a.id, b.id]);
    await r.marquerEnvoyes([a.id]);
    const after = await r.aEnvoyer();
    expect(after.map((c) => c.envoye)).toEqual([true, false]);
    await r.resoudre(a.id, true);
    expect((await r.aEnvoyer()).map((c) => c.id)).toEqual([b.id]);
  });
  test("apresRelu deletes the resolved ones and keeps the unresolved ones", async () => {
    const r = new ReviewComments((await depot()).fichier);
    const a = await r.ajouter(raw);
    const b = await r.ajouter(raw);
    await r.resoudre(a.id, true);
    await r.apresRelu();
    expect((await r.liste()).map((c) => c.id)).toEqual([b.id]);
  });
  test("marquerEnvoyesSiInchanges: a comment modified since the read is not marked sent", async () => {
    const r = new ReviewComments((await depot()).fichier);
    const a = await r.ajouter(raw);
    const b = await r.ajouter(raw);
    const reads = await r.aEnvoyer();
    await r.modifier(b.id, "texte changé");
    await r.marquerEnvoyesSiInchanges(reads.map((c) => ({ id: c.id, texte: c.texte })));
    const l = await r.liste();
    expect(l.find((c) => c.id === a.id)!.envoye).toBe(true);
    expect(l.find((c) => c.id === b.id)).toMatchObject({ envoye: false, texte: "texte changé" });
  });
  test("modify and delete", async () => {
    const r = new ReviewComments((await depot()).fichier);
    const a = await r.ajouter(raw);
    await r.modifier(a.id, "autre");
    expect((await r.liste())[0]!.texte).toBe("autre");
    await expect(r.modifier(a.id, " ")).rejects.toThrow(EMPTY_REMARK);
    await r.supprimer(a.id);
    expect(await r.liste()).toEqual([]);
  });
  test("the file has mode 0600 and survives a re-read from disk", async () => {
    const { fichier: file } = await depot();
    await new ReviewComments(file).ajouter(raw);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await new ReviewComments(file).liste())[0]!.texte).toBe("à revoir");
  });
});
