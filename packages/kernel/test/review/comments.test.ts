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
function com(start: number, lines: Comment["lines"]): Comment {
  return { id: "c-1", file: "f.txt", start: start, end: start + lines.length - 1, lines, text: "t", created: "", sent: false, resolved: false, lineChanged: false };
}
const L = (mark: " " | "+" | "-", text: string) => ({ mark: mark, text: text });

describe("recoller", () => {
  test("same content, shifted 5 lines by an addition above: re-attached 5 lines lower, ligneChangee false", () => {
    const blocks = parserDiff(patch(15, ctx(["a", "b", "c"])));
    const r = rejoin(com(10, [L(" ", "b"), L(" ", "c")]), blocks);
    expect([r.start, r.end, r.lineChanged]).toEqual([16, 17, false]);
  });
  test("two identical windows: the one closest to the old start wins", () => {
    const blocks = parserDiff(patch(1, ctx(["x", "y", "z", "x", "y"])));
    expect(rejoin(com(5, [L(" ", "x"), L(" ", "y")]), blocks).start).toBe(4);
    expect(rejoin(com(1, [L(" ", "x"), L(" ", "y")]), blocks).start).toBe(1);
  });
  test("modified content: attached to the closest line, ligneChangee true", () => {
    const blocks = parserDiff(patch(1, ctx(["a", "b", "c", "d"])));
    const r = rejoin(com(3, [L(" ", "autre")]), blocks);
    expect([r.start, r.end, r.lineChanged]).toEqual([3, 3, true]);
  });
  test("3-line range with one changed: brought back to one line, ligneChangee true", () => {
    const blocks = parserDiff(patch(1, ctx(["a", "b", "CHANGE", "d"])));
    const r = rejoin(com(1, [L(" ", "a"), L(" ", "b"), L(" ", "c")]), blocks);
    expect([r.start, r.end, r.lineChanged]).toEqual([1, 1, true]);
  });
  test("comment on a « - » line: found again as long as the deletion is displayed", () => {
    const blocks = parserDiff("@@ -1,3 +1,2 @@\n a\n-b\n c\n");
    const r = rejoin(com(2, [L("-", "b")]), blocks);
    expect([r.start, r.lineChanged]).toEqual([2, false]);
  });
  test("window compared on the text alone: a « + » line that became context after a review is found again, ligneChangee false", () => {
    const blocks = parserDiff(patch(20, ctx(["x", "nouveau", "y"])));
    const r = rejoin({ ...com(15, [L("+", "nouveau"), L(" ", "y")]), lineChanged: true }, blocks);
    expect([r.start, r.end, r.lineChanged]).toEqual([21, 22, false]);
  });
  test("without any block: unchanged, ligneChangee true", () => {
    const r = rejoin(com(7, [L(" ", "a")]), []);
    expect([r.start, r.end, r.lineChanged]).toEqual([7, 7, true]);
  });
});

describe("ReviewComments", () => {
  const raw = { file: "f.txt", start: 1, end: 1, lines: [L(" ", "a")], text: "à revoir" };
  async function depot() {
    const folder = await tempFolder();
    return { file: join(folder, "p", "x.comments.json") };
  }

  test("file without a diff (diff null): the comment stays, attached to the file, ligneChangee true", async () => {
    const { file: file } = await depot();
    const r = new ReviewComments(file);
    await r.add(raw);
    await r.add({ ...raw, file: "autre.txt" });
    const res = await r.pasteFile("f.txt", null);
    expect(res).toHaveLength(1);
    expect(res[0]!.lineChanged).toBe(true);
    const all = await r.list();
    expect(all).toHaveLength(2);
    expect(all.find((c) => c.file === "autre.txt")!.lineChanged).toBe(false);
  });
  test("ajouter refuses an empty or whitespace text with EMPTY_REMARK", async () => {
    const r = new ReviewComments((await depot()).file);
    await expect(r.add({ ...raw, text: "" })).rejects.toThrow(EMPTY_REMARK);
    await expect(r.add({ ...raw, text: "  \n " })).rejects.toThrow(EMPTY_REMARK);
    expect(await r.list()).toEqual([]);
  });
  test("aEnvoyer returns the unresolved ones, sent included; after marquerEnvoyes, envoye true; a resolved one is never returned", async () => {
    const r = new ReviewComments((await depot()).file);
    const a = await r.add(raw);
    const b = await r.add(raw);
    expect((await r.toSend()).map((c) => c.id)).toEqual([a.id, b.id]);
    await r.markSent([a.id]);
    const after = await r.toSend();
    expect(after.map((c) => c.sent)).toEqual([true, false]);
    await r.resolve(a.id, true);
    expect((await r.toSend()).map((c) => c.id)).toEqual([b.id]);
  });
  test("apresRelu deletes the resolved ones and keeps the unresolved ones", async () => {
    const r = new ReviewComments((await depot()).file);
    const a = await r.add(raw);
    const b = await r.add(raw);
    await r.resolve(a.id, true);
    await r.afterReviewed();
    expect((await r.list()).map((c) => c.id)).toEqual([b.id]);
  });
  test("marquerEnvoyesSiInchanges: a comment modified since the read is not marked sent", async () => {
    const r = new ReviewComments((await depot()).file);
    const a = await r.add(raw);
    const b = await r.add(raw);
    const reads = await r.toSend();
    await r.edit(b.id, "texte changé");
    await r.markSentIfUnchanged(reads.map((c) => ({ id: c.id, text: c.text })));
    const l = await r.list();
    expect(l.find((c) => c.id === a.id)!.sent).toBe(true);
    expect(l.find((c) => c.id === b.id)).toMatchObject({ sent: false, text: "texte changé" });
  });
  test("modify and delete", async () => {
    const r = new ReviewComments((await depot()).file);
    const a = await r.add(raw);
    await r.edit(a.id, "autre");
    expect((await r.list())[0]!.text).toBe("autre");
    await expect(r.edit(a.id, " ")).rejects.toThrow(EMPTY_REMARK);
    await r.delete(a.id);
    expect(await r.list()).toEqual([]);
  });
  test("the file has mode 0600 and survives a re-read from disk", async () => {
    const { file: file } = await depot();
    await new ReviewComments(file).add(raw);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await new ReviewComments(file).list())[0]!.text).toBe("à revoir");
  });
});
