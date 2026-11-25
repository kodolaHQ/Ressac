import { describe, expect, it } from "vitest";
import { drafts, propose, splitName } from "../chrome/passport/import-choice";
import { parseAddress } from "../chrome/shims/kernel";
import type { FoundAddress } from "../chrome/passport/addresses";

const line = (o: Partial<FoundAddress>): FoundAddress => ({ given: "", family: "", full: "", street: "", postcode: "", city: "", country: "", tel: "", email: "", usedAt: 0, useCount: 0, ...o });
const camille = { given: "Camille", family: "Aubrac" };
const year = (y: number) => Date.UTC(y, 0, 1);

describe("propose", () => {
  it("one line ticked: the user's most complete, most recent address", () => {
    const { proposals } = propose([
      line({ ...camille, street: "3 rue Vieille", postcode: "75003", city: "Paris", usedAt: year(2019) }),
      line({ ...camille, street: "14 rue des Tanneurs", postcode: "69001", city: "Lyon", tel: "+33612345678", usedAt: year(2026) }),
      line({ ...camille, street: "8 quai Bas", postcode: "69002", city: "Lyon", usedAt: year(2025) }),
      line({ given: "Jean", family: "Aubrac", street: "1 rue Autre", postcode: "13001", city: "Marseille", usedAt: year(2026) }),
    ]);
    const ticked = proposals.filter((p) => p.ticked);
    expect(ticked).toHaveLength(1);
    expect(ticked[0]!.address).toContain("14 rue des Tanneurs");
    const jean = proposals.find((p) => p.given === "Jean")!;
    expect(jean).toMatchObject({ other: true, ticked: false });
  });

  it("a partial address is not proposed", () => {
    const r = propose([line({ city: "Paris" }), line({ street: "12 rue" }), line({ ...camille, street: "12 rue" })]);
    expect(r.incomplete).toBe(2);
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0]).toMatchObject({ given: "Camille", address: "" });
  });

  it("duplicates across profiles merge", () => {
    const base = { ...camille, street: "14 rue des Tanneurs", postcode: "69001", city: "Lyon" };
    expect(propose([line({ ...base, usedAt: 1 }), line({ ...base, usedAt: 2 })]).proposals).toHaveLength(1);
  });

  it("splits a full name when given and family are missing", () => {
    const { proposals } = propose([line({ full: "Camille Aubrac", street: "14 rue des Tanneurs", city: "Lyon" })]);
    expect(proposals[0]).toMatchObject({ given: "Camille", family: "Aubrac" });
    expect(splitName("Jean Pierre Dupont").family).toBe("Dupont");
  });

  it("address text round-trips through parseAddress", () => {
    const { proposals } = propose([line({ ...camille, street: "14 rue des Tanneurs", postcode: "69001", city: "Lyon" })]);
    expect(parseAddress(proposals[0]!.address)).toEqual({ street: "14 rue des Tanneurs", postcode: "69001", city: "Lyon" });
  });
});

describe("drafts", () => {
  const p = { key: "k", given: "Camille", family: "Aubrac", address: "14 rue des Tanneurs\n69001 Lyon", tel: "", email: "c@a.fr", ticked: true, other: false };
  it("as me: name, address, email, no empty phone", () => {
    expect(drafts(p, "me").map((d) => d.field)).toEqual(["nom", "adresse", "email"]);
  });
  it("drafts as proche keep only the name", () => {
    expect(drafts(p, "proche")).toEqual([{ field: "proche", value: { given: "Camille", family: "Aubrac" } }]);
  });
});
