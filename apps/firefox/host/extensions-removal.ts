import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { removeAmoAccount } from "./keychain.ts";

/** Written once the leftovers are gone: the cleanup runs at one launch only. */
export const REMOVED_MARKER = "agent-extensions-removed";

/**
 * Once, at the first launch without agent-written extensions (0.1.27): the host's registry (`<data>/extensions`: state,
 * copies, signed .xpi), their sources in the workspace (`extensions/`) and the Mozilla account they were signed with.
 * The marker is written last: a failed step is tried again at the next launch. `rm` takes a link, never its target.
 */
export async function removeAgentExtensions(o: { dataDir: string; workspace: string; env?: NodeJS.ProcessEnv }): Promise<void> {
  const marker = join(o.dataDir, REMOVED_MARKER);
  if (existsSync(marker)) return;
  const env = o.env ?? process.env;
  // Tests and e2e never touch the real keychain (RESSAC_TEST_NO_SYSTEM), unless a file stands in for it.
  if (!env.RESSAC_TEST_NO_SYSTEM || env.RESSAC_TEST_KEYCHAIN) await removeAmoAccount({ env });
  await rm(join(o.dataDir, "extensions"), { recursive: true, force: true });
  await rm(join(o.workspace, "extensions"), { recursive: true, force: true });
  await mkdir(o.dataDir, { recursive: true });
  await writeFile(marker, "");
}
