import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  PROJECT_ID, DESIGN_UNAVAILABLE, SITE_DESIGN_UNAVAILABLE, SITE_CAPTURE_WARNING, NO_CLIENT, reviewStore, destinationOf, remarksFolder, commentsFile, externalId,
  containerRanges, appProject, demoProject, externalProject, projectForUrl, projectForAppWindow, projectForSite,
  type AvailabilityContext, type DesignFolders, type ExternalProject,
} from "../../src/design/projects.js";

const external: ExternalProject = { id: "0123456789abcdef", name: "site", folder: "/Users/t/site", ports: [4321], client: "c1", declared: "2026-11-02T10:00:00Z" };
const context = (ranges: [number, number][] = [[5280, 5299]]): AvailabilityContext => ({
  launchedApps: [{ folder: "essai", name: "Essai", port: 15280 }],
  ranges: ranges,
  external: [external],
});

describe("projectForUrl", () => {
  test("http://localhost:15280/x of an app launched on 15280 gives app-essai", () => {
    expect(projectForUrl("http://localhost:15280/x", context())).toEqual({ type: "app", project: "app-essai", folder: "essai", name: "Essai" });
  });
  test("port 5290 without an app gives demo-5290, 15283 with extended range gives demo-15283", () => {
    expect(projectForUrl("http://localhost:5290/", context())).toEqual({ type: "demo", project: "demo-5290", port: 5290 });
    expect(projectForUrl("http://127.0.0.1:15283/", context([[5280, 5299], [15280, 15284]]))).toEqual({ type: "demo", project: "demo-15283", port: 15283 });
  });
  test("127.0.0.1:4321 declared by an external project gives externe", () => {
    expect(projectForUrl("http://127.0.0.1:4321/", context())).toEqual({ type: "externe", project: "ext-0123456789abcdef", folder: external.folder, name: "site", client: "c1" });
  });
  test("everything else gives null", () => {
    for (const u of ["https://localhost:4321", "http://exemple.fr:4321", "http://localhost:4322", "file:///tmp/x", "webaios://applications", "http://localhost/", "pas une url"]) {
      expect(projectForUrl(u, context())).toBeNull();
    }
  });
});

describe("containerRanges", () => {
  test("default, valid range, invalid value", () => {
    expect(containerRanges(undefined)).toEqual([[5280, 5299]]);
    expect(containerRanges("15280-15284")).toEqual([[5280, 5299], [15280, 15284]]);
    expect(containerRanges("n'importe")).toEqual([[5280, 5299]]);
    expect(containerRanges("5280-5299")).toEqual([[5280, 5299]]);
  });
  test("honours WEBAIOS_CONTAINER_PORTS", () => {
    vi.stubEnv("WEBAIOS_CONTAINER_PORTS", "5300-5319");
    try {
      expect(containerRanges(undefined)).toEqual([[5300, 5319]]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("ids", () => {
  test("PROJECT_ID", () => {
    for (const ok of ["app-essai", "ext-0123456789abcdef", "demo-5280"]) expect(PROJECT_ID.test(ok)).toBe(true);
    for (const ko of ["app-../x", "ext-XYZ", "demo-", "app-"]) expect(PROJECT_ID.test(ko)).toBe(false);
    expect(PROJECT_ID.test(appProject("a")) && PROJECT_ID.test(demoProject(5280)) && PROJECT_ID.test(externalProject("0123456789abcdef"))).toBe(true);
  });
  test("externalId is stable and is 16 hex characters", () => {
    expect(externalId("/a/b")).toBe(externalId("/a/b"));
    expect(externalId("/a/b")).toMatch(/^[0-9a-f]{16}$/);
    expect(externalId("/a/b")).not.toBe(externalId("/a/c"));
  });
});

describe("dossiers", () => {
  const d: DesignFolders = { spaceRemarks: "/r/.webaios/remarks", private: "/u/design" };
  test("remarksFolder", () => {
    expect(remarksFolder(d, "ext-0123456789abcdef")).toBe("/u/design/remarks/ext-0123456789abcdef");
    expect(remarksFolder(d, "app-essai")).toBe("/r/.webaios/remarks/app-essai");
    expect(remarksFolder(d, "demo-5280")).toBe("/r/.webaios/remarks/demo-5280");
  });
  test("reviewStore and commentsFile under prive/review", () => {
    expect(reviewStore(d, "app-essai")).toBe("/u/design/review/app-essai.git");
    expect(commentsFile(d, "ext-0123456789abcdef")).toBe("/u/design/review/ext-0123456789abcdef.comments.json");
  });
});

describe("destinationOf and app window", () => {
  test("destinations", () => {
    expect(destinationOf(projectForAppWindow("essai", "Essai"), [])).toEqual({ label: "l'agent" });
    expect(destinationOf({ type: "demo", project: "demo-5280", port: 5280 }, [])).toEqual({ label: "l'agent" });
    const ext = { type: "externe" as const, project: "ext-0123456789abcdef", folder: "/x", name: "x" };
    const clients = [{ id: "c1", name: "Mon Mac", hash: "h", created: "2026-11-02" }];
    expect(destinationOf({ ...ext, client: "c1" }, clients)).toEqual({ label: "Claude Code (Mon Mac)" });
    expect(destinationOf({ ...ext, client: null }, clients)).toEqual({ unavailable: NO_CLIENT });
    expect(destinationOf({ ...ext, client: "révoqué" }, clients)).toEqual({ unavailable: NO_CLIENT });
  });
});

describe("projet de site", () => {
  test("PROJECT_ID accepte site-tuning, site-a, site-<60 car.> ; refuse site-, site-A, site-../x, site--x, site-<61 car.>, site-a_b", () => {
    for (const ok of ["site-tuning", "site-a", `site-${"a".repeat(60)}`]) expect(PROJECT_ID.test(ok)).toBe(true);
    for (const ko of ["site-", "site-A", "site-../x", "site--x", `site-${"a".repeat(61)}`, "site-a_b"]) expect(PROJECT_ID.test(ko)).toBe(false);
  });
  test("remarksFolder on the space side, destination the agent, exact messages", () => {
    const d: DesignFolders = { spaceRemarks: "/e/remarks", private: "/p" };
    expect(remarksFolder(d, "site-tuning")).toBe(join(d.spaceRemarks, "site-tuning"));
    expect(projectForSite("tuning", "Tuning")).toEqual({ type: "site", project: "site-tuning", id: "tuning", name: "Tuning" });
    expect(destinationOf(projectForSite("tuning", "Tuning"), [])).toEqual({ label: "l'agent" });
    expect(DESIGN_UNAVAILABLE).toBe("Le mode design marche sur les applis de l'agent, les applis de site et les projets branchés par un Claude Code");
    expect(SITE_DESIGN_UNAVAILABLE).toBe("Le mode design marche dans les pages du site et sur l'accueil, pas sur la carte d'accord, une page de connexion ni en plein écran");
    expect(SITE_CAPTURE_WARNING).toBe("L'extrait et la capture de cet élément iront à l'agent.");
  });
});
