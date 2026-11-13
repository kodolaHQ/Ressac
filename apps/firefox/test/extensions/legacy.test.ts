// The agent's extensions installed before the rename to Ressac, under the old add-on id `<folder>@agent.webaios`: the
// chrome uninstalls them (test/agent-extensions.test.ts), the host forgets them so the agent asks for them again.
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DEFAULT_GUARDS, prepareCopy } from "../../../../packages/kernel/src/index.ts";
import { ExtensionsAgent } from "../../host/extensions/agent.ts";

const GRANT = { permissions: [], hosts: [], network: [], allSites: false, allSitesScripts: false, scripts: false };
const entry = (addonId: string | null, granted = true) => ({
  source: "agent",
  addonId,
  name: "x",
  version: "1.0.0",
  grant: granted ? GRANT : null,
  profiles: ["default"],
  pinned: true,
  modifiedAt: null,
  disabled: null,
  pendingUpdate: null,
  seenVersions: {},
});

async function setup(extensions: Record<string, object>) {
  const base = await mkdtemp(join(tmpdir(), "legacy-ext-"));
  const folder = join(base, "data", "extensions");
  const agentFolder = join(base, "workspace", "extensions");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "state.json"), JSON.stringify({ version: 1, allCut: false, extensions }));
  const requests: unknown[][] = [];
  const rpc = { notify: () => {}, request: async (...a: unknown[]) => (requests.push(a), a[0] === "browser.spaces" ? { spaces: [], windows: [] } : null) };
  // RESSAC_TEST_AMO_URL without keys: nothing is ever signed, and no keychain is read.
  const agent = new ExtensionsAgent({ folder, agentFolder, rpc: rpc as never, env: { RESSAC_TEST_AMO_URL: "http://127.0.0.1:9" } });
  return { folder, agentFolder, agent, requests, state: async () => JSON.parse(await readFile(join(folder, "state.json"), "utf8")) };
}

test("an entry installed under the old add-on id is dropped at start; the source folder stays", async () => {
  const s = await setup({ "agent:foo": entry("foo@agent.webaios"), "agent:bar": entry("bar@agent.ressac", false), "agent:new": entry(null, false) });
  await mkdir(join(s.agentFolder, "foo"), { recursive: true });
  await s.agent.start();
  expect(Object.keys((await s.state()).extensions).sort()).toEqual(["agent:bar", "agent:new"]);
  await access(join(s.agentFolder, "foo"));
});

test("a signed .xpi kept from before the rename is never installed again: it carries the old id", async () => {
  const s = await setup({ "agent:bar": entry("bar@agent.ressac") });
  const source = join(s.agentFolder, "bar");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Bar", version: "1.0.0" }));
  const { hash } = await prepareCopy({ source, target: join(s.folder, "probe"), keptFolder: DEFAULT_GUARDS });
  await mkdir(join(s.folder, "signed"), { recursive: true });
  await writeFile(join(s.folder, "signed", "bar.xpi"), "old");
  // As written before the rename: no add-on id in the record.
  await writeFile(join(s.folder, "signed", "bar.json"), JSON.stringify({ version: "1.0.0.1", hash }));
  await s.agent.start();
  expect(s.requests.filter((r) => r[0] === "extensions.install")).toEqual([]);
});
