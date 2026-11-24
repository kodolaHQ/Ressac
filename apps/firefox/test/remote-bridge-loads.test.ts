import { expect, it } from "vitest";
import type { Rpc } from "../shared/rpc";
import { RemoteBridge } from "../host/remote-bridge";
import { LoadRefused } from "../../../packages/kernel/src/index.ts";

function setup(answer: () => Promise<unknown>) {
  const calls: { method: string; params: unknown[] }[] = [];
  const rpc = { request: (method: string, params: unknown[]) => (calls.push({ method, params }), answer()), notify() {} } as unknown as Rpc;
  return { calls, bridge: new RemoteBridge(rpc) };
}

it("agent loads send `allow` only when it restricts; a refused hop comes back as LoadRefused with its address", async () => {
  const { calls, bridge } = setup(async () => ({ id: "t" }));
  await bridge.navigate("t", "https://a.test/", { allow: null });
  await bridge.navigate("t", "https://a.test/", { allow: [] });
  await bridge.openTab("https://a.test/");
  await bridge.openTab("https://a.test/", undefined, { allow: ["https://a.test"] });
  await bridge.search!.open("W", { url: "https://a.test/" }, undefined, { allow: [] });
  await bridge.search!.openBackground("s", "https://a.test/", { allow: [] });
  expect(calls.map((c) => [c.method, c.params])).toEqual([
    ["navigate", ["t", "https://a.test/"]],
    ["navigate", ["t", "https://a.test/", { allow: [] }]],
    ["openTab", ["https://a.test/"]],
    ["openTab", ["https://a.test/", undefined, { allow: ["https://a.test"] }]],
    ["search.open", ["W", { url: "https://a.test/" }, undefined, { allow: [] }]],
    ["search.openBackground", ["s", "https://a.test/", { allow: [] }]],
  ]);

  const refused = setup(() => Promise.reject(Object.assign(new Error("x"), { name: "LoadRefused", url: "https://b.test/x" })));
  const e = await refused.bridge.navigate("t", "https://a.test/", { allow: [] }).catch((x) => x);
  expect(e).toBeInstanceOf(LoadRefused);
  expect(e.url).toBe("https://b.test/x");
});
