import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The engine is the container's JavaScript: imported as is, without types.
const PATH = pathToFileURL(join(import.meta.dirname, "..", "..", "docker", "engine", "templates.mjs")).href;
const { fill } = await import(PATH);

describe("templates", () => {
  const item = { title: "Salut", n: 3, ok: true, a: { b: [{ c: "x" }, "deuxième"] }, object: { u: 1 }, empty: "", nothing: null };
  const config = { interests: "Rust, Svelte", city: "" };

  it("replaces {title}, {a.b.1} and {config.interests}", () => {
    expect(fill("Titre : {title} ; {a.b.1} ; {config.interests}", { item, config })).toEqual({
      text: "Titre : Salut ; deuxième ; Rust, Svelte",
    });
    expect(fill("{a.b.0.c}", { item, config })).toEqual({ text: "x" });
  });

  it("number and boolean as text, object as JSON", () => {
    expect(fill("{n}/{ok}/{object}", { item, config })).toEqual({ text: '3/true/{"u":1}' });
  });

  it("in a URL, each value is encoded, unless the template is a single {path}", () => {
    const e = { q: "a b&c", link: "https://x.fr/?a=1&b=2" };
    expect(fill("https://s.fr/?q={q}", { item: e, config: null }, { url: true })).toEqual({ text: "https://s.fr/?q=a%20b%26c" });
    expect(fill("{link}", { item: e, config: null }, { url: true })).toEqual({ text: "https://x.fr/?a=1&b=2" });
    // Outside a URL, nothing is encoded.
    expect(fill("{q}", { item: e, config: null })).toEqual({ text: "a b&c" });
  });

  it("maxText cuts each inserted value, not the template", () => {
    expect(fill("Début {title} fin", { item, config }, { maxText: 3 })).toEqual({ text: "Début Sal fin" });
  });

  it("an absent, null or empty value returns { missing: path }", () => {
    expect(fill("Météo à {config.city}", { item, config })).toEqual({ missing: "config.city" });
    expect(fill("{inconnu}", { item, config })).toEqual({ missing: "inconnu" });
    expect(fill("{nothing}", { item, config })).toEqual({ missing: "nothing" });
    expect(fill("{empty}", { item, config })).toEqual({ missing: "empty" });
    expect(fill("{config.x}", { item, config: null })).toEqual({ missing: "config.x" });
    // No read through the prototype.
    expect(fill("{constructor}", { item, config })).toEqual({ missing: "constructor" });
  });

  it("an optional marker {path?} that is absent, null or empty gives an empty string; present, it is filled", () => {
    expect(fill("Avis.{fiabilite?} Fin", { item, config })).toEqual({ text: "Avis. Fin" });
    expect(fill("[{nothing?}][{empty?}][{config.city?}]", { item, config })).toEqual({ text: "[][][]" });
    expect(fill("{title?} {a.b.1?} {config.interests?}", { item, config })).toEqual({ text: "Salut deuxième Rust, Svelte" });
    // Without `?`, an absent value stays an absence, even next to an optional marker.
    expect(fill("{inconnu?} {fiabilite}", { item, config })).toEqual({ missing: "fiabilite" });
    // Encoded in a URL like the others; a single {path?} is a whole URL.
    expect(fill("https://s.fr/?q={title?}&r={nothing?}", { item: { title: "a b" }, config: null }, { url: true })).toEqual({ text: "https://s.fr/?q=a%20b&r=" });
    expect(fill("{link?}", { item: { link: "https://x.fr/?a=1" }, config: null }, { url: true })).toEqual({ text: "https://x.fr/?a=1" });
  });

  it("{input} returns the input, even if the item has an input field", () => {
    const e = { input: "de l'élément", title: "T" };
    expect(fill("{input} / {title} / {input?}", { item: e, config: null, input: "clio lyon" })).toEqual({ text: "clio lyon / T / clio lyon" });
    // Only the exact marker: a longer path still reads the item.
    expect(fill("{input.x}", { item: { input: { x: 1 } }, config: null, input: "clio" })).toEqual({ text: "1" });
  });

  it("without a given input, {input} reads the item as before", () => {
    expect(fill("{input}", { item: { input: "de l'élément" }, config: null })).toEqual({ text: "de l'élément" });
    expect(fill("{input}", { item: {}, config: null })).toEqual({ missing: "input" });
    expect(fill("[{input?}]", { item: {}, config: null })).toEqual({ text: "[]" });
  });

  it("{input} in a URL is encoded", () => {
    expect(fill("https://www.leboncoin.fr/recherche?text={input}", { item: null, config: null, input: "clio lyon&co" }, { url: true })).toEqual({
      text: "https://www.leboncoin.fr/recherche?text=clio%20lyon%26co",
    });
  });

  it("a text without a template stays as is; so do braces that are not a path", () => {
    expect(fill("rien { ici } {a-b}", { item, config })).toEqual({ text: "rien { ici } {a-b}" });
  });
});
