import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPassportImporter } from "../chrome/passport/import";
import type { FoundAddress } from "../chrome/passport/addresses";

const line = (o: Partial<FoundAddress>): FoundAddress => ({ given: "", family: "", full: "", street: "", postcode: "", city: "", country: "", tel: "", email: "", usedAt: 0, useCount: 0, ...o });
const camille = line({ given: "Camille", family: "Aubrac", street: "14 rue des Tanneurs", postcode: "69001", city: "Lyon", tel: "0612345678", usedAt: 2 });
const jean = line({ given: "Jean", family: "Martin", street: "1 rue Autre", postcode: "13001", city: "Marseille", usedAt: 1 });

function setup(o: { ok?: boolean; found?: FoundAddress[] } = {}) {
  const addMany = vi.fn(async (_h: any) => (o.ok === false ? ({ ok: false, error: "cancelled" } as const) : ({ ok: true, added: 1, variants: 0, full: 0, invalid: 0 } as const)));
  const read = vi.fn(async () => o.found ?? [camille, jean]);
  const remove = vi.fn(async (_guids: string[]) => {});
  const store = vi.fn(async () => ({ records: [{ guid: "g1", "given-name": "Camille", "family-name": "Aubrac", "street-address": "14 rue des Tanneurs", "postal-code": "69001", "address-level2": "Lyon" }], remove }));
  const i = createPassportImporter({ home: "/h", scratch: "/s", passport: { addMany }, exists: async () => true, read, ressacStore: store, reason: () => "ajouter des adresses à votre passeport" });
  return { i, addMany, remove, read };
}

const ioRemove = vi.fn(async (_path: string, _o: unknown) => {});
beforeEach(() => {
  ioRemove.mockClear();
  vi.stubGlobal("IOUtils", { remove: ioRemove });
});

