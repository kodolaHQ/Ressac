// B5 5.3: the kernel's host-side reads/writes refuse links planted in the workspace.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const W = (process.env.RESSAC_WORKTREE ?? new URL("../../../..", import.meta.url).pathname);
const { linkFree } = await import(`${W}/packages/kernel/src/workspace/no-links.ts`);
const c = await import(`${W}/packages/kernel/src/workspace/confined.ts`);
const t = mkdtempSync(join(tmpdir(), "b5l-")); const root = join(t, "ws"), out = join(t, "outside");
mkdirSync(join(root, "real/sub"), { recursive: true }); mkdirSync(out); writeFileSync(join(out, "secret.txt"), "HOST-SECRET");
writeFileSync(join(root, "real/sub/ok.txt"), "ok");
symlinkSync(out, join(root, "lnk")); symlinkSync(out, join(root, "real/mid")); symlinkSync(join(out, "secret.txt"), join(root, "real/sub/leaf.txt"));
symlinkSync("..", join(root, "real/up")); linkSync(join(out, "secret.txt"), join(root, "real/sub/hard.txt"));
const r: Record<string, unknown> = {};
r["linkFree real/sub (control true)"] = await linkFree(root, join(root, "real/sub"));
r["linkFree lnk"] = await linkFree(root, join(root, "lnk"));
r["linkFree real/mid"] = await linkFree(root, join(root, "real/mid"));
r["linkFree real/up/real/sub"] = await linkFree(root, join(root, "real/up/real/sub"));
r["linkFree real/../../outside"] = await linkFree(root, join(root, "real/../../outside"));
r["inFolder real/sub read ok.txt (control)"] = await c.inFolder(root, ["real", "sub"], c.readFiles, [["ok.txt"], 1000, 1000]);
r["inFolder real/sub read leaf.txt (symlink leaf)"] = await c.inFolder(root, ["real", "sub"], c.readFiles, [["leaf.txt"], 1000, 1000]);
r["inFolder real/sub read hard.txt (hardlink: same volume only)"] = await c.inFolder(root, ["real", "sub"], c.readFiles, [["hard.txt"], 1000, 1000]);
r["inFolder lnk read secret.txt"] = await c.inFolder(root, ["lnk"], c.readFiles, [["secret.txt"], 1000, 1000]);
r["inFolder real/mid read secret.txt"] = await c.inFolder(root, ["real", "mid"], c.readFiles, [["secret.txt"], 1000, 1000]);
r["inFolder names ['..','outside']"] = await c.inFolder(root, ["..", "outside"], c.readFiles, [["secret.txt"], 1000, 1000]).catch((e: Error) => "threw " + e.message);
r["inFolder names ['real/../../outside']"] = await c.inFolder(root, ["real/../../outside"], c.readFiles, [["secret.txt"], 1000, 1000]).catch((e: Error) => "threw " + e.message);
r["readFiles ['../../outside/secret.txt'] from real/sub"] = await c.inFolder(root, ["real", "sub"], c.readFiles, [["../../../outside/secret.txt"], 1000, 1000]).catch((e: Error) => "threw " + e.message);
r["writeEntries through lnk"] = await c.inFolder(root, ["lnk"], c.writeEntries, [[["w.txt", "x"]], []]).catch((e: Error) => "threw " + e.message);
r["writeEntries onto symlink leaf"] = await c.inFolder(root, ["real", "sub"], c.writeEntries, [[["leaf.txt", "OVERWRITTEN"]], []]).catch((e: Error) => "threw " + e.message);
r["outside secret after writes"] = readFileSync(join(out, "secret.txt"), "utf8"); r["outside/w.txt exists"] = existsSync(join(out, "w.txt"));
// swap between check and use: a folder turned into a link while the child walks
let hits = 0, runs = 0; const stop = Date.now() + 6000;
const flip = (async () => { const a = join(root, "real/race"), b = join(root, "real/race-dir"); mkdirSync(b); writeFileSync(join(b, "secret.txt"), "INSIDE");
  const { renameSync, unlinkSync } = await import("node:fs");
  while (Date.now() < stop) { try { renameSync(b, a); } catch {} await new Promise((r) => setImmediate(r)); try { renameSync(a, b); symlinkSync(out, a); } catch {} await new Promise((r) => setImmediate(r)); try { unlinkSync(a); } catch {} } })();
while (Date.now() < stop) { const x = await c.inFolder(root, ["real", "race"], c.readFiles, [["secret.txt"], 1000, 1000]); runs++; if (JSON.stringify(x).includes("HOST-SECRET")) hits++; }
await flip; r["race folder<->symlink: runs / outside reads"] = `${runs} / ${hits}`;
console.log(JSON.stringify(r, null, 1)); rmSync(t, { recursive: true, force: true });
