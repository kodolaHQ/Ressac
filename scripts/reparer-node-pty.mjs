// node-pty 1.1 publie son spawn-helper sans le bit exécutable (« posix_spawnp failed »).
import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(join(process.cwd(), "packages/noyau/package.json"));
const racine = dirname(require.resolve("node-pty/package.json"));
const helper = join(racine, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
if (existsSync(helper)) chmodSync(helper, 0o755);
