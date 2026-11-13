import { describe, it, expect } from "vitest";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PRIVATE_PROFILE_ERROR,
  enable,
  applyPrivateProfiles,
  extensionKey,
  cutAll,
  disable,
  disableEverywhere,
  pin,
  readKey,
  readExtensionsState,
  changeExtensionsState,
  remove,
  type ExtensionEntry,
  type ExtensionsState,
} from "../../src/extensions/registry.js";
import type { Scope } from "../../src/extensions/manifest.js";
import { tempFolder } from "../helpers/temp.js";

const scope: Scope = { permissions: [], hosts: [], network: [], allSites: false, allSitesScripts: false };
const entry = (source: "store" | "agent", override: Partial<ExtensionEntry> = {}): ExtensionEntry => ({
  source,
  addonId: null,
  name: "X",
  version: "1.0",
  grant: scope,
  profiles: [],
  pinned: false,
  modifiedAt: null,
  disabled: null,
  pendingUpdate: null,
  seenVersions: {},
  ...override,
});
const A = "agent:mon-ext";
const S = "store:" + "a".repeat(32);
const state = (extensions: Record<string, ExtensionEntry>, allCut = false): ExtensionsState => ({
  version: 1,
  allCut: allCut,
  extensions,
});
const none = new Set<string>();

describe("extension registry", () => {
  it("enabling an agent extension in a private profile throws PRIVATE_PROFILE_ERROR; a Store extension is enabled there", () => {
    const e = state({ [A]: entry("agent"), [S]: entry("store") });
    const privates = new Set(["p"]);
    expect(() => enable(e, A, "p", privates)).toThrow(PRIVATE_PROFILE_ERROR);
    expect(enable(e, S, "p", privates).extensions[S]!.profiles).toEqual(["p"]);
    expect(e.extensions[S]!.profiles).toEqual([]);
    const two = enable(enable(e, A, "q", none), A, "q", none);
    expect(two.extensions[A]!.profiles).toEqual(["q"]);
  });

  it("enabling without a grant throws", () => {
    const e = state({ [A]: entry("agent", { grant: null }) });
    expect(() => enable(e, A, "p", none)).toThrow();
    expect(() => enable(e, "store:" + "b".repeat(32), "p", none)).toThrow();
  });

  it("appliquerProfilsPrives removes only the agent's extensions, and lists them", () => {
    const e = state({
      [A]: entry("agent", { profiles: ["p", "q"], seenVersions: { p: "1", q: "1" } }),
      [S]: entry("store", { profiles: ["p"] }),
    });
    const r = applyPrivateProfiles(e, new Set(["p"]));
    expect(r.state.extensions[A]!.profiles).toEqual(["q"]);
    expect(r.state.extensions[S]!.profiles).toEqual(["p"]);
    expect(r.removed).toEqual([{ key: A, profile: "p" }]);
  });

  it("desactiver, desactiverPartout, retirer, cutAll, epingler", () => {
    const e = state({ [A]: entry("agent", { profiles: ["p", "q"] }) });
    expect(disable(e, A, "p").extensions[A]!.profiles).toEqual(["q"]);
    expect(disableEverywhere(e, A).extensions[A]!.profiles).toEqual([]);
    expect(remove(e, A).extensions).toEqual({});
    expect(cutAll(e, true).allCut).toBe(true);
    expect(pin(e, A, true).extensions[A]!.pinned).toBe(true);
    expect(e.extensions[A]!.pinned).toBe(false);
    expect(() => pin(e, "agent:inconnue", true)).toThrow();
  });

  it("readKey refuse « store:abc », « agent:A », « autre:x »", () => {
    expect(readKey("store:abc")).toBeNull();
    expect(readKey("agent:A")).toBeNull();
    expect(readKey("autre:x")).toBeNull();
    expect(readKey("agent:" + "a".repeat(41))).toBeNull();
    expect(readKey(S)).toEqual({ source: "store", id: "a".repeat(32) });
    expect(readKey(A)).toEqual({ source: "agent", id: "mon-ext" });
    expect(extensionKey("agent", "mon-ext")).toBe(A);
    expect(() => extensionKey("store", "abc")).toThrow();
  });
});

