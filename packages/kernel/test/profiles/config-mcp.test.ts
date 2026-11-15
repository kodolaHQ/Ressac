import { expect, test } from "vitest";
import { lstat, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

test("writeMcpConfig never follows a link planted by the agent: the target file stays as it was", async () => {
  const root = await tempFolder();
  const c = spacePaths(root);
  const victim = join(await tempFolder(), "victim.txt");
  await writeFile(victim, "mine");
  await mkdir(dirname(c.mcpConfig), { recursive: true });
  await symlink(victim, c.mcpConfig);
  await writeMcpConfig(c, "claude-json", { url: "http://a/mcp", token: "1" });
  expect(await readFile(victim, "utf8")).toBe("mine");
  expect((await lstat(c.mcpConfig)).isSymbolicLink()).toBe(false);
  // The .ressac folder itself replaced by a link: refused.
  const elsewhere = await tempFolder();
  await rm(dirname(c.mcpConfig), { recursive: true });
  await symlink(elsewhere, dirname(c.mcpConfig));
  await expect(writeMcpConfig(c, "claude-json", { url: "http://a/mcp", token: "1" })).rejects.toThrow();
  expect(await readdir(elsewhere)).toEqual([]);
});
