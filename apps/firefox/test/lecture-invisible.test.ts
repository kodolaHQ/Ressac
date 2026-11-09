import { expect, test } from "vitest";
import type { EtatNavigateur } from "../shared/modele";
import { cumulerParties, profilsLisibles, urlPermise } from "../core/agent/lecture-invisible";

const etat = (profils: string[], espaces: { profil: string; prive: boolean }[]) =>
  ({ profils: profils.map((id) => ({ id })), espaces: espaces.map((e, i) => ({ id: `e${i}`, ...e })) }) as unknown as EtatNavigateur;

test("profilsLisibles excludes a private space's profiles, even shared with a non-private space", () => {
  const e = etat(
    ["defaut", "travail", "secret", "libre"],
    [
      { profil: "defaut", prive: false },
      { profil: "travail", prive: false },
      { profil: "travail", prive: true },
      { profil: "secret", prive: true },
    ],
  );
  expect(profilsLisibles(e)).toEqual(["defaut", "libre"]);
});

test("urlPermise: http(s) only; with domains, the exact host (trailing dot ignored), like the kernel", () => {
  expect(urlPermise("https://exemple.test/a", undefined)).toBe(true);
  expect(urlPermise("javascript:alert(1)", undefined)).toBe(false);
  expect(urlPermise("pas une url", undefined)).toBe(false);
  expect(urlPermise("https://exemple.test./a", ["exemple.test"])).toBe(true);
  expect(urlPermise("https://EXEMPLE.test/a", ["exemple.test."])).toBe(true);
  expect(urlPermise("https://autre.test/", ["exemple.test"])).toBe(false);
  expect(urlPermise("https://exemple.test.autre.test/", ["exemple.test"])).toBe(false);
  expect(urlPermise("https://www.exemple.test/", ["exemple.test"])).toBe(false);
  expect(urlPermise("data:text/html,x", ["exemple.test"])).toBe(false);
});

test("urlPermise refuses local addresses, except for the tests option", () => {
  for (const u of ["http://localhost./", "http://localhost:11434/api", "http://127.0.0.1:11434/", "http://192.168.1.1/", "http://[::1]/", "http://10.0.0.2/", "http://box.local/"]) {
    expect(urlPermise(u, undefined), u).toBe(false);
    expect(urlPermise(u, undefined, true), u).toBe(true);
  }
  expect(urlPermise("http://127.0.0.1/", ["127.0.0.1"])).toBe(false);
  expect(urlPermise("http://127.0.0.1/", ["127.0.0.1"], true)).toBe(true);
  expect(urlPermise("https://exemple.test/", undefined, false)).toBe(true);
});

test("cumulerParties: lines kept once in order of appearance, links by address with the longest text", () => {
  const r = cumulerParties([
    { titre: "A", texte: "en-tête\nx\n10 €\ny", liens: [{ url: "https://e.test/1", texte: "court" }] },
    { titre: "B", texte: "en-tête\nx\n10 €\ny", liens: [{ url: "https://e.test/1", texte: "plus long" }] },
    { titre: "C", texte: "en-tête\nz\n10 €\nw", liens: [{ url: "https://e.test/2", texte: "deux" }, { url: 3 }] },
  ]);
  expect(r.titre).toBe("C");
  expect(r.texte).toBe("en-tête\nx\n10 €\ny\nz\n10 €\nw");
  expect(r.liens).toEqual([
    { url: "https://e.test/1", texte: "plus long" },
    { url: "https://e.test/2", texte: "deux" },
  ]);
});

test("cumulerParties: a list that advances (virtualized) is realigned on what it shares with the previous snapshot, identical prices kept", () => {
  const r = cumulerParties([
    { titre: "T", texte: "En-tête\nA1\n4 500 €\nA2\n4 500 €\nChargement…", liens: [] },
    // A1 left the page; A2 is still there; A3 and A4 arrive, at the same price.
    { titre: "T", texte: "En-tête\nA2\n4 500 €\nA3\n4 500 €\nA4\n4 500 €", liens: [] },
    // Nothing new: the page no longer moved.
    { titre: "T", texte: "En-tête\nA2\n4 500 €\nA3\n4 500 €\nA4\n4 500 €", liens: [] },
  ]);
  expect(r.texte).toBe("En-tête\nA1\n4 500 €\nA2\n4 500 €\nChargement…\nA3\n4 500 €\nA4\n4 500 €");
});
