import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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

  it("starts with one space and no tab, and writes nothing before the first change", async () => {
    const s = await state(w.marionette);
    expect(s.espaces.map((e) => e.nom)).toEqual(["Perso"]);
    expect(Object.keys(s.onglets)).toHaveLength(0);
    expect(existsSync(path.join(w.dataDir, "session.json"))).toBe(false);
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
