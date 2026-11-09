// node-pty 1.1 ships its spawn-helper without the executable bit (« posix_spawnp failed »).
import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(join(process.cwd(), "packages/kernel/package.json"));
const root = dirname(require.resolve("node-pty/package.json"));
const helper = join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
if (existsSync(helper)) chmodSync(helper, 0o755);
