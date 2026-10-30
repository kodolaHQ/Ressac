import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { GARDES_PAR_DEFAUT } from "@webaios/noyau";

// `preparerCopie` du noyau, avec un crochet avant et après : on y bascule le dossier de l'agent pendant la copie.
const crochets = vi.hoisted(() => ({ avant: () => {}, apres: () => {} }));
vi.mock("@webaios/noyau", async (importOriginal) => {
  const reel = await importOriginal<typeof import("@webaios/noyau")>();
  return {
    ...reel,
    preparerCopie: async (o: Parameters<typeof reel.preparerCopie>[0]) => {
      crochets.avant();
      try {
        return await reel.preparerCopie(o);
      } finally {
        crochets.apres();
      }
    },
  };
});

const { preparerAgent } = await import("../../src/main/extensions/agent");

const temporaires: string[] = [];
afterAll(() => {
  for (const d of temporaires) rmSync(d, { recursive: true, force: true });
});

test("le dossier de l'agent bascule entre la pré-vérification et la copie, puis revient : refus, aucune copie", async () => {
  const dossier = mkdtempSync(join(tmpdir(), "webaios-ext-bascule-"));
  temporaires.push(dossier);
  const agent = join(dossier, "extensions");
  const ecrire = (racine: string) => {
    mkdirSync(join(racine, "ext"), { recursive: true });
    writeFileSync(join(racine, "ext", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "X", version: "1.0.0" }));
  };
  ecrire(agent);
  ecrire(join(dossier, "ailleurs"));
  // Pendant la copie, `extensions` est un lien vers un autre dossier ; la copie finie, tout est remis comme avant.
  crochets.avant = () => {
    renameSync(agent, join(dossier, "extensions.reel"));
    symlinkSync(join(dossier, "ailleurs"), agent);
  };
  crochets.apres = () => {
    unlinkSync(agent);
    renameSync(join(dossier, "extensions.reel"), agent);
  };
  const r = await preparerAgent("ext", {
    dossier: join(dossier, "ud"),
    dossierAgent: agent,
    dossierGardes: GARDES_PAR_DEFAUT,
  } as never);
  expect(r.ok).toBe(false);
  expect(existsSync(join(dossier, "ud", "copies", "ext.attente"))).toBe(false);
});
