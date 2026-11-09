import { afterEach, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewStore, reviewStore, externalProject, ExternalRegistry, Remarks } from "@webaios/kernel";
import { startExternals } from "../../core/design/external";

const folders: string[] = [];
const services: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.stop();
  for (const d of folders.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function prepare(port: number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "webaios-externes-")));
  folders.push(root);
  const designFolders = { spaceRemarks: join(root, "workspace", ".webaios", "remarks"), private: join(root, "prive") };
  mkdirSync(designFolders.private, { recursive: true });
  const registry = await ExternalRegistry.open(designFolders.private);
  const service = await startExternals({
    registry: registry, remarks: new Remarks({ folders: designFolders }), folders: designFolders, port, ranges: [],
    spaceRoot: join(root, "workspace"), home: root, notify: () => undefined,
  });
  services.push(service);
  return { root: root, designFolders: designFolders, service };
}

test("a start that fails other than by a taken port (invalid port): off, with the reason", async () => {
  const { service } = await prepare(Number("abc"));
  const state = service.state().server;
  expect(state.state).toBe("eteint");
  if (state.state === "eteint") expect(state.reason).toMatch(/^Le MCP externe n'a pas pu démarrer : /);
  await expect(service.connect("x")).rejects.toThrow(/n'a pas pu démarrer/);
});

test("forgetting during the first photo: the private review repository does not come back", async () => {
  const { root: root, designFolders: designFolders, service } = await prepare(0);
  const project = join(root, "site");
  mkdirSync(project);
  for (let i = 0; i < 50; i++) writeFileSync(join(project, `f${i}.txt`), `${i}\n`);
  const id = "0123456789abcdef";
  const repo = reviewStore(designFolders, externalProject(id));
  const photo = new ReviewStore({ repo, folder: project }).ensureReference().catch(() => undefined);
  await service.forget(id);
  await photo;
  expect(existsSync(repo)).toBe(false);
});
