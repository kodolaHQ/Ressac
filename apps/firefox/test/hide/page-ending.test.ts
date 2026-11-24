import { describe, expect, it } from "vitest";
import { ending, maskedOnPage, settleSite } from "../../chrome/window/hide-layer";

// « Cacher pour l'agent »: the toast says « Masqué pour l'agent » only when the page, as the agent reads it, masks the
// value; and the passport holds what the toast says when the agent reached the tab during the bubble or Touch ID.
describe("maskedOnPage", () => {
  const run = (start: number, end: number) => ({ start, end });

  it("every occurrence covered, in any document: masked", () => {
    expect(maskedOnPage([{ text: "Client : Camille Aubrac", runs: [run(9, 23)] }], "Camille Aubrac", "nom")).toBe(true);
    expect(maskedOnPage([{ text: "Menu", runs: [] }, { text: "Camille Aubrac", runs: [run(0, 14)] }], "Camille Aubrac", "nom")).toBe(true);
  });

  it("a neighbour glued to the value (no run on the page text): not masked, though the value alone is", () => {
    expect(maskedOnPage([{ text: "Client:Camille AubracRef", runs: [] }], "Camille Aubrac", "nom")).toBe(false);
    expect(maskedOnPage([{ text: "14 rue des Tanneurs 14Z", runs: [] }], "rue des Tanneurs 14", "adresse")).toBe(false);
  });

  it("one occurrence covered, another not (in another document too): not masked", () => {
    expect(maskedOnPage([{ text: "Camille Aubrac / Camille AubracRef", runs: [run(0, 14)] }], "Camille Aubrac", "nom")).toBe(false);
    expect(maskedOnPage([{ text: "Camille Aubrac", runs: [run(0, 14)] }, { text: "x Camille Aubrac", runs: [] }], "Camille Aubrac", "nom")).toBe(false);
  });

  it("case and spacing aside: the page's other case and line break count as occurrences", () => {
    expect(maskedOnPage([{ text: "camille\n  AUBRAC", runs: [] }], "Camille Aubrac", "nom")).toBe(false);
    expect(maskedOnPage([{ text: "camille\n  AUBRAC", runs: [run(0, 16)] }], "Camille Aubrac", "nom")).toBe(true);
  });

  it("no occurrence (the page changed) or an empty value: not masked; an e-mail needs only its local part", () => {
    expect(maskedOnPage([{ text: "Autre Personne", runs: [run(0, 14)] }], "Camille Aubrac", "nom")).toBe(false);
    expect(maskedOnPage([{ text: "x", runs: [run(0, 1)] }], "  ", "libre")).toBe(false);
    expect(maskedOnPage([{ text: "a.b@exemple.fr (c)", runs: [run(0, 3)] }], "a.b@exemple.fr", "email")).toBe(true);
    expect(maskedOnPage([{ text: "a.b@exemple.fr (c)", runs: [run(0, 2)] }], "a.b@exemple.fr", "email")).toBe(false);
    expect(maskedOnPage([{ text: "1+1 (x)", runs: [run(0, 3)] }], "1+1", "libre")).toBe(true);
  });

  it("the ending: covered alone but not on the page ends on notHere, never hidden", () => {
    const o = { agentReached: false, runs: [run(0, 14)], length: 14, siteMatches: true };
    expect(ending({ ...o, onPage: false })).toBe("notHere");
    expect(ending({ ...o, onPage: true })).toBe("hidden");
    expect(ending({ ...o, runs: [], onPage: false })).toBe("next");
  });
});

describe("settleSite", () => {
  const added = { ok: true as const, id: "e1", created: true, addedOrigin: true, updated: "t" };

  it("the agent reached the tab by the save: the added site is taken back, the result adds no site", async () => {
    let taken = 0;
    expect(await settleSite(added, true, async () => (taken++, true))).toEqual({ ...added, addedOrigin: false });
    expect(taken).toBe(1);
  });

  it("taking it back failed: a write error, never a silent site", async () => {
    expect(await settleSite(added, true, async () => false)).toEqual({ ok: false, error: "write" });
  });

  it("not reached, no site added, or a failed hide: unchanged, nothing taken back", async () => {
    const never = async () => {
      throw new Error("taken back");
    };
    expect(await settleSite(added, false, never)).toBe(added);
    const noSite = { ...added, addedOrigin: false };
    expect(await settleSite(noSite, true, never)).toBe(noSite);
    const failed = { ok: false as const, error: "cancelled" as const };
    expect(await settleSite(failed, true, never)).toBe(failed);
  });
});
