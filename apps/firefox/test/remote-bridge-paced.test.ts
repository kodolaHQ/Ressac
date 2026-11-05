import { describe, expect, it, vi } from "vitest";
import type { Rpc } from "../shared/rpc";
import { RemoteBridge } from "../noyau/remote-bridge";

const page = { url: "http://a.test/", titre: "", texte: "", liens: [] };
function setup(answer: () => Promise<unknown>) {
  const calls: { method: string; params: any[] }[] = [];
  const rpc = { request: (method: string, params: any[]) => (calls.push({ method, params }), answer()), notify() {} } as unknown as Rpc;
  return { calls, bridge: new RemoteBridge(rpc) };
}

describe("RemoteBridge paced reads", () => {
  it("sends an id as menagee, never changerHote nor signal, and relays the wait to the given changerHote", async () => {
    let release!: () => void;
    const { calls, bridge } = setup(() => new Promise((r) => (release = () => r(page))));
    const ch = vi.fn(async () => {});
    const read = bridge.lirePageInvisible("http://a.test/", { profil: null, changerHote: ch, signal: new AbortController().signal });
    const o = calls[0]!.params[1];
    expect(typeof o.menagee).toBe("string");
    expect(o).not.toHaveProperty("changerHote");
    expect(o).not.toHaveProperty("signal");
    await bridge.changerHote(o.menagee, "b.test");
    expect(ch).toHaveBeenCalledWith("b.test");
    release();
    await read;
  });

  it("forgets the read once it ends, succeeded or rejected", async () => {
    const ok = setup(async () => page);
    let id = "";
    ok.bridge.lirePageInvisible("http://a.test/", { profil: null, changerHote: async () => {} }).then(() => {});
    id = ok.calls[0]!.params[1].menagee;
    await new Promise((r) => setTimeout(r));
    await expect(ok.bridge.changerHote(id, "b.test")).rejects.toThrow("Lecture inconnue");

    const ko = setup(async () => Promise.reject(new Error("boom")));
    await expect(ko.bridge.lirePageInvisible("http://a.test/", { profil: null, changerHote: async () => {} })).rejects.toThrow("boom");
    await expect(ko.bridge.changerHote(ko.calls[0]!.params[1].menagee, "b.test")).rejects.toThrow("Lecture inconnue");
  });

  it("sends no menagee without changerHote", async () => {
    const { calls, bridge } = setup(async () => page);
    await bridge.lirePageInvisible("http://a.test/", { profil: null });
    expect(calls[0]!.params[1]).not.toHaveProperty("menagee");
  });
});
