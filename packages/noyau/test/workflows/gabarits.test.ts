import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The engine is the container's JavaScript: imported as is, without types.
const CHEMIN = pathToFileURL(join(import.meta.dirname, "..", "..", "docker", "moteur", "gabarits.mjs")).href;
const { remplir } = await import(CHEMIN);

describe("gabarits", () => {
  const element = { titre: "Salut", n: 3, ok: true, a: { b: [{ c: "x" }, "deuxième"] }, objet: { u: 1 }, vide: "", rien: null };
  const config = { interets: "Rust, Svelte", ville: "" };

  it("replaces {titre}, {a.b.1} and {config.interets}", () => {
    expect(remplir("Titre : {titre} ; {a.b.1} ; {config.interets}", { element, config })).toEqual({
      texte: "Titre : Salut ; deuxième ; Rust, Svelte",
    });
    expect(remplir("{a.b.0.c}", { element, config })).toEqual({ texte: "x" });
  });

  it("number and boolean as text, object as JSON", () => {
    expect(remplir("{n}/{ok}/{objet}", { element, config })).toEqual({ texte: '3/true/{"u":1}' });
  });

  it("in a URL, each value is encoded, unless the template is a single {chemin}", () => {
    const e = { q: "a b&c", lien: "https://x.fr/?a=1&b=2" };
    expect(remplir("https://s.fr/?q={q}", { element: e, config: null }, { url: true })).toEqual({ texte: "https://s.fr/?q=a%20b%26c" });
    expect(remplir("{lien}", { element: e, config: null }, { url: true })).toEqual({ texte: "https://x.fr/?a=1&b=2" });
    // Outside a URL, nothing is encoded.
    expect(remplir("{q}", { element: e, config: null })).toEqual({ texte: "a b&c" });
  });

  it("texteMax cuts each inserted value, not the template", () => {
    expect(remplir("Début {titre} fin", { element, config }, { texteMax: 3 })).toEqual({ texte: "Début Sal fin" });
  });

  it("an absent, null or empty value returns { absente: chemin }", () => {
    expect(remplir("Météo à {config.ville}", { element, config })).toEqual({ absente: "config.ville" });
    expect(remplir("{inconnu}", { element, config })).toEqual({ absente: "inconnu" });
    expect(remplir("{rien}", { element, config })).toEqual({ absente: "rien" });
    expect(remplir("{vide}", { element, config })).toEqual({ absente: "vide" });
    expect(remplir("{config.x}", { element, config: null })).toEqual({ absente: "config.x" });
    // No read through the prototype.
    expect(remplir("{constructor}", { element, config })).toEqual({ absente: "constructor" });
  });

  it("an optional marker {chemin?} that is absent, null or empty gives an empty string; present, it is filled", () => {
    expect(remplir("Avis.{fiabilite?} Fin", { element, config })).toEqual({ texte: "Avis. Fin" });
    expect(remplir("[{rien?}][{vide?}][{config.ville?}]", { element, config })).toEqual({ texte: "[][][]" });
    expect(remplir("{titre?} {a.b.1?} {config.interets?}", { element, config })).toEqual({ texte: "Salut deuxième Rust, Svelte" });
    // Without `?`, an absent value stays an absence, even next to an optional marker.
    expect(remplir("{inconnu?} {fiabilite}", { element, config })).toEqual({ absente: "fiabilite" });
    // Encoded in a URL like the others; a single {chemin?} is a whole URL.
    expect(remplir("https://s.fr/?q={titre?}&r={rien?}", { element: { titre: "a b" }, config: null }, { url: true })).toEqual({ texte: "https://s.fr/?q=a%20b&r=" });
    expect(remplir("{lien?}", { element: { lien: "https://x.fr/?a=1" }, config: null }, { url: true })).toEqual({ texte: "https://x.fr/?a=1" });
  });

  it("{saisie} returns the input, even if the element has a saisie field", () => {
    const e = { saisie: "de l'élément", titre: "T" };
    expect(remplir("{saisie} / {titre} / {saisie?}", { element: e, config: null, saisie: "clio lyon" })).toEqual({ texte: "clio lyon / T / clio lyon" });
    // Only the exact marker: a longer path still reads the element.
    expect(remplir("{saisie.x}", { element: { saisie: { x: 1 } }, config: null, saisie: "clio" })).toEqual({ texte: "1" });
  });

  it("without a given input, {saisie} reads the element as before", () => {
    expect(remplir("{saisie}", { element: { saisie: "de l'élément" }, config: null })).toEqual({ texte: "de l'élément" });
    expect(remplir("{saisie}", { element: {}, config: null })).toEqual({ absente: "saisie" });
    expect(remplir("[{saisie?}]", { element: {}, config: null })).toEqual({ texte: "[]" });
  });

  it("{saisie} in a URL is encoded", () => {
    expect(remplir("https://www.leboncoin.fr/recherche?text={saisie}", { element: null, config: null, saisie: "clio lyon&co" }, { url: true })).toEqual({
      texte: "https://www.leboncoin.fr/recherche?text=clio%20lyon%26co",
    });
  });

  it("a text without a template stays as is; so do braces that are not a path", () => {
    expect(remplir("rien { ici } {a-b}", { element, config })).toEqual({ texte: "rien { ici } {a-b}" });
  });
});
