import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The engine is the container's JavaScript: imported as is, without types.
const PATH = pathToFileURL(join(import.meta.dirname, "..", "..", "docker", "moteur", "gabarits.mjs")).href;
const { remplir: fill } = await import(PATH);

describe("gabarits", () => {
  const element = { title: "Salut", n: 3, ok: true, a: { b: [{ c: "x" }, "deuxième"] }, object: { u: 1 }, empty: "", nothing: null };
  const config = { interests: "Rust, Svelte", city: "" };

  it("replaces {titre}, {a.b.1} and {config.interets}", () => {
    expect(fill("Titre : {titre} ; {a.b.1} ; {config.interets}", { element, config })).toEqual({
      text: "Titre : Salut ; deuxième ; Rust, Svelte",
    });
    expect(fill("{a.b.0.c}", { element, config })).toEqual({ text: "x" });
  });

  it("number and boolean as text, object as JSON", () => {
    expect(fill("{n}/{ok}/{objet}", { element, config })).toEqual({ text: '3/true/{"u":1}' });
  });

  it("in a URL, each value is encoded, unless the template is a single {chemin}", () => {
    const e = { q: "a b&c", link: "https://x.fr/?a=1&b=2" };
    expect(fill("https://s.fr/?q={q}", { element: e, config: null }, { url: true })).toEqual({ text: "https://s.fr/?q=a%20b%26c" });
    expect(fill("{lien}", { element: e, config: null }, { url: true })).toEqual({ text: "https://x.fr/?a=1&b=2" });
    // Outside a URL, nothing is encoded.
    expect(fill("{q}", { element: e, config: null })).toEqual({ text: "a b&c" });
  });

  it("texteMax cuts each inserted value, not the template", () => {
    expect(fill("Début {titre} fin", { element, config }, { maxText: 3 })).toEqual({ text: "Début Sal fin" });
  });

  it("an absent, null or empty value returns { absente: chemin }", () => {
    expect(fill("Météo à {config.ville}", { element, config })).toEqual({ absent: "config.ville" });
    expect(fill("{inconnu}", { element, config })).toEqual({ absent: "inconnu" });
    expect(fill("{rien}", { element, config })).toEqual({ absent: "rien" });
    expect(fill("{vide}", { element, config })).toEqual({ absent: "vide" });
    expect(fill("{config.x}", { element, config: null })).toEqual({ absent: "config.x" });
    // No read through the prototype.
    expect(fill("{constructor}", { element, config })).toEqual({ absent: "constructor" });
  });

  it("an optional marker {chemin?} that is absent, null or empty gives an empty string; present, it is filled", () => {
    expect(fill("Avis.{fiabilite?} Fin", { element, config })).toEqual({ text: "Avis. Fin" });
    expect(fill("[{rien?}][{vide?}][{config.ville?}]", { element, config })).toEqual({ text: "[][][]" });
    expect(fill("{titre?} {a.b.1?} {config.interets?}", { element, config })).toEqual({ text: "Salut deuxième Rust, Svelte" });
    // Without `?`, an absent value stays an absence, even next to an optional marker.
    expect(fill("{inconnu?} {fiabilite}", { element, config })).toEqual({ absent: "fiabilite" });
    // Encoded in a URL like the others; a single {chemin?} is a whole URL.
    expect(fill("https://s.fr/?q={titre?}&r={rien?}", { element: { title: "a b" }, config: null }, { url: true })).toEqual({ text: "https://s.fr/?q=a%20b&r=" });
    expect(fill("{lien?}", { element: { link: "https://x.fr/?a=1" }, config: null }, { url: true })).toEqual({ text: "https://x.fr/?a=1" });
  });

  it("{saisie} returns the input, even if the element has a saisie field", () => {
    const e = { input: "de l'élément", title: "T" };
    expect(fill("{saisie} / {titre} / {saisie?}", { element: e, config: null, input: "clio lyon" })).toEqual({ text: "clio lyon / T / clio lyon" });
    // Only the exact marker: a longer path still reads the element.
    expect(fill("{saisie.x}", { element: { input: { x: 1 } }, config: null, input: "clio" })).toEqual({ text: "1" });
  });

  it("without a given input, {saisie} reads the element as before", () => {
    expect(fill("{saisie}", { element: { input: "de l'élément" }, config: null })).toEqual({ text: "de l'élément" });
    expect(fill("{saisie}", { element: {}, config: null })).toEqual({ absent: "saisie" });
    expect(fill("[{saisie?}]", { element: {}, config: null })).toEqual({ text: "[]" });
  });

  it("{saisie} in a URL is encoded", () => {
    expect(fill("https://www.leboncoin.fr/recherche?text={saisie}", { element: null, config: null, input: "clio lyon&co" }, { url: true })).toEqual({
      text: "https://www.leboncoin.fr/recherche?text=clio%20lyon%26co",
    });
  });

  it("a text without a template stays as is; so do braces that are not a path", () => {
    expect(fill("rien { ici } {a-b}", { element, config })).toEqual({ text: "rien { ici } {a-b}" });
  });
});
