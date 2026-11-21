import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import { callTool } from "./mcp";
import { startServer } from "./server";
import { startAgentSession, waitUi } from "./ui";

let w: LaunchedRessac | undefined;
let server: Awaited<ReturnType<typeof startServer>> | undefined;
afterEach(async () => {
  await w?.close();
  await server?.close();
  server = undefined;
});

async function launch(prefs?: Record<string, number>, env?: Record<string, string>) {
  // Motion is what this file tests: full motion unless the test asks for reduced.
  w = await launchRessac({ prefs: { "ui.prefersReducedMotion": 0, ...prefs }, env });
  const m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow", (v) => v === true);
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"sidebar\"]')");
  return m;
}

// --a1..--a3 are registered colors: computed as rgb(). Read once the 900 ms transition is over.
const variable = (name: string) =>
  `return [document.documentElement, document.getElementById("ressac-sidebar").contentDocument.documentElement]
     .map((r) => r.ownerDocument.defaultView.getComputedStyle(r).getPropertyValue(${JSON.stringify(name)}).trim());`;

describe("the window's aura", () => {
  it("the window takes the active space's aura", async () => {
    const m = await launch();
    const s = await state(m);
    const space = s.spaces.find((x) => x.id === s.windows[0]!.activeSpace)!;
    await dispatch(m, { type: "updateSpace", id: space.id, name: space.name, icon: space.icon, private: space.private, profile: space.profile, aura: "lagon" });
    await waitFor(m, variable("--a2"), (v: string[]) => v.every((x) => x === "rgb(59, 139, 235)"));
    const windowId = s.windows[0]!.id;
    const created = await dispatch(m, { type: "createSpace", name: "Braise", icon: "🔥", private: false, profile: space.profile, aura: "braise", windowId });
    await dispatch(m, { type: "activateSpace", windowId, id: created.spaces.at(-1)!.id });
    await waitFor(m, variable("--a1"), (v: string[]) => v.every((x) => x === "rgb(255, 122, 69)"));
  });

  it("a tab with no favicon shows its initial on the active space's aura", async () => {
    const m = await launch();
    server = await startServer();
    const s = await state(m);
    const space = s.spaces.find((x) => x.id === s.windows[0]!.activeSpace)!;
    await dispatch(m, { type: "updateSpace", id: space.id, name: space.name, icon: space.icon, private: space.private, profile: space.profile, aura: "lagon" });
    await dispatch(m, { type: "openTab", windowId: s.windows[0]!.id, url: server.url + "/a.html" });
    const letter = () =>
      waitUi(m, `const l = doc.querySelector('[data-testid^="tab-"] .letter'); return l ? doc.defaultView.getComputedStyle(l).backgroundImage : null;`, [], 10_000);
    await waitUi(m, "return !!doc.querySelector('[data-testid^=\"tab-\"] .letter')");
    await new Promise((r) => setTimeout(r, 1200));
    expect(await letter()).toContain("rgb(59, 139, 235)");
  });

  it("relaunched on a Lagon space, the sidebar's initials take Lagon at once", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "ressac-data-"));
    const profile = await mkdtemp(path.join(os.tmpdir(), "ressac-firefox-"));
    try {
      w = await launchRessac({ dataDir, profile, prefs: { "ui.prefersReducedMotion": 0 } });
      let m = w.marionette;
      await m.setContext("chrome");
      await waitUi(m, "return !!doc.querySelector('[data-testid=\"sidebar\"]')");
      server = await startServer();
      const s = await state(m);
      const space = s.spaces.find((x) => x.id === s.windows[0]!.activeSpace)!;
      await dispatch(m, { type: "updateSpace", id: space.id, name: space.name, icon: space.icon, private: space.private, profile: space.profile, aura: "lagon" });
      await dispatch(m, { type: "openTab", windowId: s.windows[0]!.id, url: server.url + "/a.html" });
      await waitUi(m, "return !!doc.querySelector('[data-testid^=\"tab-\"] .letter')");
      await new Promise((r) => setTimeout(r, 1500));
      await w.close();
      w = await launchRessac({ dataDir, profile, prefs: { "ui.prefersReducedMotion": 0 } });
      m = w.marionette;
      await m.setContext("chrome");
      await waitUi(m, "return !!doc.querySelector('[data-testid^=\"tab-\"] .letter')", [], 20_000);
      await new Promise((r) => setTimeout(r, 1500));
      expect(await waitFor(m, variable("--a2"), () => true)).toEqual(["rgb(59, 139, 235)", "rgb(59, 139, 235)"]);
    } finally {
      // Ressac quit first: it still writes into its profile and data folder until it exits.
      await w?.close();
      await rm(dataDir, { recursive: true, force: true });
      await rm(profile, { recursive: true, force: true });
    }
  });

  it("the page is framed by the aura, not in fullscreen", async () => {
    const m = await launch();
    const box = `const s = getComputedStyle(document.getElementById("tabbrowser-tabbox")); return { radius: s.borderTopLeftRadius, margin: s.marginBottom, right: s.marginRight };`;
    const framed = await m.execute<{ radius: string; margin: string }>(box);
    expect(parseFloat(framed.radius)).toBeGreaterThan(0);
    expect(framed.margin).toBe("8px");
    await m.execute(`document.documentElement.setAttribute("inDOMFullscreen", "true");`);
    expect(await m.execute(box)).toEqual({ radius: "0px", margin: "0px", right: "0px" });
  });

  it("the agent panel slides in and out, the page making room in step", async () => {
    const m = await launch();
    const windowId = (await state(m)).windows[0]!.id;
    const open = async () => (await state(m)).windows[0]!.agentPanelOpen;
    // Toggles the panel, then reads the panel's left edge and the page's right margin at fixed points of the slide, its
    // transition held still at each (frames sampled under load can all fall at its end).
    const slide = async () =>
      m.execute<{ left: number; margin: number; hidden: boolean }[]>(
        `return (async () => {
        await (await ChromeUtils.importESModule("chrome://browser/content/ressac/store.sys.mjs").ready).dispatch(arguments[0]);
        const t = document.documentElement.getAnimations().find((a) => a.transitionProperty === "--ressac-agent");
        if (!t) throw new Error("no slide");
        const agent = document.getElementById("ressac-agent"), box = document.getElementById("tabbrowser-tabbox");
        const duration = t.effect.getComputedTiming().duration;
        t.pause();
        const out = [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9].map((f) => {
          t.currentTime = f * duration;
          return { left: Math.round(agent.getBoundingClientRect().left), margin: Math.round(parseFloat(getComputedStyle(box).marginRight)), hidden: agent.hidden };
        });
        t.play();
        return out;
      })();`,
        [{ type: "toggleAgentPanel", windowId }],
      );
    const sliding = "return document.documentElement.hasAttribute('ressac-agent-sliding')";
    if (!(await open())) {
      await dispatch(m, { type: "toggleAgentPanel", windowId });
      await waitFor(m, sliding, (v) => v === false, 2_000);
    }
    const width = await m.execute<number>(`return Math.round(document.getElementById("ressac-agent").getBoundingClientRect().width);`);
    const closing = await slide();
    // Several intermediate positions, moving right; the margin shrinks with it; hidden only at the end.
    const lefts = closing.map((x) => x.left);
    expect(new Set(lefts).size).toBeGreaterThan(3);
    expect(lefts.every((x, i) => i === 0 || x >= lefts[i - 1]!)).toBe(true);
    expect(closing.some((x) => x.margin > 8 && x.margin < width + 8)).toBe(true);
    expect(closing.every((x) => !x.hidden)).toBe(true);
    await waitFor(m, "return document.getElementById('ressac-agent').hidden", (v) => v === true, 2_000);
    const opening = (await slide()).map((x) => x.left);
    expect(new Set(opening).size).toBeGreaterThan(3);
    expect(opening.every((x, i) => i === 0 || x <= opening[i - 1]!)).toBe(true);
  });

  it("reduced motion stops the aura drift", async () => {
    const m = await launch({ "ui.prefersReducedMotion": 1 });
    const names = await m.execute<string[]>(`return [...document.querySelectorAll("#ressac-aura i")].map((i) => getComputedStyle(i).animationName);`);
    expect(names).toEqual(["none", "none", "none"]);
    // The agent's halo: a still ring.
    expect(await m.execute(`return getComputedStyle(document.getElementById("tabbrowser-tabbox"), "::after").animationName;`)).toBe("none");
  });

  it("the aura drifts behind Ressac pages only, still behind a web page", async () => {
    server = await startServer({ routes: { "/": (_, res) => res.writeHead(200, { "Content-Type": "text/html" }).end("<p>web</p>") } });
    const m = await launch();
    const windowId = (await state(m)).windows[0]!.id;
    const web = `return document.documentElement.hasAttribute("ressac-web-page");`;
    const drift = `return [...document.querySelectorAll("#ressac-aura i")].map((i) => getComputedStyle(i).animationPlayState);`;
    expect(await m.execute(web)).toBe(false);
    await dispatch(m, { type: "openTab", windowId, url: `${server.url}/` });
    await waitFor(m, web, (v) => v === true);
    expect(await m.execute(drift)).toEqual(["paused", "paused", "paused"]);
    await dispatch(m, { type: "openTab", windowId, url: "ressac://settings" });
    await waitFor(m, web, (v) => v === false);
    await waitFor(m, drift, (v: string[]) => v.every((x) => x === "running"));
    // « Aura animée » off: still behind Ressac's pages too.
    await waitUi(m, "doc.querySelector('[data-testid=\"settings-nav-general\"]')?.click(); return !!doc.querySelector('[data-testid=\"settings-aura-motion\"]')");
    await waitUi(m, "doc.querySelector('[data-testid=\"settings-aura-motion\"]').click(); return true");
    await waitFor(m, drift, (v: string[]) => v.every((x) => x === "paused"));
  });

  it("the halo shows while the agent works on the displayed tab", async () => {
    let released = false;
    server = await startServer({
      routes: {
        "/": (_, res) => res.writeHead(200, { "Content-Type": "text/html" }).end("<title>demo</title><p>demo</p>"),
        // The long run on the shown tab ends when the test releases it, not after a fixed time.
        "/release": (_, res) => res.writeHead(200, { "Content-Type": "text/plain" }).end(released ? "1" : "0"),
      },
    });
    // The demo port is the kernel's own: the agent's tabs there get every right, no consent card.
    const m = await launch(undefined, { RESSAC_CONTAINER_PORTS: `${server.port}-${server.port}` });
    const config = path.join(w!.dataDir, "workspace", ".ressac", "mcp.json");
    for (const deadline = Date.now() + 20_000; !existsSync(config); await new Promise((r) => setTimeout(r, 100)))
      if (Date.now() > deadline) throw new Error("the kernel did not write its MCP config");
    // Opening the panel starts the agent's session, which takes back every access: tools are called after it.
    await startAgentSession(m);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await callTool(w!.dataDir, name, args);
      expect(r.error, r.text).toBe(false);
      return r.text;
    };
    const other = await call("open_tab", { url: `${server.url}/?other` });
    const shown = await call("open_tab", { url: `${server.url}/` }); // open_tab displays it
    const working = `return document.documentElement.hasAttribute("ressac-agent-working");`;
    // Under load the halo comes on seconds late and its hold runs late too (on 2.6 s after a call, off up to 11 s
    // after, measured in sites-agent): an observer notes that it is or came on, the test waits for the real end. The
    // hold's length is test/halo.test.ts's.
    const watchHalo = () =>
      m.execute(`window.ressacTestHaloSeen = false; window.ressacTestHaloObserver?.disconnect();
        const note = () => { if (document.documentElement.hasAttribute("ressac-agent-working")) window.ressacTestHaloSeen = true; };
        (window.ressacTestHaloObserver = new MutationObserver(note)).observe(document.documentElement, { attributes: true, attributeFilter: ["ressac-agent-working"] });
        note();`);
    const haloSeen = "return window.ressacTestHaloSeen;";
    // A tab switch reaches the halo in the dispatch itself: read right after it, no window of time.
    const STORE = `ChromeUtils.importESModule("chrome://browser/content/ressac/store.sys.mjs").ready`;
    const switchTo = (id: string) =>
      m.execute<boolean>(
        `return ${STORE}.then((store) => {
           store.dispatch({ type: "activateTab", id: arguments[0] });
           return document.documentElement.hasAttribute("ressac-agent-working");
         });`,
        [id],
      );

    // A read takes a few ms, far less than the host's 50 ms grouping of access changes: the halo still lights.
    await watchHalo();
    await call("read_tab", { id: shown });
    await waitFor(m, haloSeen, (v) => v === true, 20_000);
    await waitFor(m, working, (v) => v === false, 20_000);

    // A tool on a tab not shown: once its access changes have all arrived (it ran, it ended), the halo never lit.
    await watchHalo(); // the halo is off here: only a light-up during the run counts
    await m.execute(
      `return ${STORE}.then((store) => {
         window.ressacTestOtherRan = false;
         window.ressacTestOff?.();
         window.ressacTestOff = store.agent.on("access", (e) => { if (e.tabs[arguments[0]]?.running) window.ressacTestOtherRan = true; });
       });`,
      [other],
    );
    await call("run_js", { id: other, code: "await new Promise((r) => setTimeout(r, 2500)); 1" });
    await waitFor(m, `return ${STORE}.then((store) => window.ressacTestOtherRan && !store.access.tabs[${JSON.stringify(other)}]?.running);`, (v) => v === true, 20_000);
    expect(await m.execute(haloSeen)).toBe(false);

    const onShown = call("run_js", { id: shown, code: `while ((await (await fetch("/release")).text()) !== "1") await new Promise((r) => setTimeout(r, 100)); 1` });
    onShown.catch(() => {}); // awaited below; a failed wait must not leave it unhandled
    await waitFor(m, working, (v) => v === true, 20_000);
    // Showing another tab puts it out at once (no hold), showing the worked-on tab again lights it.
    expect(await switchTo(other)).toBe(false);
    expect(await switchTo(shown)).toBe(true);
    const ring = `const s = getComputedStyle(document.getElementById("tabbrowser-tabbox"), "::after"); return { events: s.pointerEvents, image: s.backgroundImage, display: s.display };`;
    // None over a video in fullscreen.
    await m.execute(`document.documentElement.setAttribute("inDOMFullscreen", "true");`);
    expect((await m.execute<{ display: string }>(ring)).display).toBe("none");
    await m.execute(`document.documentElement.removeAttribute("inDOMFullscreen");`);
    released = true;
    await onShown;
    await waitFor(m, working, (v) => v === false, 20_000);
    // The ring sits over the page and lets the mouse through.
    const shape = await m.execute<{ events: string; image: string }>(ring);
    expect(shape.events).toBe("none");
    expect(shape.image).toContain("conic-gradient");
  }, 60_000);
});
