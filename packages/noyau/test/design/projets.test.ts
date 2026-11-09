import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  ID_PROJET, INDISPONIBLE_DESIGN, INDISPONIBLE_DESIGN_SITE, AVERTISSEMENT_CAPTURE_SITE, SANS_CLIENT, depotRelecture, destinationDe, dossierRemarques, fichierCommentaires, idExterne,
  plagesConteneur, projetApp, projetDemo, projetExterne, projetPourAdresse, projetPourFenetreApp, projetPourSite,
  type ContexteDisponibilite, type DossiersDesign, type ProjetExterne,
} from "../../src/design/projets.js";

const externe: ProjetExterne = { id: "0123456789abcdef", nom: "site", dossier: "/Users/t/site", ports: [4321], client: "c1", declare: "2026-11-02T10:00:00Z" };
const contexte = (plages: [number, number][] = [[5280, 5299]]): ContexteDisponibilite => ({
  appsLancees: [{ dossier: "essai", nom: "Essai", port: 15280 }],
  plages,
  externes: [externe],
});

describe("projetPourAdresse", () => {
  test("http://localhost:15280/x d'une appli lancée sur 15280 donne app-essai", () => {
    expect(projetPourAdresse("http://localhost:15280/x", contexte())).toEqual({ type: "app", projet: "app-essai", dossier: "essai", nom: "Essai" });
  });
  test("port 5290 sans appli donne demo-5290, 15283 avec plage étendue donne demo-15283", () => {
    expect(projetPourAdresse("http://localhost:5290/", contexte())).toEqual({ type: "demo", projet: "demo-5290", port: 5290 });
    expect(projetPourAdresse("http://127.0.0.1:15283/", contexte([[5280, 5299], [15280, 15284]]))).toEqual({ type: "demo", projet: "demo-15283", port: 15283 });
  });
  test("127.0.0.1:4321 déclaré par un projet externe donne externe", () => {
    expect(projetPourAdresse("http://127.0.0.1:4321/", contexte())).toEqual({ type: "externe", projet: "ext-0123456789abcdef", dossier: externe.dossier, nom: "site", client: "c1" });
  });
  test("tout le reste donne null", () => {
    for (const u of ["https://localhost:4321", "http://exemple.fr:4321", "http://localhost:4322", "file:///tmp/x", "webaios://applications", "http://localhost/", "pas une url"]) {
      expect(projetPourAdresse(u, contexte())).toBeNull();
    }
  });
});

describe("plagesConteneur", () => {
  test("défaut, plage valide, valeur invalide", () => {
    expect(plagesConteneur(undefined)).toEqual([[5280, 5299]]);
    expect(plagesConteneur("15280-15284")).toEqual([[5280, 5299], [15280, 15284]]);
    expect(plagesConteneur("n'importe")).toEqual([[5280, 5299]]);
    expect(plagesConteneur("5280-5299")).toEqual([[5280, 5299]]);
  });
  test("honours WEBAIOS_PORTS_CONTENEUR", () => {
    vi.stubEnv("WEBAIOS_PORTS_CONTENEUR", "5300-5319");
    try {
      expect(plagesConteneur(undefined)).toEqual([[5300, 5319]]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("ids", () => {
  test("ID_PROJET", () => {
    for (const ok of ["app-essai", "ext-0123456789abcdef", "demo-5280"]) expect(ID_PROJET.test(ok)).toBe(true);
    for (const ko of ["app-../x", "ext-XYZ", "demo-", "app-"]) expect(ID_PROJET.test(ko)).toBe(false);
    expect(ID_PROJET.test(projetApp("a")) && ID_PROJET.test(projetDemo(5280)) && ID_PROJET.test(projetExterne("0123456789abcdef"))).toBe(true);
  });
  test("idExterne est stable et fait 16 caractères hex", () => {
    expect(idExterne("/a/b")).toBe(idExterne("/a/b"));
    expect(idExterne("/a/b")).toMatch(/^[0-9a-f]{16}$/);
    expect(idExterne("/a/b")).not.toBe(idExterne("/a/c"));
  });
});

describe("dossiers", () => {
  const d: DossiersDesign = { remarquesEspace: "/r/.webaios/remarques", prive: "/u/design" };
  test("dossierRemarques", () => {
    expect(dossierRemarques(d, "ext-0123456789abcdef")).toBe("/u/design/remarques/ext-0123456789abcdef");
    expect(dossierRemarques(d, "app-essai")).toBe("/r/.webaios/remarques/app-essai");
    expect(dossierRemarques(d, "demo-5280")).toBe("/r/.webaios/remarques/demo-5280");
  });
  test("depotRelecture et fichierCommentaires sous prive/relecture", () => {
    expect(depotRelecture(d, "app-essai")).toBe("/u/design/relecture/app-essai.git");
    expect(fichierCommentaires(d, "ext-0123456789abcdef")).toBe("/u/design/relecture/ext-0123456789abcdef.commentaires.json");
  });
});

describe("destinationDe et fenêtre d'appli", () => {
  test("destinations", () => {
    expect(destinationDe(projetPourFenetreApp("essai", "Essai"), [])).toEqual({ libelle: "l'agent" });
    expect(destinationDe({ type: "demo", projet: "demo-5280", port: 5280 }, [])).toEqual({ libelle: "l'agent" });
    const ext = { type: "externe" as const, projet: "ext-0123456789abcdef", dossier: "/x", nom: "x" };
    const clients = [{ id: "c1", nom: "Mon Mac", empreinte: "h", cree: "2026-11-02" }];
    expect(destinationDe({ ...ext, client: "c1" }, clients)).toEqual({ libelle: "Claude Code (Mon Mac)" });
    expect(destinationDe({ ...ext, client: null }, clients)).toEqual({ indisponible: SANS_CLIENT });
    expect(destinationDe({ ...ext, client: "révoqué" }, clients)).toEqual({ indisponible: SANS_CLIENT });
  });
});

describe("projet de site", () => {
  test("ID_PROJET accepte site-tuning, site-a, site-<60 car.> ; refuse site-, site-A, site-../x, site--x, site-<61 car.>, site-a_b", () => {
    for (const ok of ["site-tuning", "site-a", `site-${"a".repeat(60)}`]) expect(ID_PROJET.test(ok)).toBe(true);
    for (const ko of ["site-", "site-A", "site-../x", "site--x", `site-${"a".repeat(61)}`, "site-a_b"]) expect(ID_PROJET.test(ko)).toBe(false);
  });
  test("dossierRemarques côté espace, destination l'agent, messages exacts", () => {
    const d: DossiersDesign = { remarquesEspace: "/e/remarques", prive: "/p" };
    expect(dossierRemarques(d, "site-tuning")).toBe(join(d.remarquesEspace, "site-tuning"));
    expect(projetPourSite("tuning", "Tuning")).toEqual({ type: "site", projet: "site-tuning", id: "tuning", nom: "Tuning" });
    expect(destinationDe(projetPourSite("tuning", "Tuning"), [])).toEqual({ libelle: "l'agent" });
    expect(INDISPONIBLE_DESIGN).toBe("Le mode design marche sur les applis de l'agent, les applis de site et les projets branchés par un Claude Code");
    expect(INDISPONIBLE_DESIGN_SITE).toBe("Le mode design marche dans les pages du site et sur l'accueil, pas sur la carte d'accord, une page de connexion ni en plein écran");
    expect(AVERTISSEMENT_CAPTURE_SITE).toBe("L'extrait et la capture de cet élément iront à l'agent.");
  });
});
