import { beforeAll, describe, expect, it } from "vitest";

let hostCommand: typeof import("../chrome/agent/command").hostCommand;

beforeAll(async () => {
  // Build-time defines in the real bundle; plain globals under vitest.
  Object.assign(globalThis, { __WEBAIOS_NODE__: "/dev/node", __WEBAIOS_TSX__: "/dev/tsx", __WEBAIOS_HOST__: "/dev/host.ts" });
  ({ hostCommand } = await import("../chrome/agent/command"));
});

describe("hostCommand", () => {
  it("bundled: runs the shipped node and host.mjs", async () => {
    const seen: string[] = [];
    const c = await hostCommand("/App/Resources", async (p) => (seen.push(p), true));
    expect(seen).toEqual(["/App/Resources/webaios-host/host.mjs"]);
    expect(c).toEqual({
      command: "/App/Resources/webaios-host/node",
      arguments: ["/App/Resources/webaios-host/host.mjs"],
      environment: { WEBAIOS_KERNEL_RESOURCES: "/App/Resources/webaios-host/kernel" },
    });
  });

  it("dev: falls back to the build constants", async () => {
    expect(await hostCommand("/App/Resources", async () => false)).toEqual({
      command: "/dev/node",
      arguments: ["--import", "/dev/tsx", "/dev/host.ts"],
      environment: {},
    });
  });
});
