import { expect, test } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { spacePaths } from "../../src/paths.js";
import { writeMcpConfig, mcpArgument } from "../../src/profiles/config-mcp.js";
import { tempFolder } from "../helpers/temp.js";

test("writeMcpConfig writes the claude-json format as 0600", async () => {
  const c = spacePaths(await tempFolder());
  await writeMcpConfig(c, "claude-json", { url: "http://host.docker.internal:4242/mcp", token: "abc" });
  expect(JSON.parse(await readFile(c.mcpConfig, "utf8"))).toEqual({
    mcpServers: {
      ressac: { type: "http", url: "http://host.docker.internal:4242/mcp", headers: { Authorization: "Bearer abc" } },
    },
  });
  expect((await stat(c.mcpConfig)).mode & 0o777).toBe(0o600);
});

test("rewriting the config keeps mode 0600", async () => {
  const c = spacePaths(await tempFolder());
  await writeMcpConfig(c, "claude-json", { url: "http://a/mcp", token: "1" });
  await writeMcpConfig(c, "claude-json", { url: "http://b/mcp", token: "2" });
  expect(JSON.parse(await readFile(c.mcpConfig, "utf8")).mcpServers.ressac.url).toBe("http://b/mcp");
  expect((await stat(c.mcpConfig)).mode & 0o777).toBe(0o600);
});

test("mcpArgument declares the server for Codex with the token read from the environment", () => {
  expect(mcpArgument({ url: "http://host.docker.internal:4321/mcp" })).toBe(
    'mcp_servers.ressac={url="http://host.docker.internal:4321/mcp",bearer_token_env_var="RESSAC_MCP_TOKEN"}',
  );
});

test("writeMcpConfig refuses codex-toml", async () => {
  const c = spacePaths(await tempFolder());
  await expect(writeMcpConfig(c, "codex-toml", { url: "http://a/mcp", token: "1" })).rejects.toThrow();
});
