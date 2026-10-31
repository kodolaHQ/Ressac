import { expect, test } from "vitest";
import { decisionNavigation, decisionOuverture, erreurDeReseau, type ContexteNavigation } from "../../src/main/sites/navigation";

const c: ContexteNavigation = { domaines: ["vidola-a.example"], connexion: ["accounts.google.com"] };

test("cadre principal : le site et ses sous-domaines sont suivis, le reste bloqué", () => {
  expect(decisionNavigation("https://www.vidola-a.example/x", c)).toBe("suivre");
  expect(decisionNavigation("https://vidola-a.example/", c)).toBe("suivre");
  expect(decisionNavigation("https://pub.example/", c)).toBe("bloquer");
  // Le nom du site dans le chemin, l'identifiant ou un domaine voisin ne suffit pas.
  expect(decisionNavigation("https://pub.example/vidola-a.example", c)).toBe("bloquer");
  expect(decisionNavigation("https://vidola-a.example@pub.example/", c)).toBe("bloquer");
  expect(decisionNavigation("https://vidola-a.example.pub.example/", c)).toBe("bloquer");
  expect(decisionNavigation("https://faux-vidola-a.example/", c)).toBe("bloquer");
});

test("cadre principal : un domaine de connexion est suivi", () => {
  expect(decisionNavigation("https://accounts.google.com/o/oauth2", c)).toBe("suivre");
  expect(decisionNavigation("https://accounts.google.com/o/oauth2", { ...c, connexion: [] })).toBe("bloquer");
});

test("cadre principal : seulement http(s)", () => {
  for (const url of ["javascript:alert(1)", "about:blank", "file:///etc/passwd", "data:text/html,x", "ftp://vidola-a.example/", "pas une adresse", ""]) {
    expect(decisionNavigation(url, c)).toBe("bloquer");
  }
});

test("ouvertures : le site dans l'appli, la connexion dans une petite fenêtre, le reste bloqué", () => {
  expect(decisionOuverture("https://www.vidola-a.example/serie", c)).toBe("dans-l-appli");
  expect(decisionOuverture("https://accounts.google.com/o/oauth2", c)).toBe("petite-fenetre");
  for (const url of ["https://pub.example/", "about:blank", "javascript:alert(1)", "", "file:///x"]) {
    expect(decisionOuverture(url, c)).toBe("bloquer");
  }
  // Un domaine à la fois du site et de la connexion reste dans l'appli.
  expect(decisionOuverture("https://vidola-a.example/", { ...c, connexion: ["vidola-a.example"] })).toBe("dans-l-appli");
});

test("erreurs de réseau qui déclenchent le suivi de l'adresse", () => {
  expect(erreurDeReseau(-105)).toBe(true);
  for (const code of [-7, -100, -101, -102, -104, -106, -109, -118, -137]) expect(erreurDeReseau(code)).toBe(true);
  expect(erreurDeReseau(-3)).toBe(false); // abandon
  expect(erreurDeReseau(-202)).toBe(false); // certificat
  expect(erreurDeReseau(0)).toBe(false);
});
