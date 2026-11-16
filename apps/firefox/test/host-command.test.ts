import { beforeAll, describe, expect, it } from "vitest";

let hostCommand: typeof import("../chrome/agent/command").hostCommand;

beforeAll(async () => {
  // Build-time defines in the real bundle; plain globals under vitest.
  Object.assign(globalThis, { __RESSAC_NODE__: "/dev/node", __RESSAC_TSX__: "/dev/tsx", __RESSAC_HOST__: "/dev/host.ts", __RESSAC_LLAMA__: "/dev/llama-server" });
  ({ hostCommand } = await import("../chrome/agent/command"));
});

describe("hostCommand", () => {
  it("bundled: runs the shipped node and host.mjs", async () => {
    const seen: string[] = [];
    const c = await hostCommand("/App/Resources", async (p) => (seen.push(p), true));
    expect(seen).toEqual(["/App/Resources/ressac-host/host.mjs"]);
    expect(c).toEqual({
      command: "/App/Resources/ressac-host/node",
      arguments: ["/App/Resources/ressac-host/host.mjs"],
      environment: { RESSAC_KERNEL_RESOURCES: "/App/Resources/ressac-host/kernel", RESSAC_LLAMA_SERVER: "/App/Resources/ressac-host/llama/llama-server" },
    });
  });

  it("dev: falls back to the build constants", async () => {
    expect(await hostCommand("/App/Resources", async () => false)).toEqual({
      command: "/dev/node",
      arguments: ["--import", "/dev/tsx", "/dev/host.ts"],
      environment: { RESSAC_LLAMA_SERVER: "/dev/llama-server" },
    });
  });

  it("packaged without the host: throws instead of using dev paths", async () => {
    const g = globalThis as any;
    const saved = g.__RESSAC_HOST__;
    g.__RESSAC_HOST__ = "";
    try {
      await expect(hostCommand("/App/Resources", async () => false)).rejects.toThrow("agent host is missing");
    } finally {
      g.__RESSAC_HOST__ = saved;
    }
  });
});
