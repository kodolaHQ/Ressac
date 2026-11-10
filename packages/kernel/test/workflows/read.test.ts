import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkflow, type ValidationResult } from "../../src/index.js";

const errorOf = (r: ValidationResult | undefined) => (r && !r.ok ? r.error : undefined);

let root: string;
let folder: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wf-lire-"));
  folder = join(root, "widget");
  await mkdir(folder);
});
afterEach(() => rm(root, { recursive: true, force: true }));

const valid = {
  version: 1,
  blocks: [{ id: "a", type: "code", params: { source: "a.mjs" } }, { id: "s", type: "output", params: { to: "widget" } }],
  links: [{ from: "a", to: "s" }],
};

test("workflow.json wins over harvest.mjs", async () => {
  await writeFile(join(folder, "workflow.json"), JSON.stringify(valid));
  await writeFile(join(folder, "harvest.mjs"), "export default () => 1");
  const parsed = await readWorkflow(folder);
  expect(parsed?.origin).toBe("file");
  expect(parsed?.result.ok && parsed.result.valid.order).toEqual(["a", "s"]);
});

test("harvest.mjs alone gives the implicit workflow", async () => {
  await writeFile(join(folder, "harvest.mjs"), "export default () => 1");
  const parsed = await readWorkflow(folder);
  expect(parsed?.origin).toBe("implicit");
  expect(parsed?.result.ok && parsed.result.valid.order).toEqual(["harvest", "output"]);
});

test("neither: null", async () => {
  expect(await readWorkflow(folder)).toBeNull();
});

test("a workflow.json cut in the middle gives a clear error", async () => {
  await writeFile(join(folder, "workflow.json"), '{ "version": 1, "blocks": [ { "id": "a", ');
  const parsed = await readWorkflow(folder);
  expect(parsed?.result.ok).toBe(false);
  expect(errorOf(parsed?.result)).toBe("Workflow invalide : workflow.json illisible (pas du JSON valide)");
});

test("a workflow.json over 256 KB is refused", async () => {
  await writeFile(join(folder, "workflow.json"), JSON.stringify({ ...valid, fill: "x".repeat(300 * 1024) }));
  const parsed = await readWorkflow(folder);
  expect(errorOf(parsed?.result)).toBe("Workflow invalide : workflow.json dépasse 256 Ko");
});

test("a symbolic link that leaves the folder is refused", async () => {
  const outside = join(root, "dehors.json");
  await writeFile(outside, JSON.stringify(valid));
  await symlink(outside, join(folder, "workflow.json"));
  const parsed = await readWorkflow(folder);
  expect(errorOf(parsed?.result)).toContain("sort du dossier du widget");
});

test("a workflow.json as a broken symbolic link is invalid, without falling back to harvest.mjs nor a path in the message", async () => {
  await writeFile(join(folder, "harvest.mjs"), "export default () => 1");
  await symlink(join(folder, "absent.json"), join(folder, "workflow.json"));
  const parsed = await readWorkflow(folder);
  expect(parsed?.origin).toBe("file");
  expect(errorOf(parsed?.result)).toBe("Workflow invalide : workflow.json illisible");
});
