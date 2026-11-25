import { describe, expect, it } from "vitest";
import { suggestion } from "../chrome/passport/form-capture";
import { parseAddress } from "../chrome/shims/kernel";
import type { Draft } from "../chrome/passport/import-choice";

const record = { "given-name": "Camille", "family-name": "Aubrac", "street-address": "14 rue des Tanneurs", "postal-code": "69001", "address-level2": "Lyon", tel: "06 12 34 56 78", email: "camille@example.fr", country: "FR" };
const all = new Set(Object.values(record));
const ctx = { agentReached: false as boolean | undefined, privateSpace: false, https: true, siteApp: false, passportReadable: true, suggest: true, siteMuted: false, known: (_d: Draft) => false };

describe("suggestion", () => {
  it("only typed values are proposed", () => {
    const d = suggestion({ ...record, email: " camille@example.fr " }, new Set(["Camille", "Aubrac", "camille@example.fr"]), ctx);
    expect(d).toEqual([
      { field: "nom", value: { given: "Camille", family: "Aubrac" } },
      { field: "email", value: { text: "camille@example.fr" } },
    ]);
    expect(suggestion(record, new Set(), ctx)).toBeNull();
    // A value the page filled (not typed) is left out even when its neighbours were typed.
    expect(suggestion({ ...record, email: "piege@example.fr" }, new Set(["camille@example.fr"]), ctx)).toBeNull();
  });

  it("an agent-reached or unknown tab gets nothing", () => {
    expect(suggestion(record, all, { ...ctx, agentReached: true })).toBeNull();
    expect(suggestion(record, all, { ...ctx, agentReached: undefined })).toBeNull();
  });

  it("private, http, site app, unreadable passport, muted, off → nothing", () => {
    for (const k of [{ privateSpace: true }, { https: false }, { siteApp: true }, { passportReadable: false }, { siteMuted: true }, { suggest: false }]) expect(suggestion(record, all, { ...ctx, ...k })).toBeNull();
    expect(suggestion(record, all, ctx)).not.toBeNull();
  });

  it("all known → nothing", () => {
    expect(suggestion(record, all, { ...ctx, known: () => true })).toBeNull();
    const d = suggestion(record, all, { ...ctx, known: (x) => x.field !== "tel" });
    expect(d).toEqual([{ field: "tel", value: { text: "06 12 34 56 78" } }]);
  });

  it("name and address split into drafts", () => {
    const d = suggestion({ name: "Camille AUBRAC", "street-address": "14 rue des Tanneurs", "postal-code": "69001", "address-level2": "Lyon" }, new Set(["Camille AUBRAC", "14 rue des Tanneurs", "69001", "Lyon"]), ctx)!;
    expect(d[0]).toEqual({ field: "nom", value: { given: "Camille", family: "AUBRAC" } });
    expect(d[1]!.field).toBe("adresse");
    const text = (d[1]!.value as { text: string }).text;
    expect(parseAddress(text)).toEqual({ street: "14 rue des Tanneurs", postcode: "69001", city: "Lyon" });
    // A street without its town is no address.
    expect(suggestion({ "street-address": "14 rue des Tanneurs" }, new Set(["14 rue des Tanneurs"]), ctx)).toBeNull();
  });
});
