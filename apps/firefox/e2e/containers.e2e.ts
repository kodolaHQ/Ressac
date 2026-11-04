import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupXpis, identities, installAddon } from "./addons";
import { dispatch, state, waitFor, waitReady } from "./firefox";
import { launchWebAiOs } from "./launch";
import { startServer } from "./server";

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const CIS = 'ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs").ContextualIdentityService';

let server: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => (server = await startServer()));
afterAll(async () => {
  await server?.close();
  await cleanupXpis();
});

describe("profile containers", () => {
  it("a public webaios container from an older build is migrated at start", async () => {
    const profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
    const cookies = `return Services.cookies.getCookiesFromHost("127.0.0.1", { userContextId: arguments[0] }).map((c) => c.name + "=" + c.value);`;
    try {
      let w = await launchWebAiOs({ profile, dataDir });
      let m = w.marionette;
      await m.setContext("chrome");
      await waitReady(m);
      // What an older build left behind: a public container holding a cookie.
      const id = await m.execute<number>(`return ${CIS}.create("webaios-p1", "fence", "blue").userContextId;`);
      await m.execute(
        `return (async () => {
          const tab = gBrowser.addTab(arguments[0], { userContextId: arguments[1], triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
          for (let i = 0; i < 50 && tab.linkedBrowser.currentURI.spec !== arguments[0]; i++) await new Promise((r) => setTimeout(r, 100));
          await new Promise((r) => setTimeout(r, 500));
          gBrowser.removeTab(tab);
        })();`,
        [`${server.url}/cookie`, id],
      );
      expect(await m.execute(cookies, [id])).toEqual(["essai=1"]);
      await w.close();

      w = await launchWebAiOs({ profile, dataDir });
      m = w.marionette;
      await m.setContext("chrome");
      await waitReady(m);
      const r = await m.execute<{ publicNames: string[]; same: boolean }>(
        `return (async () => {
          const store = await ChromeUtils.importESModule("${STORE}").ready;
          return { publicNames: ${CIS}.getPublicIdentities().map((i) => i.name ?? "").filter((n) => n.startsWith("webaios-")), same: store.containerFor("p1") === arguments[0] };
        })();`,
        [id],
      );
      expect(r).toEqual({ publicNames: [], same: true });
      expect(await m.execute(cookies, [id])).toEqual(["essai=1"]);
      await w.close();
    } finally {
      await Promise.all([rm(profile, { recursive: true, force: true }), rm(dataDir, { recursive: true, force: true })]);
    }
  });

  it("an add-on with contextualIdentities sees no profile container", async () => {
    const w = await launchWebAiOs();
    try {
      const m = w.marionette;
      await m.setContext("chrome");
      await waitReady(m);
      const fenetreId = (await state(m)).fenetres[0]!.id;
      await dispatch(m, { type: "creerEspace", nom: "B", icone: "🅱", prive: false, profil: "nouveau", fenetreId });
      await dispatch(m, { type: "ouvrirOnglet", fenetreId, url: `${server.url}/a.html` });
      const names = `return ${CIS}.getPolicyIdentities().filter((i) => i.name.startsWith("userContextIdInternal.webaios-")).length;`;
      await waitFor(m, names, (n) => n === 1);
      await installAddon(m, identities(server.url));
      for (let i = 0; i < 150 && !server.paths.some((p) => p.startsWith("/note/ci-")); i++) await new Promise((r) => setTimeout(r, 100));
      const note = server.paths.find((p) => p.startsWith("/note/ci-"))!;
      expect(note).toBeDefined();
      const seen: string[] = JSON.parse(decodeURIComponent(note.slice("/note/ci-".length)));
      expect(seen.filter((n) => n.startsWith("webaios-") || n.startsWith("userContextIdInternal"))).toEqual([]);
    } finally {
      await w.close();
    }
  });
});
