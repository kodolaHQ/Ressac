import { mkdtemp } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function tempFolder(): Promise<string> {
  return realpathSync(await mkdtemp(join(tmpdir(), "webaios-")));
}
