import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";

const STORE = "chrome://browser/content/webaios/store.sys.mjs";

describe("state store", () => {
  let w: LaunchedWebAiOs;
  beforeAll(async () => {
    w = await launchWebAiOs();
    await w.marionette.setContext("chrome");
  });
  afterAll(() => w?.close());

  it("starts with one space and no tab", async () => {
    const s = await state(w.marionette);
    expect(s.espaces.map((e) => e.nom)).toEqual(["Perso"]);
    expect(Object.keys(s.onglets)).toHaveLength(0);
  });

  it("saves a change to session.json within 2 s", async () => {
    const s = await state(w.marionette);
    await dispatch(w.marionette, { type: "ouvrirOnglet", fenetreId: s.fenetres[0]!.id, url: "https://exemple.test/" });
    const file = path.join(w.dataDir, "session.json");
    // Waits for the content, not the file: an earlier save may already have written it, without the tab.
    const urls = async () =>
      existsSync(file) ? Object.values<{ url: string }>(JSON.parse(await readFile(file, "utf8")).onglets).map((o) => o.url) : [];
    for (let i = 0; i < 20 && (await urls()).length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(await urls()).toEqual(["https://exemple.test/"]);
  });

  it("maps login profiles to containers", async () => {
    const r = await w.marionette.execute<{ def: number; a: number; b: number; named: boolean; leaked: boolean }>(`return (async () => {
      const store = await ChromeUtils.importESModule("${STORE}").ready;
      const { ContextualIdentityService } = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
      const a = store.containerFor("p1");
      return { def: store.containerFor("defaut"), a, b: store.containerFor("p1"),
        named: ContextualIdentityService.getPrivateIdentity("userContextIdInternal.webaios-p1")?.userContextId === a,
        leaked: ContextualIdentityService.getPublicIdentities().some((i) => i.name?.startsWith("webaios-")) };
    })();`);
    expect(r.def).toBe(0);
    expect(r.a).not.toBe(0);
    expect(r.b).toBe(r.a);
    expect(r.named).toBe(true);
    expect(r.leaked).toBe(false);
  });
});

// A fresh start does change the state: the new window records its frame (controller.ts recordFrame), written 500 ms later.
// A start on a session whose frame is the window's changes nothing, so nothing is written.
describe("restart on an unchanged session", () => {
  let dataDir: string;
  let w: LaunchedWebAiOs | undefined;
  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
    const file = path.join(dataDir, "session.json");
    w = await launchWebAiOs({ dataDir });
    await w.marionette.setContext("chrome");
    await waitFor(w.marionette, "return null;", () => existsSync(file) && !!JSON.parse(readFileSync(file, "utf8")).fenetres[0]?.cadre);
    await w.close();
  });
  afterAll(async () => {
    await w?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("writes nothing before the first change", async () => {
    const file = path.join(dataDir, "session.json");
    const before = { text: await readFile(file, "utf8"), mtime: statSync(file).mtimeMs };
    w = await launchWebAiOs({ dataDir });
    await w.marionette.setContext("chrome");
    expect((await state(w.marionette)).fenetres).toHaveLength(1);
    // Longer than the frame's 300 ms timer plus the recorder's 500 ms delay: a write would have landed.
    await new Promise((r) => setTimeout(r, 2000));
    expect({ text: await readFile(file, "utf8"), mtime: statSync(file).mtimeMs }).toEqual(before);
  });
});

describe("unreadable session", () => {
  let dataDir: string;
  let w: LaunchedWebAiOs | undefined;
  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
    await writeFile(path.join(dataDir, "session.json"), "{ not json");
    w = await launchWebAiOs({ dataDir });
    await w.marionette.setContext("chrome");
  });
  afterAll(async () => {
    await w?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("is set aside as session.json.<date>.corrompu", async () => {
    const aside = await waitFor<string | null>(
      w!.marionette,
      `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).setAside)();`,
      (v) => v !== null,
    );
    expect(path.basename(aside!)).toMatch(/^session\.json\..+\.corrompu$/);
    expect((await readdir(dataDir)).filter((n) => n.endsWith(".corrompu"))).toEqual([path.basename(aside!)]);
    expect((await state(w!.marionette)).espaces).toHaveLength(1);
  });
});
