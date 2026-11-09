import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  SPACE_FOLDER, FOLDER_NOT_FOUND, FOLDER_NOT_ABSOLUTE, FOLDER_TOO_LARGE, ExternalRegistry, deniedPort,
} from "../../src/design/external.js";
import { tempFolder } from "../helpers/temp.js";

const RANGES: [number, number][] = [[5280, 5299], [15280, 15284]];

async function frame() {
  const base = await tempFolder();
  const isPrivate = join(base, "design");
  const homeDir = join(base, "maison");
  const spaceRoot = join(base, "WebAiOs");
  await mkdir(homeDir, { recursive: true });
  await mkdir(spaceRoot, { recursive: true });
  const options = { ranges: RANGES, spaceRoot: spaceRoot, home: homeDir };
  const project = async (name: string) => { const d = join(homeDir, name); await mkdir(d, { recursive: true }); return d; };
  return { base, private: isPrivate, home: homeDir, spaceRoot: spaceRoot, options, project: project };
}

describe("ExternalRegistry", () => {
  test("brancher creates a client of which only the sha256 of the token is written; clientDuJeton returns it", async () => {
    const c = await frame();
    const r = await ExternalRegistry.open(c.private);
    const { client, token: token } = await r.connect("Mon Claude");
    expect(client.name).toBe("Mon Claude");
    expect(client.hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(r.tokenClient(token)?.id).toBe(client.id);
    expect(r.tokenClient("autre")).toBeNull();
    expect(r.tokenClient("")).toBeNull();
    const raw = await readFile(join(c.private, "external-clients.json"), "utf8");
    expect(raw).not.toContain(token);
    expect(raw).toContain(client.hash);
    expect((await r.connect("  ")).client.name).toBe("Claude Code");
    const reviewed = await ExternalRegistry.open(c.private);
    expect(reviewed.tokenClient(token)?.id).toBe(client.id);
  });

  test("the files have mode 0600, their folder 0700", async () => {
    const c = await frame();
    const r = await ExternalRegistry.open(c.private);
    const { client } = await r.connect("x");
    await r.declare(client.id, { folder: await c.project("p"), ports: [4321] }, c.options);
    expect((await stat(join(c.private, "external-clients.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(c.private, "external-projects.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(c.private)).mode & 0o777).toBe(0o700);
  });

  test("revoquer: the token no longer works, the projects stay with client null", async () => {
    const c = await frame();
    const r = await ExternalRegistry.open(c.private);
    const { client, token: token } = await r.connect("x");
    const { project: project } = await r.declare(client.id, { folder: await c.project("p"), ports: [4321] }, c.options);
    await r.revoke(client.id);
    expect(r.tokenClient(token)).toBeNull();
    expect(r.clients()).toEqual([]);
    expect(r.projects().find((p) => p.id === project.id)?.client).toBeNull();
  });

  test("declarer refuses invalid folders with the exact messages", async () => {
    const c = await frame();
    const r = await ExternalRegistry.open(c.private);
    const { client } = await r.connect("x");
    const denial = (folder: string) => r.declare(client.id, { folder: folder, ports: [4321] }, c.options);
    await expect(denial("relatif")).rejects.toThrow(FOLDER_NOT_ABSOLUTE);
    await expect(denial(join(c.home, "absent"))).rejects.toThrow(FOLDER_NOT_FOUND);
    const file = join(c.home, "f.txt");
    await writeFile(file, "x");
    await expect(denial(file)).rejects.toThrow(FOLDER_NOT_FOUND);
    await expect(denial("/")).rejects.toThrow(FOLDER_TOO_LARGE);
    await expect(denial(c.home)).rejects.toThrow(FOLDER_TOO_LARGE);
    await expect(denial(c.spaceRoot)).rejects.toThrow(SPACE_FOLDER);
    const sub = join(c.spaceRoot, "projects", "x");
    await mkdir(sub, { recursive: true });
    await expect(denial(sub)).rejects.toThrow(SPACE_FOLDER);
    const dotdot = join(c.spaceRoot, "..x", "p");
    await mkdir(dotdot, { recursive: true });
    await expect(denial(dotdot)).rejects.toThrow(SPACE_FOLDER);
    expect(FOLDER_NOT_ABSOLUTE).toBe("Le dossier doit être un chemin absolu.");
    expect(SPACE_FOLDER).toBe("Ce dossier est dans l'espace de WebAiOs : ses applis se relisent depuis la page Applications.");
    expect(r.projects()).toEqual([]);
  });

  test("declarer refuses out-of-range, non-integer or container ports; accepts 4321", async () => {
    const c = await frame();
    const r = await ExternalRegistry.open(c.private);
    const { client } = await r.connect("x");
    const folder = await c.project("p");
    for (const p of [80, 70000, 1.5, 5285, 15281]) {
      await expect(r.declare(client.id, { folder: folder, ports: [4321, p] }, c.options)).rejects.toThrow(deniedPort(p));
    }
    await expect(r.declare(client.id, { folder: folder, ports: [] }, c.options)).rejects.toThrow();
    await expect(r.declare(client.id, { folder: folder, ports: Array.from({ length: 11 }, (_, i) => 4000 + i) }, c.options)).rejects.toThrow();
    const { project: project } = await r.declare(client.id, { folder: folder, ports: [4321] }, c.options);
    expect(project.ports).toEqual([4321]);
  });

  test("declaring the same folder twice (including through a symbolic link): a single project updated", async () => {
    const c = await frame();
    const r = await ExternalRegistry.open(c.private);
    const a = (await r.connect("a")).client;
    const b = (await r.connect("b")).client;
    const folder = await c.project("p");
    const link = join(c.home, "lien");
    await symlink(folder, link);
    const one = await r.declare(a.id, { folder: folder, ports: [4321] }, c.options);
    const two = await r.declare(b.id, { folder: link, ports: [4322], name: "Beau" }, c.options);
    expect(one.first).toBe(true);
    expect(two.first).toBe(false);
    expect(r.projects()).toHaveLength(1);
    expect(two.project).toMatchObject({ id: one.project.id, ports: [4322], client: b.id, name: "Beau", folder: folder });
    expect(one.project.name).toBe("p");
    const three = await r.declare(b.id, { folder: folder, ports: [4322] }, c.options);
    expect(three.project.name).toBe("Beau");
  });

  test("a reclaimed port is removed from the other project", async () => {
    const c = await frame();
    const r = await ExternalRegistry.open(c.private);
    const { client } = await r.connect("x");
    const pa = await r.declare(client.id, { folder: await c.project("a"), ports: [4321, 4400] }, c.options);
    await r.declare(client.id, { folder: await c.project("b"), ports: [4321] }, c.options);
    expect(r.projects().find((p) => p.id === pa.project.id)?.ports).toEqual([4400]);
  });

  test("projetDe: only for the project's client, folder with trailing / accepted", async () => {
    const c = await frame();
    const r = await ExternalRegistry.open(c.private);
    const a = (await r.connect("a")).client;
    const b = (await r.connect("b")).client;
    const folder = await c.project("p");
    const { project: project } = await r.declare(a.id, { folder: folder, ports: [4321] }, c.options);
    expect(await r.projectOf(b.id, folder)).toBeNull();
    expect((await r.projectOf(a.id, `${folder}/`))?.id).toBe(project.id);
    expect(await r.projectOf(a.id, join(c.home, "absent"))).toBeNull();
  });

  test.skipIf(process.getuid?.() === 0)("folder chmod 000: declarer succeeds with lisible false", async () => {
    const c = await frame();
    const r = await ExternalRegistry.open(c.private);
    const { client } = await r.connect("x");
    const folder = await c.project("ferme");
    expect((await r.declare(client.id, { folder: await c.project("ouvert"), ports: [4400] }, c.options)).readable).toBe(true);
    await chmod(folder, 0o000);
    try {
      const res = await r.declare(client.id, { folder: folder, ports: [4321] }, c.options);
      expect(res.readable).toBe(false);
    } finally { await chmod(folder, 0o700); }
  });

  test("a external-clients.json under racineEspace/.webaios is never read", async () => {
    const c = await frame();
    const token = "jeton-pose-par-l-agent";
    await mkdir(join(c.spaceRoot, ".webaios"), { recursive: true });
    await writeFile(join(c.spaceRoot, ".webaios", "external-clients.json"), JSON.stringify([
      { id: "pirate", name: "p", hash: createHash("sha256").update(token).digest("hex"), created: "2026-11-02T10:00:00Z" },
    ]));
    const r = await ExternalRegistry.open(c.private);
    expect(r.clients()).toEqual([]);
    expect(r.tokenClient(token)).toBeNull();
  });

  test("an unreadable file is copied to .damaged-<date> and the registry starts empty again", async () => {
    const c = await frame();
    await mkdir(c.private, { recursive: true });
    await writeFile(join(c.private, "external-projects.json"), "{pas du json");
    const r = await ExternalRegistry.open(c.private);
    expect(r.projects()).toEqual([]);
    expect((await readdir(c.private)).some((f) => f.startsWith("external-projects.json.damaged-"))).toBe(true);
  });

  test("oublier removes the project; surChange is called after each write", async () => {
    const c = await frame();
    const r = await ExternalRegistry.open(c.private);
    let n = 0;
    const stop = r.onChange(() => { n++; });
    const { client } = await r.connect("x");
    const { project: project } = await r.declare(client.id, { folder: await c.project("p"), ports: [4321] }, c.options);
    await r.forget(project.id);
    expect(r.projects()).toEqual([]);
    expect(n).toBe(3);
    stop();
    await r.revoke(client.id);
    expect(n).toBe(3);
  });

  test("revoquer: if the write fails, the call is rejected and the client stays consistent with the disk", async () => {
    const c = await frame();
    const r = await ExternalRegistry.open(c.private);
    const { client, token: token } = await r.connect("x");
    const file = join(c.private, "external-clients.json");
    const content = await readFile(file, "utf8");
    await rm(file);
    await mkdir(join(file, "bloque"), { recursive: true }); // the file's rename on this folder fails
    await expect(r.revoke(client.id)).rejects.toThrow();
    expect(r.tokenClient(token)?.id).toBe(client.id);
    await rm(file, { recursive: true });
    await writeFile(file, content);
    expect((await ExternalRegistry.open(c.private)).tokenClient(token)?.id).toBe(client.id);
  });
});
