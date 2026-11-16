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
    debug: () => {}, policy: () => null, broadcast: () => {},
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
    debug: () => {}, policy: () => null, broadcast: () => {},
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
