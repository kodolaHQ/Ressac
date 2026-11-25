import { describe, expect, it } from "vitest";
import { doneText, suggestion } from "../chrome/passport/form-capture";
import { parseAddress } from "../../../packages/kernel/src/mask/passport-fields";
import type { Draft } from "../chrome/passport/import-choice";
import { typedFields } from "../chrome/passport/typed-fields";

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

describe("suggestion validation", () => {
  it("a value the passport refuses is not on the bar", () => {
    const d = suggestion({ ...record, tel: "12", email: "pas-un-mail" }, new Set([...all, "12", "pas-un-mail"]), ctx)!;
    expect(d.map((x) => x.field)).toEqual(["nom", "adresse"]);
    expect(suggestion({ email: "pas-un-mail" }, new Set(["pas-un-mail"]), ctx)).toBeNull();
  });

  it("the done notice never hides what was not added", () => {
    const l = (id: string, a?: Record<string, string | number>) => `${id}${a ? `:${a.n}` : ""}`;
    expect(doneText({ ok: true, added: 1, variants: 0, full: 0, invalid: 0 }, l)).toBe("settings-passport-import-done:1");
    expect(doneText({ ok: true, added: 1, variants: 0, full: 0, invalid: 2 }, l)).toBe("settings-passport-import-done:1 settings-passport-import-invalid:2");
    expect(doneText({ ok: true, added: 0, variants: 0, full: 0, invalid: 1 }, l)).toBe("settings-passport-import-invalid:1");
    expect(doneText({ ok: true, added: 0, variants: 0, full: 0, invalid: 0 }, l)).toBe("settings-passport-import-nothing");
    expect(doneText({ ok: false, error: "write" }, l)).toBe("settings-passport-import-error");
  });
});

describe("typedFields", () => {
  const field = (value = "") => ({ value });

  it("a keydown then its input counts", () => {
    const t = typedFields<{ value: string }>(), el = field();
    t.arm(el, true);
    el.value = "Camille";
    t.input(el, true, "insertText");
    expect(t.take()).toEqual(["Camille"]);
    // Read once: a form detected again offers nothing more.
    expect(t.take()).toEqual([]);
  });

  it("a paste or a drop arms too, a keydown arms one input only", () => {
    const t = typedFields<{ value: string }>(), a = field(), b = field();
    t.arm(a, true);
    a.value = "14 rue des Tanneurs";
    t.input(a, true, "insertFromPaste");
    t.arm(b, true);
    b.value = "Lyon";
    t.input(b, true, "insertFromDrop");
    expect(t.take()).toEqual(["14 rue des Tanneurs", "Lyon"]);
    t.arm(a, true);
    a.value = "x";
    t.input(a, true, "insertText");
    a.value = "xy";
    t.input(a, true, "insertText");
    expect(t.take()).toEqual([]);
  });

  it("an input alone, an execCommand, an autofill or an untrusted key never counts", () => {
    const t = typedFields<{ value: string }>(), el = field("Piège");
    t.input(el, true, "insertText"); // execCommand("insertText") by the page: trusted, no keydown
    t.arm(el, false);
    t.input(el, true, "insertText");
    t.arm(el, true);
    t.input(el, true, "insertReplacementText"); // Firefox's autofill after a key in its dropdown
    t.arm(el, true);
    t.input(el, false, "insertText");
    t.arm(el, true);
    t.input(el, true, undefined); // a plain Event("input") from privileged code (fill_field)
    expect(t.take()).toEqual([]);
  });

  it("keydown, focusout, then input does not count", () => {
    const t = typedFields<{ value: string }>(), el = field();
    t.arm(el, true); // Tab: its keydown lands on the field being left
    t.disarm(el);
    el.value = "Piège";
    t.input(el, true, "insertText"); // the page's execCommand later
    expect(t.take()).toEqual([]);
  });

  it("keydown, keyup, then input does not count", () => {
    const t = typedFields<{ value: string }>(), el = field();
    t.arm(el, true); // Enter: its keydown runs the submit
    t.disarm(el);
    el.value = "Piège";
    t.input(el, true, "insertText");
    expect(t.take()).toEqual([]);
  });

  it("keydown, input, keyup counts", () => {
    const t = typedFields<{ value: string }>(), el = field();
    t.arm(el, true);
    el.value = "C";
    t.input(el, true, "insertCompositionText");
    t.disarm(el);
    expect(t.take()).toEqual(["C"]);
  });

  it("a later change removes the value", () => {
    const t = typedFields<{ value: string }>(), a = field(), b = field();
    for (const el of [a, b]) {
      t.arm(el, true);
      el.value = "Camille";
      t.input(el, true, "insertText");
    }
    a.value = "Autre"; // a script, without any event
    t.input(b, false, "insertText"); // an untrusted input
    expect(t.take()).toEqual([]);
  });
});
