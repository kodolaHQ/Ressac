import { beforeEach, expect, it, vi } from "vitest";

// The one-time uninstall of the agent's add-ons (chrome/store/extensions-removal.ts), with a fake AddonManager.
const DONE = "ressac.agentExtensionsRemoved";
const prefs = new Map<string, boolean>();
let addons: { id: string; uninstall: () => Promise<void> }[] = [];
const uninstalled: string[] = [];

(globalThis as any).ChromeUtils = {
  importESModule: () => ({ AddonManager: { readyPromise: Promise.resolve(), getAddonsByTypes: async () => addons } }),
};
(globalThis as any).Services = {
  prefs: {
    getBoolPref: (k: string, d: boolean) => prefs.get(k) ?? d,
    setBoolPref: (k: string, v: boolean) => void prefs.set(k, v),
    getChildList: (root: string) => [...prefs.keys()].filter((k) => k.startsWith(root)),
    clearUserPref: (k: string) => void prefs.delete(k),
  },
};
const { removeAgentAddons } = await import("../chrome/store/extensions-removal");

const addon = (id: string, fail = false) => ({ id, uninstall: vi.fn(async () => { if (fail) throw new Error("busy"); uninstalled.push(id); }) });
const AGENT_EXEMPT = "extensions.quarantineIgnoredByUser.a@agent.ressac";
const USER_EXEMPT = "extensions.quarantineIgnoredByUser.b@user";

beforeEach(() => {
  prefs.clear();
  uninstalled.length = 0;
  prefs.set(AGENT_EXEMPT, true);
  prefs.set(USER_EXEMPT, true);
});

it("uninstalls only the agent's add-ons, clears only their exemptions, then marks it done", async () => {
  // Ids that merely contain the suffix are the user's.
  addons = [addon("a@agent.ressac"), addon("b@user"), addon("x@agent.ressac.example")];
  await removeAgentAddons();
  expect(uninstalled).toEqual(["a@agent.ressac"]);
  expect(prefs.has(AGENT_EXEMPT)).toBe(false);
  expect(prefs.get(USER_EXEMPT)).toBe(true);
  expect(prefs.get(DONE)).toBe(true);
  // Once done, a later launch looks at nothing.
  addons = [addon("c@agent.ressac")];
  await removeAgentAddons();
  expect(uninstalled).toEqual(["a@agent.ressac"]);
});

it("a failed uninstall leaves the marker unset, so the next launch tries again", async () => {
  addons = [addon("a@agent.ressac", true)];
  await expect(removeAgentAddons()).rejects.toThrow("busy");
  expect(prefs.has(DONE)).toBe(false);
  addons = [addon("a@agent.ressac")];
  await removeAgentAddons();
  expect(uninstalled).toEqual(["a@agent.ressac"]);
  expect(prefs.get(DONE)).toBe(true);
});
