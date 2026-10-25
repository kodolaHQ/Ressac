import { expect, test } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cheminsEspace } from "../../src/chemins.js";
import { chargerProfils, construireCommande, Profil } from "../../src/profils/profil.js";
import { dossierTemporaire } from "../aide/temporaire.js";

const claude = Profil.parse(JSON.parse(await readFile(join(import.meta.dirname, "../../modeles/profil-claude.json"), "utf8")));

test("construireCommande interactif remplace {mcpConfig}", () => {
  expect(construireCommande(claude, "interactif", { mcpConfig: "/workspace/.webaios/mcp.json" })).toEqual([
    "claude", "--dangerously-skip-permissions", "--mcp-config", "/workspace/.webaios/mcp.json",
  ]);
});

test("nonInteractif : la consigne reste un seul argument, même avec espaces et guillemets", () => {
  const consigne = `Résume "ça" ; rm -rf /`;
  const cmd = construireCommande(claude, "nonInteractif", { consigne });
  expect(cmd.at(-1)).toBe(consigne);
  expect(cmd).toHaveLength(4);
});

test("variable manquante → erreur", () => {
  expect(() => construireCommande(claude, "interactif", {})).toThrow(/mcpConfig/);
});

test("un profil nonInteractif avec {mcpConfig} est refusé", () => {
  const fautif = { ...claude, nonInteractif: ["x", "{mcpConfig}", "{consigne}"] };
  expect(() => construireCommande(fautif, "nonInteractif", { consigne: "c", mcpConfig: "/m" })).toThrow();
  expect(Profil.safeParse(fautif).success).toBe(false);
});

test("chargerProfils ignore un profil invalide et le signale", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  await mkdir(c.profils, { recursive: true });
  await writeFile(join(c.profils, "claude.json"), JSON.stringify(claude));
  await writeFile(join(c.profils, "casse.json"), "{");
  await writeFile(join(c.profils, "note.txt"), "pas un profil");
  const { profils, erreurs } = await chargerProfils(c);
  expect(profils.map((p) => p.id)).toEqual(["claude"]);
  expect(erreurs).toHaveLength(1);
  expect(erreurs[0]!.fichier).toBe(join(c.profils, "casse.json"));
});
