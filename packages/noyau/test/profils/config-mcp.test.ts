import { expect, test } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { cheminsEspace } from "../../src/chemins.js";
import { ecrireConfigMcp } from "../../src/profils/config-mcp.js";
import { dossierTemporaire } from "../aide/temporaire.js";

test("ecrireConfigMcp écrit le format claude-json en 0600", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  await ecrireConfigMcp(c, "claude-json", { url: "http://host.docker.internal:4242/mcp", jeton: "abc" });
  expect(JSON.parse(await readFile(c.configMcp, "utf8"))).toEqual({
    mcpServers: {
      webaios: { type: "http", url: "http://host.docker.internal:4242/mcp", headers: { Authorization: "Bearer abc" } },
    },
  });
  expect((await stat(c.configMcp)).mode & 0o777).toBe(0o600);
});

test("réécrire la config garde le mode 0600", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  await ecrireConfigMcp(c, "claude-json", { url: "http://a/mcp", jeton: "1" });
  await ecrireConfigMcp(c, "claude-json", { url: "http://b/mcp", jeton: "2" });
  expect(JSON.parse(await readFile(c.configMcp, "utf8")).mcpServers.webaios.url).toBe("http://b/mcp");
  expect((await stat(c.configMcp)).mode & 0o777).toBe(0o600);
});
