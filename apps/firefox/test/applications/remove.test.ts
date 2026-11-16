import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { spacePaths, type Workshop } from "../../../../packages/kernel/src/index.ts";
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

test("an app running before the sweep is stopped cleanly around it and launched again after", async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ressac-app-sweep-")));
  const h = createApplicationsHost({
    paths: spacePaths(join(root, "data", "workspace")), dataDir: join(root, "data"), workshop: {} as Workshop,
    chrome: { open: async () => {}, close: async () => {}, show: async () => true, erase: async () => {} },
    debug: () => {}, policy: () => null, broadcast: () => {},
  });
  const order: string[] = [];
  vi.spyOn(h.manager, "list").mockResolvedValue([{ folder: "essai", state: "running" }, { folder: "autre", state: "stopped" }] as never);
  vi.spyOn(h.manager, "stopAll").mockImplementation(async () => void order.push("stopAll"));
  vi.spyOn(h.manager, "launch").mockImplementation(async (f) => (order.push(`launch ${f}`), {}) as never);
  await h.whileStopped(async () => void order.push("sweep"));
  expect(order).toEqual(["stopAll", "sweep", "launch essai"]);
});
