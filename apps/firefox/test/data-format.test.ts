import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FORMAT_FILE, checkDataFormat } from "../core/state/format";

const NEW = '{"format":2}';
const tmp = async () => join(await mkdtemp(join(tmpdir(), "format-")), "data");
async function seed(dir: string, marker?: string) {
  await mkdir(join(dir, "workspace/projects"), { recursive: true });
  await writeFile(join(dir, "session.json"), "{}");
  await writeFile(join(dir, "workspace/projects/a.txt"), "a");
  if (marker !== undefined) await writeFile(join(dir, FORMAT_FILE), marker);
}
async function expectSetAside(dir: string, backup: string | null) {
  expect(backup).toMatch(new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.backup-`));
  expect(await readFile(join(backup!, "session.json"), "utf8")).toBe("{}");
  expect(await readFile(join(dir, "workspace/projects/a.txt"), "utf8")).toBe("a");
  expect(await readdir(backup!)).not.toContain("workspace");
  expect(await readFile(join(dir, FORMAT_FILE), "utf8")).toBe(NEW);
}

describe("checkDataFormat", () => {
  it("fresh folder", async () => {
    const dir = await tmp();
    expect(await checkDataFormat(dir)).toBeNull();
    expect(await readFile(join(dir, FORMAT_FILE), "utf8")).toBe(NEW);
  });
  it("known format", async () => {
    const dir = await tmp();
    await seed(dir, NEW);
    expect(await checkDataFormat(dir)).toBeNull();
    expect((await readdir(dir)).sort()).toEqual([FORMAT_FILE, "session.json", "workspace"]);
  });
  it("old marker", async () => {
    const dir = await tmp();
    await seed(dir, '{"store":2,"kernel":2}');
    const backup = await checkDataFormat(dir);
    await expectSetAside(dir, backup);
    expect(await readFile(join(backup!, FORMAT_FILE), "utf8")).toBe('{"store":2,"kernel":2}');
  });
  it("no marker", async () => {
    const dir = await tmp();
    await seed(dir);
    await expectSetAside(dir, await checkDataFormat(dir));
  });
  it("unreadable marker", async () => {
    const dir = await tmp();
    await seed(dir, "{");
    await expectSetAside(dir, await checkDataFormat(dir));
  });
  it("same instant twice", async () => {
    const dir = await tmp();
    const now = new Date("2026-01-01T00:00:00Z");
    await seed(dir);
    const first = await checkDataFormat(dir, now);
    await writeFile(join(dir, FORMAT_FILE), "{");
    const second = await checkDataFormat(dir, now);
    expect(second).toBe(`${first}-1`);
  });
});
