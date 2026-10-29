import { describe, it, expect } from "vitest";
import { compterNouveaux, elementsDe, identite, texteNotification } from "../../src/widgets/nouveautes.js";

describe("nouveautes", () => {
  it("identité par url, sinon JSON canonique (ordre des clés indifférent)", () => {
    expect(identite({ url: "https://a.example/1", titre: "x" })).toBe(identite({ titre: "autre", url: "https://a.example/1" }));
    expect(identite({ url: "https://a.example/1" })).not.toBe(identite({ url: "https://a.example/2" }));
    expect(identite({ a: 1, b: { c: 2, d: 3 } })).toBe(identite({ b: { d: 3, c: 2 }, a: 1 }));
    expect(identite({ a: 1 })).not.toBe(identite({ a: 2 }));
    // Une url qui n'est pas du texte ne compte pas comme url.
    expect(identite({ url: 1, a: 1 })).toBe(identite({ a: 1, url: 1 }));
    expect(identite({ url: 1 })).not.toBe(identite({ url: 2 }));
    expect(identite("texte")).toBe(identite("texte"));
  });

  it("données objet { annonces: [...] } : ses éléments comptent", () => {
    expect(elementsDe([1, 2])).toEqual([1, 2]);
    expect(elementsDe({ annonces: [{ id: 1 }, { id: 2 }], titre: "x", autres: [{ id: 3 }] })).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(elementsDe(null)).toEqual([]);
    expect(elementsDe("texte")).toEqual([]);
    expect(elementsDe({ titre: "x" })).toEqual([]);
    const avant = { annonces: [{ url: "https://a.example/1", prix: 10 }] };
    const apres = { annonces: [{ url: "https://a.example/1", prix: 12 }, { url: "https://a.example/2" }, { url: "https://a.example/3" }] };
    expect(compterNouveaux(avant, apres)).toBe(2);
    expect(compterNouveaux(null, apres)).toBe(3);
    expect(compterNouveaux(apres, apres)).toBe(0);
    // Deux fois le même élément : un seul nouveau.
    expect(compterNouveaux([], [{ a: 1 }, { a: 1 }])).toBe(1);
  });

  it("texteNotification(1) et (7)", () => {
    expect(texteNotification(1)).toBe("1 nouvel élément");
    expect(texteNotification(7)).toBe("7 nouveaux éléments");
  });
});