describe("passport import", () => {
  it("a copy left by a crash is removed, and the first read waits for it", async () => {
    let done!: () => void;
    ioRemove.mockImplementationOnce(() => new Promise<void>((r) => (done = r)));
    const { i, read } = setup();
    expect(ioRemove).toHaveBeenCalledWith("/s", { recursive: true, ignoreAbsent: true });
    const p = i.proposals("chrome");
    await new Promise((r) => setTimeout(r, 0));
    expect(read).not.toHaveBeenCalled();
    done();
    expect((await p).proposals.length).toBeGreaterThan(0);
    expect(read).toHaveBeenCalled();
  });

  it("Safari, which is not read, is not offered", async () => {
    const { i } = setup();
    expect((await i.sources()).map((d) => d.id)).not.toContain("safari");
  });

  it("a name with half an address: counted incomplete, its Firefox record never erased", async () => {
    const remove = vi.fn(async (_g: string[]) => {});
    const records = [{ guid: "c1", "given-name": "Camille", "family-name": "Aubrac", "street-address": "12 rue des Tanneurs" }];
    const addMany = vi.fn(async (_h: any) => ({ ok: true, added: 1, variants: 0, full: 0, invalid: 0 }) as const);
    const i = createPassportImporter({ home: "/h", scratch: "/s", passport: { addMany }, reason: () => "r", ressacStore: async () => ({ records, remove }) });
    const r = await i.proposals("ressac");
    expect(r.incomplete).toBe(1);
    expect(r.proposals).toEqual([expect.objectContaining({ given: "Camille", family: "Aubrac", address: "" })]);
    await i.add("default", [{ key: r.proposals[0]!.key, as: "me" }], "ressac", true);
    expect(addMany).toHaveBeenCalled();
    expect(remove.mock.calls.flatMap((c) => c[0])).toEqual([]);
  });

  it("a key from an earlier read names the same content or nothing, never another line", async () => {
    const remove = vi.fn(async (_g: string[]) => {});
    const c = { guid: "c1", "given-name": "Camille", "family-name": "Aubrac", email: "camille@example.fr" };
    const j = { guid: "j1", "given-name": "Jean", "family-name": "Martin", email: "jean@example.fr" };
    let records = [c, j];
    const addMany = vi.fn(async (_h: any) => ({ ok: true, added: 1, variants: 0, full: 0, invalid: 0 }) as const);
    const i = createPassportImporter({ home: "/h", scratch: "/s", passport: { addMany }, reason: () => "r", ressacStore: async () => ({ records, remove }) });
    const l1 = (await i.proposals("ressac")).proposals;
    const kc = l1.find((p) => p.given === "Camille")!.key, kj = l1.find((p) => p.given === "Jean")!.key;
    records = [j]; // the other card re-reads a source where Camille is gone
    await i.proposals("ressac");
    await i.add("default", [{ key: kc, as: "me" }], "ressac", true);
    expect(addMany).not.toHaveBeenCalled();
    await i.add("default", [{ key: kj, as: "me" }], "ressac", true);
    expect(addMany.mock.calls[0]![0].drafts.map((d: any) => d.value)).toContainEqual({ text: "jean@example.fr" });
    expect(remove.mock.calls.flatMap((c) => c[0])).toEqual(["j1"]);
  });

  it("a value the passport refuses is left out and counted incomplete, and its record is kept", async () => {
    const remove = vi.fn(async (_g: string[]) => {});
    const records = [
      { guid: "c1", "given-name": "Camille", "family-name": "Aubrac", "street-address": "14 rue des Tanneurs", "postal-code": "69001", "address-level2": "Lyon", tel: "12" },
      { guid: "j1", "given-name": "Jean", "family-name": "Martin", email: "jean@example.fr" },
    ];
    const addMany = vi.fn(async (_h: any) => ({ ok: true, added: 2, variants: 0, full: 0, invalid: 0 }) as const);
    const i = createPassportImporter({ home: "/h", scratch: "/s", passport: { addMany }, reason: () => "r", ressacStore: async () => ({ records, remove }) });
    const r = await i.proposals("ressac");
    expect(r.incomplete).toBe(1);
    const c = r.proposals.find((p) => p.given === "Camille")!;
    expect(c.tel).toBe("");
    const j = r.proposals.find((p) => p.given === "Jean")!;
    await i.add("default", [{ key: c.key, as: "me" }, { key: j.key, as: "me" }], "ressac", true);
    expect(JSON.stringify(addMany.mock.calls[0]![0].drafts)).not.toContain('"12"');
    expect(remove).toHaveBeenCalledWith(["j1"]);
  });

  it("add sends no values from the page: rows are keys", async () => {
    const { i, addMany } = setup();
    const { proposals } = await i.proposals("chrome");
    const me = proposals.find((p) => p.given === "Camille")!;
    await i.add("default", [{ key: me.key, as: "me", given: "Evil", value: "x" } as any], "chrome");
    const h = addMany.mock.calls[0]![0];
    expect(h).toMatchObject({ profile: "default", how: "import", origin: null, reason: "ajouter des adresses à votre passeport" });
    expect(JSON.stringify(h.drafts)).toContain("Aubrac");
    expect(JSON.stringify(h.drafts)).not.toContain("Evil");
  });

  it("an unknown key is ignored, and nothing is asked when no row is left", async () => {
    const { i, addMany } = setup();
    await i.proposals("chrome");
    const r = await i.add("default", [{ key: "p99", as: "me" }], "chrome");
    expect(addMany).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, added: 0 });
  });

  it("proche rows write only the name", async () => {
    const { i, addMany } = setup();
    const { proposals } = await i.proposals("chrome");
    const other = proposals.find((p) => p.given === "Jean")!;
    await i.add("default", [{ key: other.key, as: "proche" }], "chrome");
    expect(addMany.mock.calls[0]![0].drafts).toEqual([{ field: "proche", value: { given: "Jean", family: "Martin" } }]);
  });

  it("a source other than the last proposed one is refused", async () => {
    const { i, addMany } = setup();
    const { proposals } = await i.proposals("chrome");
    const r = await i.add("default", [{ key: proposals[0]!.key, as: "me" }], "brave");
    expect(r.ok).toBe(false);
    expect(addMany).not.toHaveBeenCalled();
  });

  it("erase removes only the ticked rows' Firefox records", async () => {
    const remove = vi.fn(async (_g: string[]) => {});
    const rec = (guid: string, given: string, family: string, street: string) => ({ guid, "given-name": given, "family-name": family, "street-address": street, "postal-code": "69001", "address-level2": "Lyon" });
    const records = [rec("a1", "Camille", "Aubrac", "14 rue des Tanneurs"), rec("a2", "Camille", "Aubrac", "14 rue des Tanneurs"), rec("j1", "Jean", "Martin", "1 rue Autre")];
    const addMany = vi.fn(async (_h: any) => ({ ok: true, added: 1, variants: 0, full: 0, invalid: 0 }) as const);
    const i = createPassportImporter({ home: "/h", scratch: "/s", passport: { addMany }, reason: () => "r", ressacStore: async () => ({ records, remove }) });
    const { proposals } = await i.proposals("ressac");
    const camille = proposals.find((p) => p.given === "Camille")!;
    await i.add("default", [{ key: camille.key, as: "me" }], "ressac", true);
    expect(remove).toHaveBeenCalledWith(["a1", "a2"]);
    expect(addMany.mock.calls[0]![0].from).toBe("ressac");
  });

  it("full or invalid drafts, or a proche row: nothing is erased", async () => {
    const run = async (result: any, as: "me" | "proche") => {
      const remove = vi.fn(async (_g: string[]) => {});
      const records = [{ guid: "a1", "given-name": "Camille", "family-name": "Aubrac", "street-address": "14 rue des Tanneurs", "postal-code": "69001", "address-level2": "Lyon" }];
      const i = createPassportImporter({ home: "/h", scratch: "/s", passport: { addMany: async () => result }, reason: () => "r", ressacStore: async () => ({ records, remove }) });
      const { proposals } = await i.proposals("ressac");
      await i.add("default", [{ key: proposals[0]!.key, as }], "ressac", true);
      return remove;
    };
    expect(await run({ ok: true, added: 1, variants: 0, full: 1, invalid: 0 }, "me")).not.toHaveBeenCalled();
    expect(await run({ ok: true, added: 1, variants: 0, full: 0, invalid: 1 }, "me")).not.toHaveBeenCalled();
    expect(await run({ ok: true, added: 1, variants: 0, full: 0, invalid: 0 }, "proche")).not.toHaveBeenCalled();
    expect(await run({ ok: true, added: 1, variants: 0, full: 0, invalid: 0 }, "me")).toHaveBeenCalled();
  });

  it("sources names the browsers without reading any; a source asking for access is not read", async () => {
    const read = vi.fn(async () => [camille]);
    const i = createPassportImporter({ home: "/h", scratch: "/s", passport: { addMany: vi.fn() as any }, reason: () => "r", exists: async () => true, read, access: async () => "ask" });
    const list = await i.sources();
    expect(list.at(-1)).toEqual({ id: "ressac", name: "Ressac" });
    expect(list.find((d) => d.id === "chrome")).toEqual({ id: "chrome", name: "Google Chrome" });
    expect(read).not.toHaveBeenCalled();
    expect(await i.proposals("chrome")).toMatchObject({ proposals: [], access: "ask", name: "Google Chrome" });
    expect(read).not.toHaveBeenCalled();
  });

  it("eraseRessac removes Firefox records only after a successful write", async () => {
    const bad = setup({ ok: false });
    let { proposals } = await bad.i.proposals("ressac");
    await bad.i.add("default", [{ key: proposals[0]!.key, as: "me" }], "ressac", true);
    expect(bad.remove).not.toHaveBeenCalled();
    const good = setup();
    ({ proposals } = await good.i.proposals("ressac"));
    await good.i.add("default", [{ key: proposals[0]!.key, as: "me" }], "ressac", true);
    expect(good.remove).toHaveBeenCalledWith(["g1"]);
    const keep = setup();
    ({ proposals } = await keep.i.proposals("ressac"));
    await keep.i.add("default", [{ key: proposals[0]!.key, as: "me" }], "ressac");
    expect(keep.remove).not.toHaveBeenCalled();
  });
});
