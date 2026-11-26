import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ApplicationManager, spacePaths, type Workshop } from "../../../../packages/kernel/src/index.ts";
import { createApplicationsHost } from "../../host/applications";

let root: string;
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

/** The host over a fresh data folder; « Supprimer » of `folder` settles on `done` (erased or refused). */
function host() {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ressac-app-remove-")));
  const paths = spacePaths(join(root, "data", "workspace"));
  mkdirSync(paths.projects, { recursive: true });
  const erased = vi.fn();
  let settle!: (v: string) => void;
  const done = new Promise<string>((r) => (settle = r));
  vi.spyOn(console, "error").mockImplementation(() => settle("refused"));
  const h = createApplicationsHost({
    paths, dataDir: join(root, "data"), workshop: {} as Workshop,
    chrome: { open: async () => {}, close: async () => {}, show: async () => true, erase: async () => {} },
    debug: () => {}, policy: () => null, broadcast: () => {}, lab: () => true,
    erased: (f) => (erased(f), settle("erased")),
  });
  const remove = (folder: string) => (h.handlers["apps.act"]!({ folder, action: "delete", window: "w" }), done);
  return { paths, erased, remove };
}

test("« Supprimer » erases the app folder and tells its review to go", async () => {
  const { paths, erased, remove } = host();
  mkdirSync(join(paths.projects, "essai", "src"), { recursive: true });
  writeFileSync(join(paths.projects, "essai", "src", "a.js"), "1");
  expect(await remove("essai")).toBe("erased");
  expect(existsSync(join(paths.projects, "essai"))).toBe(false);
  expect(erased).toHaveBeenCalledWith("essai");
});

test("« Supprimer » never deletes a Mac folder through a projects folder that is a link", async () => {
  const { paths, remove } = host();
  const mac = join(root, "mac");
  mkdirSync(join(mac, "essai"), { recursive: true });
  writeFileSync(join(mac, "essai", "precieux.txt"), "du Mac");
  rmSync(paths.projects, { recursive: true });
  symlinkSync(mac, paths.projects);
  expect(await remove("essai")).toBe("refused");
  expect(existsSync(join(mac, "essai", "precieux.txt"))).toBe(true);
});

test("during the sweep an agent launch is refused, a user's click waits for it, and no app comes back on its own", async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ressac-app-sweep-")));
  const h = createApplicationsHost({
    paths: spacePaths(join(root, "data", "workspace")), dataDir: join(root, "data"), workshop: {} as Workshop,
    chrome: { open: async () => {}, close: async () => {}, show: async () => true, erase: async () => {} },
    debug: () => {}, policy: () => null, broadcast: () => {}, lab: () => true,
  });
  const stopAll = vi.spyOn(h.manager, "stopAll").mockResolvedValue();
  const launched = vi.spyOn(ApplicationManager.prototype, "launch").mockResolvedValue({ folder: "essai", state: "running", port: 15280 } as never);
  let release!: () => void;
  const swept = h.whileStopped(() => new Promise<void>((r) => (release = r)));
  await vi.waitFor(() => expect(stopAll).toHaveBeenCalled());
  await expect(h.manager.launch("essai")).rejects.toThrow(/Lancement refusé/);
  h.handlers["apps.act"]!({ folder: "essai", action: "launch", window: "w" });
  await new Promise((r) => setTimeout(r, 20));
  expect(launched).not.toHaveBeenCalled();
  release();
  await swept;
  await vi.waitFor(() => expect(launched).toHaveBeenCalledTimes(1));
  expect(launched).toHaveBeenCalledWith("essai");
});

test("apps running before the sweep start again after it, their window on the new port", async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ressac-app-sweep-")));
  const opened: { folder: string; port: number }[] = [];
  const h = createApplicationsHost({
    paths: spacePaths(join(root, "data", "workspace")), dataDir: join(root, "data"), workshop: {} as Workshop,
    chrome: { open: async (a) => void opened.push({ folder: a.folder, port: a.port }), close: async () => {}, show: async () => true, erase: async () => {} },
    debug: () => {}, policy: () => null, broadcast: () => {}, lab: () => true,
  });
  vi.spyOn(h.manager, "list").mockResolvedValue([{ folder: "essai", state: "running", port: 15280 }, { folder: "vieux", state: "stopped" }] as never);
  vi.spyOn(h.manager, "stopAll").mockResolvedValue();
  const launched = vi.spyOn(ApplicationManager.prototype, "launch").mockResolvedValue({ folder: "essai", name: "Essai", state: "running", port: 15281 } as never);
  await h.whileStopped(async () => {});
  await vi.waitFor(() => expect(opened).toEqual([{ folder: "essai", port: 15281 }]));
  expect(launched).toHaveBeenCalledTimes(1);
  expect(launched).toHaveBeenCalledWith("essai");
});

test("the lab went off during the sweep: the apps it stopped stay stopped", async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ressac-app-sweep-")));
  let lab = true;
  const h = createApplicationsHost({
    paths: spacePaths(join(root, "data", "workspace")), dataDir: join(root, "data"), workshop: {} as Workshop,
    chrome: { open: async () => {}, close: async () => {}, show: async () => true, erase: async () => {} },
    debug: () => {}, policy: () => null, broadcast: () => {}, lab: () => lab,
  });
  vi.spyOn(h.manager, "list").mockResolvedValue([{ folder: "essai", state: "running", port: 15280 }] as never);
  vi.spyOn(h.manager, "stopAll").mockResolvedValue();
  const launched = vi.spyOn(ApplicationManager.prototype, "launch").mockResolvedValue({ folder: "essai", state: "running", port: 15281 } as never);
  await h.whileStopped(async () => void (lab = false));
  // whileStopped starts its relaunches synchronously after the sweep: none was asked for.
  expect(launched).not.toHaveBeenCalled();
});
