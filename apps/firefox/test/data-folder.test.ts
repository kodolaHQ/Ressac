import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDataFormat } from "../core/state/format";
import { EXPORT_EXCLUDED, deleteBackup, exportData, listBackups } from "../host/data-folder";

const tmp = async () => join(await mkdtemp(join(tmpdir(), "folder-")), "WebAiOs");
const exists = (p: string) => stat(p).then(() => true, () => false);
async function seed(dir: string) {
  await mkdir(join(dir, "workspace/projects"), { recursive: true });
  await writeFile(join(dir, "session.json"), "{}");
  await writeFile(join(dir, "workspace/projects/a.txt"), "a");
}

describe("data folder", () => {
  it("lists backups", async () => {
    const dir = await tmp();
    await seed(dir);
    const a = (await checkDataFormat(dir, new Date("2026-01-01T00:00:00Z")))!.backup;
    await seed(dir);
    await writeFile(join(dir, ".format-version"), "{");
    const b = (await checkDataFormat(dir, new Date("2026-02-01T00:00:00Z")))!.backup;
    await mkdir(`${dir}.old`);
    const list = await listBackups(dir);
    expect(list.map((x) => x.path)).toEqual([b, a]);
    expect(list[0]?.date).toBe("2026-02-01T00:00:00.000Z");
    for (const x of list) {
      expect(x.bytes).toBeGreaterThan(0);
      expect(x.bytes % 1024).toBe(0);
    }
  });

  it("deletes only a backup", async () => {
    const dir = await tmp();
    await seed(dir);
    const backup = (await checkDataFormat(dir))!.backup;
    const link = `${dir}.backup-2026-01-01T00-00-00-000Z`;
    await symlink(dir, link);
    for (const p of [dir, join(dir, "workspace"), `${backup}/../x`, link]) await expect(deleteBackup(dir, p)).rejects.toThrow("Sauvegarde inconnue");
    expect(await exists(join(dir, "workspace/projects/a.txt"))).toBe(true);
    expect(await exists(backup)).toBe(true);
    await deleteBackup(dir, backup);
    expect(await exists(backup)).toBe(false);
  });

  it("export", async () => {
    const dir = await tmp();
    await seed(dir);
    for (const f of ["widgets/w/state.json", "local-ai/kev/x", "webaios-widgets/y", "import-tmp/chrome/Login Data"]) {
      await mkdir(join(dir, f, ".."), { recursive: true });
      await writeFile(join(dir, f), "x");
    }
    const to = await mkdtemp(join(tmpdir(), "out-"));
    const now = new Date("2026-11-10T10:00:00Z");
    const out = await exportData(dir, to, now);
    const out2 = await exportData(dir, to, now);
    expect(out).toBe(join(to, "WebAiOs-donnees-2026-11-10.zip"));
    expect(out2).toBe(join(to, "WebAiOs-donnees-2026-11-10 (2).zip"));
    const entries = execFileSync("unzip", ["-Z1", out], { encoding: "utf8" }).split("\n").filter(Boolean);
    expect(entries).toContain("session.json");
    expect(entries).toContain("widgets/w/state.json");
    expect(entries.filter((e) => EXPORT_EXCLUDED.some((n) => e.startsWith(n)))).toEqual([]);
  });
});
