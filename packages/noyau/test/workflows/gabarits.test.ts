import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Le moteur est du JavaScript du conteneur : importé tel quel, sans types.
const CHEMIN = pathToFileURL(join(import.meta.dirname, "..", "..", "docker", "moteur", "gabarits.mjs")).href;
const { remplir } = await import(CHEMIN);

describe("gabarits", () => {
  const element = { titre: "Salut", n: 3, ok: true, a: { b: [{ c: "x" }, "deuxième"] }, objet: { u: 1 }, vide: "", rien: null };
  const config = { interets: "Rust, Svelte", ville: "" };

  it("remplace {titre}, {a.b.1} et {config.interets}", () => {
    expect(remplir("Titre : {titre} ; {a.b.1} ; {config.interets}", { element, config })).toEqual({
      texte: "Titre : Salut ; deuxième ; Rust, Svelte",
    });
    expect(remplir("{a.b.0.c}", { element, config })).toEqual({ texte: "x" });
  });

  it("nombre et booléen en texte, objet en JSON", () => {
    expect(remplir("{n}/{ok}/{objet}", { element, config })).toEqual({ texte: '3/true/{"u":1}' });
  });

  it("dans une URL, chaque valeur est encodée, sauf si le gabarit est un seul {chemin}", () => {
    const e = { q: "a b&c", lien: "https://x.fr/?a=1&b=2" };
    expect(remplir("https://s.fr/?q={q}", { element: e, config: null }, { url: true })).toEqual({ texte: "https://s.fr/?q=a%20b%26c" });
    expect(remplir("{lien}", { element: e, config: null }, { url: true })).toEqual({ texte: "https://x.fr/?a=1&b=2" });
    // Hors URL, rien n'est encodé.
    expect(remplir("{q}", { element: e, config: null })).toEqual({ texte: "a b&c" });
  });

  it("texteMax coupe chaque valeur insérée, pas le gabarit", () => {
    expect(remplir("Début {titre} fin", { element, config }, { texteMax: 3 })).toEqual({ texte: "Début Sal fin" });
  });

  it("une valeur absente, null ou vide rend { absente: chemin }", () => {
    expect(remplir("Météo à {config.ville}", { element, config })).toEqual({ absente: "config.ville" });
    expect(remplir("{inconnu}", { element, config })).toEqual({ absente: "inconnu" });
    expect(remplir("{rien}", { element, config })).toEqual({ absente: "rien" });
    expect(remplir("{vide}", { element, config })).toEqual({ absente: "vide" });
    expect(remplir("{config.x}", { element, config: null })).toEqual({ absente: "config.x" });
    // Pas de lecture par le prototype.
    expect(remplir("{constructor}", { element, config })).toEqual({ absente: "constructor" });
  });

  it("un repère facultatif {chemin?} absent, null ou vide donne une chaîne vide ; présent, il est rempli", () => {
    expect(remplir("Avis.{fiabilite?} Fin", { element, config })).toEqual({ texte: "Avis. Fin" });
    expect(remplir("[{rien?}][{vide?}][{config.ville?}]", { element, config })).toEqual({ texte: "[][][]" });
    expect(remplir("{titre?} {a.b.1?} {config.interets?}", { element, config })).toEqual({ texte: "Salut deuxième Rust, Svelte" });
    // Sans `?`, une valeur absente reste une absence, même à côté d'un repère facultatif.
    expect(remplir("{inconnu?} {fiabilite}", { element, config })).toEqual({ absente: "fiabilite" });
    // Encodé dans une URL comme les autres ; un seul {chemin?} est une URL entière.
    expect(remplir("https://s.fr/?q={titre?}&r={rien?}", { element: { titre: "a b" }, config: null }, { url: true })).toEqual({ texte: "https://s.fr/?q=a%20b&r=" });
    expect(remplir("{lien?}", { element: { lien: "https://x.fr/?a=1" }, config: null }, { url: true })).toEqual({ texte: "https://x.fr/?a=1" });
  });

  it("un texte sans gabarit reste tel quel ; les accolades qui ne sont pas un chemin aussi", () => {
    expect(remplir("rien { ici } {a-b}", { element, config })).toEqual({ texte: "rien { ici } {a-b}" });
  });
});
