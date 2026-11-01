import { expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { cheminsEspace } from "@webaios/noyau";

/**
 * Course : l'agent remplace un fichier de l'accueil par un lien juste après la vérification des chemins. `realpath` est
 * truqué pour rendre le chemin d'avant (comme si le lien n'existait pas encore au moment de la vérification) ; le fichier
 * doit quand même être refusé à l'ouverture (O_NOFOLLOW), jamais lu à travers le lien.
 */
const avantLeLien = new Map<string, string>();
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, realpath: async (p: string) => (avantLeLien.get(p) ?? fs.realpath(p)) };
});
const { repondreAccueilSite } = await import("../../src/main/sites/accueil");

function espace() {
  const c = cheminsEspace(mkdtempSync(join(tmpdir(), "webaios-accueil-course-")));
  const accueil = join(c.sites, "vidola", "accueil");
  mkdirSync(accueil, { recursive: true });
  writeFileSync(join(accueil, "index.html"), "<p>ok</p>");
  return { c, accueil: join(realpathSync(c.sites), "vidola", "accueil") };
}

test("un fichier devenu lien entre la vérification et la lecture n'est jamais lu à travers le lien", async () => {
  const { c, accueil } = espace();
  const dehors = mkdtempSync(join(tmpdir(), "webaios-secret-"));
  writeFileSync(join(dehors, "secret.html"), "secret");
  symlinkSync(join(dehors, "secret.html"), join(accueil, "course.html"));
  avantLeLien.set(join(c.sites, "vidola", "accueil", "course.html"), join(accueil, "course.html"));
  const r = await repondreAccueilSite(c, "webaios-site://vidola/course.html");
  expect(r.status).toBe(404);
  expect(await r.text()).not.toContain("secret");
  // Le fichier normal reste servi.
  expect(await (await repondreAccueilSite(c, "webaios-site://vidola/index.html")).text()).toBe("<p>ok</p>");
});

test("un tube nommé (FIFO) dans l'accueil : 404 tout de suite, sans bloquer la lecture", async () => {
  const { c, accueil } = espace();
  execFileSync("mkfifo", [join(accueil, "tube.html")]);
  const r = await Promise.race([repondreAccueilSite(c, "webaios-site://vidola/tube.html"), new Promise<null>((ok) => setTimeout(() => ok(null), 2000))]);
  expect(r?.status).toBe(404);
});