describe("fichier state.json", () => {
  it("two simultaneous modifications keep both changes", async () => {
    const folder = await tempFolder();
    const add = (key: string) =>
      changeExtensionsState(folder, (e) => ({ ...e, extensions: { ...e.extensions, [key]: entry("agent") } }), () => none);
    await Promise.all([add("agent:a"), add("agent:b"), add("agent:c")]);
    const parsed = await readExtensionsState(folder);
    expect(Object.keys(parsed.extensions).sort()).toEqual(["agent:a", "agent:b", "agent:c"]);
  });

  it("a damaged state.json reads as empty and is not rewritten as long as nothing changes", async () => {
    const folder = await tempFolder();
    await writeFile(join(folder, "state.json"), "{pas du json");
    expect(await readExtensionsState(folder)).toEqual({ version: 1, allCut: false, extensions: {} });
    expect(await readFile(join(folder, "state.json"), "utf8")).toBe("{pas du json");
    expect(await readExtensionsState(join(folder, "absent"))).toEqual({ version: 1, allCut: false, extensions: {} });
  });

  it("an entry with an invalid key or shape is ignored, a scope with scripts is kept", async () => {
    const folder = await tempFolder();
    const good = entry("agent", { grant: { ...scope, scripts: true } });
    await writeFile(
      join(folder, "state.json"),
      JSON.stringify({ version: 1, allCut: true, extensions: { [A]: good, "agent:BAD": good, "agent:x": { name: 1 } } }),
    );
    const parsed = await readExtensionsState(folder);
    expect(parsed.allCut).toBe(true);
    expect(Object.keys(parsed.extensions)).toEqual([A]);
    expect(parsed.extensions[A]!.grant?.scripts).toBe(true);
  });

  it("consolesMasquees (Chromium ids masked from the agent) survives retirer and the re-read; an invalid id is ignored", async () => {
    const folder = await tempFolder();
    const id = "b".repeat(32);
    await writeFile(
      join(folder, "state.json"),
      JSON.stringify({ version: 1, allCut: false, extensions: { [A]: entry("agent") }, hiddenConsoles: [id, "pas-un-id", 3, "garde@agent.ressac", "garde@autre.org"] }),
    );
    const parsed = await readExtensionsState(folder);
    expect(parsed.hiddenConsoles).toEqual([id, "garde@agent.ressac"]);
    expect(remove(parsed, A).hiddenConsoles).toEqual([id, "garde@agent.ressac"]);
    await changeExtensionsState(folder, (e) => remove(e, A), () => none);
    const reviewed = await readExtensionsState(folder);
    expect(reviewed.extensions).toEqual({});
    expect(reviewed.hiddenConsoles).toEqual([id, "garde@agent.ressac"]);
  });

  const written = (folder: string, content: string) => writeFile(join(folder, "state.json"), content);
  const backups = async (folder: string) => (await readdir(folder)).filter((f) => f.startsWith("state.json.damaged-"));
  const addition = (key: string) => (e: ExtensionsState) => ({ ...e, extensions: { ...e.extensions, [key]: entry("agent") } });
  const withoutPrivate = () => none;

  it("a version 2 file reads as empty and any write is refused, without touching the file", async () => {
    const folder = await tempFolder();
    const original = JSON.stringify({ version: 2, allCut: false, extensions: { [A]: entry("agent") } });
    await written(folder, original);
    expect(await readExtensionsState(folder)).toEqual({ version: 1, allCut: false, extensions: {} });
    await expect(changeExtensionsState(folder, addition("agent:b"), withoutPrivate)).rejects.toThrow(
      "état des extensions d'une version plus récente",
    );
    expect(await readFile(join(folder, "state.json"), "utf8")).toBe(original);
    expect(await backups(folder)).toEqual([]);
  });

  it("writing after a damaged file keeps a copy of the original bytes", async () => {
    const folder = await tempFolder();
    await written(folder, "{pas du json");
    await changeExtensionsState(folder, addition("agent:b"), withoutPrivate);
    const copies = await backups(folder);
    expect(copies).toHaveLength(1);
    expect(await readFile(join(folder, copies[0]!), "utf8")).toBe("{pas du json");
    await changeExtensionsState(folder, addition("agent:c"), withoutPrivate);
    expect(await backups(folder)).toHaveLength(1);
  });

  it("writing after ignored entries keeps a copy of the original file", async () => {
    const folder = await tempFolder();
    const original = JSON.stringify({ version: 1, allCut: false, extensions: { [A]: entry("agent"), "agent:x": { name: 1 } } });
    await written(folder, original);
    await changeExtensionsState(folder, (e) => e, withoutPrivate);
    const copies = await backups(folder);
    expect(copies).toHaveLength(1);
    expect(await readFile(join(folder, copies[0]!), "utf8")).toBe(original);
  });

  it("only ENOENT reads as empty: another read error throws", async () => {
    const folder = await tempFolder();
    await mkdir(join(folder, "state.json"));
    await expect(readExtensionsState(folder)).rejects.toThrow();
    await expect(changeExtensionsState(folder, addition("agent:b"), withoutPrivate)).rejects.toThrow();
  });

  it("a leftover temporary is ignored", async () => {
    const folder = await tempFolder();
    await written(folder, JSON.stringify(state({ [A]: entry("agent") })));
    await writeFile(join(folder, "state.json.xyz.tmp"), "reste");
    const parsed = await changeExtensionsState(folder, addition("agent:b"), withoutPrivate);
    expect(Object.keys(parsed.extensions).sort()).toEqual(["agent:b", A]);
    expect(await backups(folder)).toEqual([]);
  });

  it("a changer that throws does not prevent the next modification", async () => {
    const folder = await tempFolder();
    const rate = changeExtensionsState(folder, () => {
      throw new Error("boum");
    }, withoutPrivate);
    const good = changeExtensionsState(folder, addition("agent:b"), withoutPrivate);
    await expect(rate).rejects.toThrow("boum");
    await good;
    expect(Object.keys((await readExtensionsState(folder)).extensions)).toEqual(["agent:b"]);
  });

  it("confidentiality is evaluated within the serialized modification", async () => {
    const folder = await tempFolder();
    await changeExtensionsState(folder, addition("agent:b"), withoutPrivate);
    await changeExtensionsState(folder, (e) => ({ ...e, extensions: { ...e.extensions, "agent:b": { ...e.extensions["agent:b"]!, grant: scope } } }), withoutPrivate);
    let isPrivate = false;
    const activation = changeExtensionsState(folder, (e, privates) => enable(e, "agent:b", "p", privates), () => new Set(isPrivate ? ["p"] : []));
    isPrivate = true; // the space becomes private after the call but before the execution
    await expect(activation).rejects.toThrow(PRIVATE_PROFILE_ERROR);
    // activation passed through a stale set: the removal follows anyway
    const parsed = await changeExtensionsState(
      folder,
      (e) => enable(e, "agent:b", "p", none),
      () => new Set(["p"]),
    );
    expect(parsed.extensions["agent:b"]!.profiles).toEqual([]);
  });

  it("applis survives modifierEtatExtensions and the re-read; an state.json without applis re-reads without an .damaged-* copy", async () => {
    const folder = await tempFolder();
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "state.json"), JSON.stringify(state({ [S]: entry("store") })));
    expect((await readExtensionsState(folder)).extensions[S]!.siteApps).toBeUndefined();
    await changeExtensionsState(folder, (e) => e, () => none);
    expect((await readdir(folder)).filter((f) => f.includes(".damaged-"))).toEqual([]);
    await changeExtensionsState(folder, (e) => ({ ...e, extensions: { ...e.extensions, [S]: { ...e.extensions[S]!, siteApps: { vidola: "e1" } } } }), () => none);
    expect((await readExtensionsState(folder)).extensions[S]!.siteApps).toEqual({ vidola: "e1" });
    await changeExtensionsState(folder, (e) => e, () => none);
    expect((await readExtensionsState(folder)).extensions[S]!.siteApps).toEqual({ vidola: "e1" });
    expect((await readdir(folder)).filter((f) => f.includes(".damaged-"))).toEqual([]);
  });
});
