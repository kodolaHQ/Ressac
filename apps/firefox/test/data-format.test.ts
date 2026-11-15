import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FORMAT_FILE, RESET_FILE, backupDate, checkDataFormat } from "../core/state/format";

const NEW = '{"format":2}';
const tmp = async () => join(await mkdtemp(join(tmpdir(), "format-")), "data");
async function seed(dir: string, marker?: string) {
  await mkdir(join(dir, "workspace/projects"), { recursive: true });
  await writeFile(join(dir, "session.json"), "{}");
  await writeFile(join(dir, "workspace/projects/a.txt"), "a");
  await mkdir(join(dir, "ollama/0.40.13"), { recursive: true });
  if (marker !== undefined) await writeFile(join(dir, FORMAT_FILE), marker);
}
async function expectSetAside(dir: string, result: { backup: string; reason: string } | null) {
  expect(result?.reason).toBe("format");
  const backup = result?.backup ?? null;
  expect(backup).toMatch(new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.backup-`));
  expect(await readFile(join(backup!, "session.json"), "utf8")).toBe("{}");
  expect(await readFile(join(dir, "workspace/projects/a.txt"), "utf8")).toBe("a");
  expect(await readdir(backup!)).not.toContain("workspace");
  expect(await readdir(backup!)).not.toContain("ollama");
  expect(await readdir(join(dir, "ollama"))).toEqual(["0.40.13"]);
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
    expect((await readdir(dir)).sort()).toEqual([FORMAT_FILE, "ollama", "session.json", "workspace"]);
  });
  it("old marker", async () => {
    const dir = await tmp();
    await seed(dir, '{"store":2,"kernel":2}');
    const res = await checkDataFormat(dir);
    await expectSetAside(dir, res);
    const backup = res!.backup;
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
    expect(second?.backup).toBe(`${first?.backup}-1`);
  });
  it("no workspace", async () => {
    const dir = await tmp();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "session.json"), "{}");
    const backup = (await checkDataFormat(dir))?.backup;
    expect(await readFile(join(backup!, "session.json"), "utf8")).toBe("{}");
    expect(await readdir(dir)).toEqual([FORMAT_FILE]);
  });
  it("partial failure leaves workspace in place and the next call completes", async () => {
    const dir = await tmp();
    await seed(dir, "{");
    await mkdir(join(dir, "stuck"));
    await chmod(join(dir, "stuck"), 0o555); // a directory without write permission cannot be renamed across parents
    await expect(checkDataFormat(dir)).rejects.toThrow();
    expect(await readFile(join(dir, "workspace/projects/a.txt"), "utf8")).toBe("a");
    expect(await readdir(dir)).not.toContain(FORMAT_FILE); // never written on failure
    await chmod(join(dir, "stuck"), 0o755);
    const backup = await checkDataFormat(dir);
    expect(backup).not.toBeNull();
    expect(await readFile(join(dir, "workspace/projects/a.txt"), "utf8")).toBe("a");
    expect((await readdir(dir)).sort()).toEqual([FORMAT_FILE, "ollama", "workspace"]);
    expect(await readFile(join(dir, FORMAT_FILE), "utf8")).toBe(NEW);
  });
  it("partial failure during a reset keeps the request for the next start", async () => {
    const dir = await tmp();
    await seed(dir, NEW);
    await writeFile(join(dir, RESET_FILE), "");
    await mkdir(join(dir, "stuck"));
    await chmod(join(dir, "stuck"), 0o555);
    await expect(checkDataFormat(dir)).rejects.toThrow();
    expect(await readdir(dir)).toContain(RESET_FILE);
    await chmod(join(dir, "stuck"), 0o755);
    expect((await checkDataFormat(dir))?.reason).toBe("reset");
    expect((await readdir(dir)).sort()).toEqual([FORMAT_FILE, "ollama", "workspace"]);
  });
  it("reset requested", async () => {
    const dir = await tmp();
    await seed(dir, NEW);
    await writeFile(join(dir, RESET_FILE), "");
    const res = await checkDataFormat(dir);
    expect(res?.reason).toBe("reset");
    expect((await readdir(res!.backup)).sort()).toEqual([FORMAT_FILE, "session.json"]);
    expect(await readFile(join(dir, "workspace/projects/a.txt"), "utf8")).toBe("a");
    expect(await readdir(dir)).not.toContain(RESET_FILE);
    expect(await checkDataFormat(dir)).toBeNull();
  });
});

describe("backupDate", () => {
  const ts = "2026-11-10T13-35-12-345Z";
  it("recognises what checkDataFormat writes", () => {
    expect(backupDate("/u/Ressac", `/u/Ressac.backup-${ts}`)).toBe("2026-11-10T13:35:12.345Z");
    expect(backupDate("/u/Ressac", `/u/Ressac.backup-${ts}-1`)).toBe("2026-11-10T13:35:12.345Z");
  });
  it("rejects anything else", () => {
    for (const p of ["/u/Ressac", "/u/Ressac.backup-x", `/u/Ressac.backup-${ts}/../x`, `/u/Autre.backup-${ts}`]) expect(backupDate("/u/Ressac", p)).toBeNull();
  });
});
