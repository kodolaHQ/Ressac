import { expect, test, vi } from "vitest";
import { ProfilRefuse } from "@webaios/noyau";
import type { EtatNavigateur } from "../src/commun/modele";

vi.mock("electron", () => ({
  session: { fromPartition: vi.fn() },
  BrowserWindow: vi.fn(),
}));

const { lirePageInvisible, profilsLisibles, urlPermise } = await import("../src/main/agent/lecture-invisible");

const etat = (profils: string[], espaces: { profil: string; prive: boolean }[]) =>
  ({ profils: profils.map((id) => ({ id })), espaces: espaces.map((e, i) => ({ id: `e${i}`, ...e })) }) as unknown as EtatNavigateur;

test("profilsLisibles exclut les profils d'un espace privé, même partagés avec un espace non privé", () => {
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

test("lirePageInvisible refuse un profil privé ou inconnu (ProfilRefuse) sans créer de vue", async () => {
  const e = etat(["defaut", "secret"], [
    { profil: "defaut", prive: false },
    { profil: "secret", prive: true },
  ]);
  const deps = { etat: () => e, sessionProfil: vi.fn(), sessionPublique: vi.fn(), creerFenetre: vi.fn() };
  for (const profil of ["secret", "inconnu"]) {
    const r = lirePageInvisible("https://exemple.test/", { profil }, deps);
    await expect(r).rejects.toBeInstanceOf(ProfilRefuse);
    await expect(r).rejects.toMatchObject({ profil });
  }
  expect(deps.sessionProfil).not.toHaveBeenCalled();
  expect(deps.sessionPublique).not.toHaveBeenCalled();
  expect(deps.creerFenetre).not.toHaveBeenCalled();
});

test("lirePageInvisible refuse une URL qui n'est pas http(s), ou hors des domaines, sans créer de vue", async () => {
  const e = etat(["defaut"], [{ profil: "defaut", prive: false }]);
  const deps = { etat: () => e, sessionProfil: vi.fn(), sessionPublique: vi.fn(), creerFenetre: vi.fn() };
  await expect(lirePageInvisible("file:///etc/passwd", { profil: null }, deps)).rejects.toThrow();
  await expect(lirePageInvisible("https://ailleurs.test/", { profil: "defaut", domaines: ["exemple.test"] }, deps)).rejects.toThrow();
  expect(deps.creerFenetre).not.toHaveBeenCalled();
});

test("urlPermise : http(s) seulement ; avec domaines, l'hôte exact (point final ignoré), comme le noyau", () => {
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
