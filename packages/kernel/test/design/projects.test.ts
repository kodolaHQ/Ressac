import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  PROJECT_ID, DESIGN_UNAVAILABLE, SITE_DESIGN_UNAVAILABLE, SITE_CAPTURE_WARNING, NO_CLIENT, reviewStore, destinationOf, remarksFolder, commentsFile, externalId,
  containerRanges, appProject, demoProject, externalProject, projectForUrl, projectForAppWindow, projectForSite,
  type AvailabilityContext, type DesignFolders, type ExternalProject,
} from "../../src/design/projects.js";

const external: ExternalProject = { id: "0123456789abcdef", nom: "site", dossier: "/Users/t/site", ports: [4321], client: "c1", declare: "2026-11-02T10:00:00Z" };
const context = (ranges: [number, number][] = [[5280, 5299]]): AvailabilityContext => ({
  appsLancees: [{ dossier: "essai", nom: "Essai", port: 15280 }],
  plages: ranges,
  externes: [external],
});

describe("projetPourAdresse", () => {
  test("http://localhost:15280/x of an app launched on 15280 gives app-essai", () => {
    expect(projectForUrl("http://localhost:15280/x", context())).toEqual({ type: "app", projet: "app-essai", dossier: "essai", nom: "Essai" });
  });
  test("port 5290 without an app gives demo-5290, 15283 with extended range gives demo-15283", () => {
    expect(projectForUrl("http://localhost:5290/", context())).toEqual({ type: "demo", projet: "demo-5290", port: 5290 });
    expect(projectForUrl("http://127.0.0.1:15283/", context([[5280, 5299], [15280, 15284]]))).toEqual({ type: "demo", projet: "demo-15283", port: 15283 });
  });
  test("127.0.0.1:4321 declared by an external project gives externe", () => {
    expect(projectForUrl("http://127.0.0.1:4321/", context())).toEqual({ type: "externe", projet: "ext-0123456789abcdef", dossier: external.dossier, nom: "site", client: "c1" });
  });
  test("everything else gives null", () => {
    for (const u of ["https://localhost:4321", "http://exemple.fr:4321", "http://localhost:4322", "file:///tmp/x", "webaios://applications", "http://localhost/", "pas une url"]) {
      expect(projectForUrl(u, context())).toBeNull();
    }
  });
});

describe("plagesConteneur", () => {
  test("default, valid range, invalid value", () => {
    expect(containerRanges(undefined)).toEqual([[5280, 5299]]);
    expect(containerRanges("15280-15284")).toEqual([[5280, 5299], [15280, 15284]]);
    expect(containerRanges("n'importe")).toEqual([[5280, 5299]]);
    expect(containerRanges("5280-5299")).toEqual([[5280, 5299]]);
  });
  test("honours WEBAIOS_PORTS_CONTENEUR", () => {
    vi.stubEnv("WEBAIOS_PORTS_CONTENEUR", "5300-5319");
    try {
      expect(containerRanges(undefined)).toEqual([[5300, 5319]]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("ids", () => {
  test("ID_PROJET", () => {
    for (const ok of ["app-essai", "ext-0123456789abcdef", "demo-5280"]) expect(PROJECT_ID.test(ok)).toBe(true);
    for (const ko of ["app-../x", "ext-XYZ", "demo-", "app-"]) expect(PROJECT_ID.test(ko)).toBe(false);
    expect(PROJECT_ID.test(appProject("a")) && PROJECT_ID.test(demoProject(5280)) && PROJECT_ID.test(externalProject("0123456789abcdef"))).toBe(true);
  });
  test("idExterne is stable and is 16 hex characters", () => {
    expect(externalId("/a/b")).toBe(externalId("/a/b"));
    expect(externalId("/a/b")).toMatch(/^[0-9a-f]{16}$/);
    expect(externalId("/a/b")).not.toBe(externalId("/a/c"));
  });
});

describe("dossiers", () => {
  const d: DesignFolders = { remarquesEspace: "/r/.webaios/remarques", prive: "/u/design" };
  test("dossierRemarques", () => {
    expect(remarksFolder(d, "ext-0123456789abcdef")).toBe("/u/design/remarques/ext-0123456789abcdef");
    expect(remarksFolder(d, "app-essai")).toBe("/r/.webaios/remarques/app-essai");
    expect(remarksFolder(d, "demo-5280")).toBe("/r/.webaios/remarques/demo-5280");
  });
  test("depotRelecture and fichierCommentaires under prive/relecture", () => {
    expect(reviewStore(d, "app-essai")).toBe("/u/design/relecture/app-essai.git");
    expect(commentsFile(d, "ext-0123456789abcdef")).toBe("/u/design/relecture/ext-0123456789abcdef.commentaires.json");
  });
});

describe("destinationDe and app window", () => {
  test("destinations", () => {
    expect(destinationOf(projectForAppWindow("essai", "Essai"), [])).toEqual({ libelle: "l'agent" });
    expect(destinationOf({ type: "demo", projet: "demo-5280", port: 5280 }, [])).toEqual({ libelle: "l'agent" });
    const ext = { type: "externe" as const, projet: "ext-0123456789abcdef", dossier: "/x", nom: "x" };
    const clients = [{ id: "c1", nom: "Mon Mac", empreinte: "h", cree: "2026-11-02" }];
    expect(destinationOf({ ...ext, client: "c1" }, clients)).toEqual({ libelle: "Claude Code (Mon Mac)" });
    expect(destinationOf({ ...ext, client: null }, clients)).toEqual({ indisponible: NO_CLIENT });
    expect(destinationOf({ ...ext, client: "révoqué" }, clients)).toEqual({ indisponible: NO_CLIENT });
  });
});

describe("projet de site", () => {
  test("ID_PROJET accepte site-tuning, site-a, site-<60 car.> ; refuse site-, site-A, site-../x, site--x, site-<61 car.>, site-a_b", () => {
    for (const ok of ["site-tuning", "site-a", `site-${"a".repeat(60)}`]) expect(PROJECT_ID.test(ok)).toBe(true);
    for (const ko of ["site-", "site-A", "site-../x", "site--x", `site-${"a".repeat(61)}`, "site-a_b"]) expect(PROJECT_ID.test(ko)).toBe(false);
  });
  test("dossierRemarques on the space side, destination the agent, exact messages", () => {
    const d: DesignFolders = { remarquesEspace: "/e/remarques", prive: "/p" };
    expect(remarksFolder(d, "site-tuning")).toBe(join(d.remarquesEspace, "site-tuning"));
    expect(projectForSite("tuning", "Tuning")).toEqual({ type: "site", projet: "site-tuning", id: "tuning", nom: "Tuning" });
    expect(destinationOf(projectForSite("tuning", "Tuning"), [])).toEqual({ libelle: "l'agent" });
    expect(DESIGN_UNAVAILABLE).toBe("Le mode design marche sur les applis de l'agent, les applis de site et les projets branchés par un Claude Code");
    expect(SITE_DESIGN_UNAVAILABLE).toBe("Le mode design marche dans les pages du site et sur l'accueil, pas sur la carte d'accord, une page de connexion ni en plein écran");
    expect(SITE_CAPTURE_WARNING).toBe("L'extrait et la capture de cet élément iront à l'agent.");
  });
});
