#!/usr/bin/env node
// The real Claude Code CLI on the Mac, for the real-browser replay (B3): the fake docker runs this (FAKE_DOCKER_AGENT) with the
// kernel's `claude …` command as argv, inside the panel's PTY. The container's paths are mapped to the workspace on the Mac
// (RESSAC_ROOT), the MCP config points at the bench's recorder (BENCH_MCP_URL), and the agent gets no built-in tool at all, as
// B3 (the container's layers, B1/B2, are bypassed here).
//   node agent-on-mac.mjs --selftest      the argv rewrite, no CLI run
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// harness.mts's list, read from its source: plain node runs this file, and importing harness.mts would need tsx and the kernel.
const DANGEROUS = JSON.parse(/export const DANGEROUS = (\[[^\]]*\])/.exec(readFileSync(fileURLToPath(new URL("../harness.mts", import.meta.url)), "utf8"))[1]);

/** The kernel's command, made to run on the Mac. An existing `--tools` pair is dropped (main's Navigateur allowlist), the
 *  existing `--disallowedTools` are kept and B3's own is appended (the CLI takes the flag repeated: the kernel already does). */
export function rewrite(argv, o) {
  const a = argv[0] === "claude" ? argv.slice(1) : [...argv];
  const out = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--tools") { i++; continue; }
    if (a[i] === "--mcp-config") { out.push(a[i], o.mcpCopy); i++; continue; }
    out.push(a[i].startsWith("/workspace/") ? o.root + a[i].slice("/workspace".length) : a[i]);
  }
  return [...out, "--tools", "", "--disallowedTools", DANGEROUS.join(",")];
}

if (process.argv.includes("--selftest")) {
  const assert = (await import("node:assert/strict")).default;
  assert.ok(DANGEROUS.includes("Bash") && DANGEROUS.includes("Read") && DANGEROUS.length > 10, "harness.mts's list is read");
  const o = { root: "/Users/x/data/workspace", mcpCopy: "/tmp/ressac-b3-config-1/mcp.json" };
  const tail = ["--tools", "", "--disallowedTools", DANGEROUS.join(",")];
  // e2e/agent-panel.e2e.ts's exact argv (« the panel runs the real CLI »).
  const panel = ["claude", "--append-system-prompt", "Always reply to the user in French, whatever language the instructions are written in.",
    "--session-id", "0b7c8f9e-1a2b-4c3d-8e4f-5a6b7c8d9e0f", "--disallowedTools", "Bash,mcp__ressac__launch_app", "--strict-mcp-config",
    "--setting-sources", "", "--settings", '{"skipDangerousModePermissionPrompt":true}', "--append-system-prompt-file",
    "/workspace/.ressac/instructions/AGENTS.md", "--disallowedTools", "WebSearch,WebFetch", "--dangerously-skip-permissions",
    "--mcp-config", "/workspace/.ressac/sessions/0123456789abcdef.json"];
  assert.deepEqual(rewrite(panel, o), [...panel.slice(1, 13), `${o.root}/.ressac/instructions/AGENTS.md`, ...panel.slice(14, 18), o.mcpCopy, ...tail]);
  assert.ok(tail.at(-1).startsWith("Bash,PowerShell,"));
  // main's Navigateur allowlist: its `--tools` is replaced, its denials kept beside B3's.
  const main = ["claude", "--tools", "Read,Glob,Grep,Write,Edit", "--disallowedTools", "Bash,mcp__ressac__launch_app", "--strict-mcp-config", "--mcp-config", "/workspace/.ressac/sessions/x.json"];
  assert.deepEqual(rewrite(main, o), ["--disallowedTools", "Bash,mcp__ressac__launch_app", "--strict-mcp-config", "--mcp-config", o.mcpCopy, ...tail]);
  assert.equal(rewrite(main, o).filter((x) => x === "--tools").length, 1, "one --tools, the empty one");
  console.log("agent-on-mac selftest ok");
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const root = process.env.RESSAC_ROOT;
  const url = process.env.BENCH_MCP_URL;
  if (!root || !url) { console.error("agent-on-mac: RESSAC_ROOT and BENCH_MCP_URL are needed"); process.exit(2); }
  const session = argv[argv.indexOf("--mcp-config") + 1];
  if (!argv.includes("--mcp-config") || !session) { console.error("agent-on-mac: no --mcp-config"); process.exit(2); }
  const configDir = mkdtempSync("/tmp/ressac-b3-config-");
  // Claude keys the trust dialog by its real working folder (/tmp is /private/tmp on macOS).
  const cwd = realpathSync(mkdtempSync("/tmp/ressac-b3-"));
  const cleanup = () => { rmSync(configDir, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); };
  const config = JSON.parse(readFileSync(session.replace(/^\/workspace\//, `${root}/`), "utf8"));
  config.mcpServers.ressac.url = url;
  const mcpCopy = join(configDir, "mcp.json");
  writeFileSync(mcpCopy, JSON.stringify(config), { mode: 0o600 });
  writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir, DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };
  if (env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL.replace("host.docker.internal", "127.0.0.1");
  delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT; // when the bench is launched from inside a Claude Code session
  const p = spawn(process.env.BENCH_CLAUDE || "claude", rewrite(argv, { root, mcpCopy }), { cwd, env, stdio: "inherit" });
  writeFileSync(join(root, "bench-agent-pid"), String(p.pid));
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => p.kill(s));
  p.on("error", (e) => { console.error(`agent-on-mac: ${e}`); cleanup(); process.exit(1); });
  p.on("exit", (code, signal) => { cleanup(); process.exit(code ?? (signal ? 1 : 0)); });
}
