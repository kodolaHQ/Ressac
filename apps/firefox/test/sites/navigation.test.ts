import { expect, test } from "vitest";
import { decisionNavigation, decisionOuverture, type ContexteNavigation } from "../../core/sites/navigation";

const c: ContexteNavigation = { domaines: ["vidola-a.example"], connexion: ["accounts.google.com"] };

test("main frame: the site and its subdomains are followed, the rest blocked", () => {
  expect(decisionNavigation("https://www.vidola-a.example/x", c)).toBe("suivre");
  expect(decisionNavigation("https://vidola-a.example/", c)).toBe("suivre");
  expect(decisionNavigation("https://pub.example/", c)).toBe("bloquer");
  // The site name in the path, the identifier or a neighbouring domain is not enough.
  expect(decisionNavigation("https://pub.example/vidola-a.example", c)).toBe("bloquer");
  expect(decisionNavigation("https://vidola-a.example@pub.example/", c)).toBe("bloquer");
  expect(decisionNavigation("https://vidola-a.example.pub.example/", c)).toBe("bloquer");
  expect(decisionNavigation("https://faux-vidola-a.example/", c)).toBe("bloquer");
});

test("main frame: a sign-in domain is followed", () => {
  expect(decisionNavigation("https://accounts.google.com/o/oauth2", c)).toBe("suivre");
  expect(decisionNavigation("https://accounts.google.com/o/oauth2", { ...c, connexion: [] })).toBe("bloquer");
});

test("cadre principal : seulement http(s)", () => {
  for (const url of ["javascript:alert(1)", "about:blank", "file:///etc/passwd", "data:text/html,x", "ftp://vidola-a.example/", "pas une adresse", ""]) {
    expect(decisionNavigation(url, c)).toBe("bloquer");
  }
});

test("openings: the site in the app, sign-in in a small window, the rest blocked", () => {
  expect(decisionOuverture("https://www.vidola-a.example/serie", c)).toBe("dans-l-appli");
  expect(decisionOuverture("https://accounts.google.com/o/oauth2", c)).toBe("petite-fenetre");
  for (const url of ["https://pub.example/", "about:blank", "javascript:alert(1)", "", "file:///x"]) {
    expect(decisionOuverture(url, c)).toBe("bloquer");
  }
  // A domain that is both the site's and the sign-in's stays in the app.
  expect(decisionOuverture("https://vidola-a.example/", { ...c, connexion: ["vidola-a.example"] })).toBe("dans-l-appli");
});

test("credentials in the address: always blocked, even toward the site", () => {
  for (const url of ["https://u:p@www.vidola-a.example/", "https://u@vidola-a.example/", "https://:p@accounts.google.com/"]) {
    expect(decisionNavigation(url, c)).toBe("bloquer");
    expect(decisionOuverture(url, c)).toBe("bloquer");
  }
});

test("http: never outside test mode, even toward the site", () => {
  expect(decisionNavigation("http://www.vidola-a.example/", c)).toBe("bloquer");
  expect(decisionOuverture("http://www.vidola-a.example/", c)).toBe("bloquer");
  expect(decisionNavigation("http://accounts.google.com/", c)).toBe("bloquer");
});

test("local addresses: refused outside test mode, even if a list contains them", () => {
  const locales: ContexteNavigation = { domaines: ["vidola-a.localhost", "127.0.0.1", "nas.local"], connexion: ["192.168.1.1"] };
  for (const url of ["https://vidola-a.localhost/", "http://vidola-a.localhost/", "https://127.0.0.1/", "https://nas.local/", "https://192.168.1.1/"]) {
    expect(decisionNavigation(url, locales)).toBe("bloquer");
    expect(decisionOuverture(url, locales)).toBe("bloquer");
  }
});

test("test mode: a local host's http allowed; a public host's http always refused", () => {
  const t: ContexteNavigation = { domaines: ["vidola-a.localhost", "vidola-a.example"], connexion: ["connexion.localhost"], adressesLocales: true };
  expect(decisionNavigation("http://vidola-a.localhost:4321/x", t)).toBe("suivre");
  expect(decisionOuverture("http://www.vidola-a.localhost:4321/x", t)).toBe("dans-l-appli");
  expect(decisionOuverture("http://connexion.localhost:4321/", t)).toBe("petite-fenetre");
  expect(decisionNavigation("https://vidola-a.example/", t)).toBe("suivre");
  expect(decisionNavigation("http://vidola-a.example/", t)).toBe("bloquer");
  expect(decisionOuverture("http://pub.localhost:4321/", t)).toBe("bloquer");
  expect(decisionNavigation("http://u:p@vidola-a.localhost:4321/", t)).toBe("bloquer");
});
