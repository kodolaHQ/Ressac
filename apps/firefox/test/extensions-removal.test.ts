import { existsSync } from "node:fs";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { REMOVED_MARKER, removeAgentExtensions } from "../host/extensions-removal";

test("removeAgentExtensions: once, the registry, the workspace sources and the Mozilla account go; a link's target stays; later launches touch nothing", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ext-removal-"));
  const workspace = join(dataDir, "workspace");
  const keychain = join(dataDir, "keychain");
  const kept = join(dataDir, "kept");
  await mkdir(join(dataDir, "extensions", "signed"), { recursive: true });
  await writeFile(join(dataDir, "extensions", "state.json"), "{}");
  await mkdir(workspace, { recursive: true });
  await mkdir(kept);
  await symlink(kept, join(workspace, "extensions"));
  await writeFile(`${keychain}.amo`, "user:1:2:secret");
  const env = { RESSAC_TEST_KEYCHAIN: keychain };
  await removeAgentExtensions({ dataDir, workspace, env });
  expect(existsSync(join(dataDir, "extensions"))).toBe(false);
  expect(existsSync(join(workspace, "extensions"))).toBe(false);
  expect(existsSync(kept)).toBe(true);
  expect(existsSync(`${keychain}.amo`)).toBe(false);
  expect(existsSync(join(dataDir, REMOVED_MARKER))).toBe(true);
  // A folder the user makes later is theirs.
  await mkdir(join(workspace, "extensions"));
  await removeAgentExtensions({ dataDir, workspace, env });
  expect(existsSync(join(workspace, "extensions"))).toBe(true);
});
