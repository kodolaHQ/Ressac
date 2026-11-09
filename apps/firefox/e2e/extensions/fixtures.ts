import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Writes an agent extension into `<racine>/extensions/<id>/` (the test's data dir): each file by relative path (a Buffer
 * as is, an object as JSON). Nothing written there grants a right.
 */
export function writeAgentExtension(root: string, id: string, files: Record<string, string | object>): void {
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, "extensions", id, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof content === "string" || Buffer.isBuffer(content) ? content : JSON.stringify(content, null, 2));
  }
}
