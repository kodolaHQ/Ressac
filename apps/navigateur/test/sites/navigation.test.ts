import { expect, test } from "vitest";
import { decisionNavigation, decisionOuverture, type ContexteNavigation } from "../../src/main/sites/navigation";

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

test("identifiants dans l'adresse : toujours bloqués, même vers le site", () => {
  for (const url of ["https://u:p@www.vidola-a.example/", "https://u@vidola-a.example/", "https://:p@accounts.google.com/"]) {
    expect(decisionNavigation(url, c)).toBe("bloquer");
    expect(decisionOuverture(url, c)).toBe("bloquer");
  }
});

test("http : jamais hors mode test, même vers le site", () => {
  expect(decisionNavigation("http://www.vidola-a.example/", c)).toBe("bloquer");
  expect(decisionOuverture("http://www.vidola-a.example/", c)).toBe("bloquer");
  expect(decisionNavigation("http://accounts.google.com/", c)).toBe("bloquer");
});

test("adresses locales : refusées hors mode test, même si une liste les contient", () => {
  const locales: ContexteNavigation = { domaines: ["vidola-a.localhost", "127.0.0.1", "nas.local"], connexion: ["192.168.1.1"] };
  for (const url of ["https://vidola-a.localhost/", "http://vidola-a.localhost/", "https://127.0.0.1/", "https://nas.local/", "https://192.168.1.1/"]) {
    expect(decisionNavigation(url, locales)).toBe("bloquer");
    expect(decisionOuverture(url, locales)).toBe("bloquer");
  }
});

test("mode test : http d'un hôte local permis ; http d'un hôte public toujours refusé", () => {
  const t: ContexteNavigation = { domaines: ["vidola-a.localhost", "vidola-a.example"], connexion: ["connexion.localhost"], adressesLocales: true };
  expect(decisionNavigation("http://vidola-a.localhost:4321/x", t)).toBe("suivre");
  expect(decisionOuverture("http://www.vidola-a.localhost:4321/x", t)).toBe("dans-l-appli");
  expect(decisionOuverture("http://connexion.localhost:4321/", t)).toBe("petite-fenetre");
  expect(decisionNavigation("https://vidola-a.example/", t)).toBe("suivre");
  expect(decisionNavigation("http://vidola-a.example/", t)).toBe("bloquer");
  expect(decisionOuverture("http://pub.localhost:4321/", t)).toBe("bloquer");
  expect(decisionNavigation("http://u:p@vidola-a.localhost:4321/", t)).toBe("bloquer");
});
