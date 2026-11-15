import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import { callTool } from "./mcp";
import { startServer } from "./server";
import { waitUi } from "./ui";

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
    // The panel's left edge and the page's right margin, sampled every frame for 600 ms after the toggle.
    const slide = async () =>
      m.execute<{ left: number; margin: number; hidden: boolean }[]>(`return (async () => {
        const agent = document.getElementById("ressac-agent"), box = document.getElementById("tabbrowser-tabbox"), out = [];
        const t0 = performance.now();
        while (performance.now() - t0 < 600) {
          out.push({ left: Math.round(agent.getBoundingClientRect().left), margin: Math.round(parseFloat(getComputedStyle(box).marginRight)), hidden: agent.hidden });
          await new Promise((r) => requestAnimationFrame(r));
        }
        return out;
      })();`);
    if (!(await open())) {
      await dispatch(m, { type: "toggleAgentPanel", windowId });
      await waitFor(m, "return !document.getElementById('ressac-agent').hidden", (v) => v === true);
      await new Promise((r) => setTimeout(r, 600));
    }
    const width = await m.execute<number>(`return Math.round(document.getElementById("ressac-agent").getBoundingClientRect().width);`);
    await dispatch(m, { type: "toggleAgentPanel", windowId });
    const closing = await slide();
    // A hidden iframe measures 0: only the frames where it shows.
    const lefts = closing.filter((x) => !x.hidden).map((x) => x.left);
    // Several intermediate positions, moving right; the margin shrinks with it; hidden only at the end.
    expect(new Set(lefts).size).toBeGreaterThan(3);
    expect(lefts.every((x, i) => i === 0 || x >= lefts[i - 1]!)).toBe(true);
    expect(closing.some((x) => x.margin > 8 && x.margin < width + 8)).toBe(true);
    expect(closing[0]!.hidden).toBe(false);
    await waitFor(m, "return document.getElementById('ressac-agent').hidden", (v) => v === true, 2_000);
    await dispatch(m, { type: "toggleAgentPanel", windowId });
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
    await waitUi(m, "doc.querySelector('[data-testid=\"settings-nav-privacy\"]')?.click(); return !!doc.querySelector('[data-testid=\"settings-aura-motion\"]')");
    await waitUi(m, "doc.querySelector('[data-testid=\"settings-aura-motion\"]').click(); return true");
    await waitFor(m, drift, (v: string[]) => v.every((x) => x === "paused"));
  });

  it("the halo shows while the agent works on the displayed tab", async () => {
    server = await startServer({ routes: { "/": (_, res) => res.writeHead(200, { "Content-Type": "text/html" }).end("<title>demo</title><p>demo</p>") } });
    // The demo port is the kernel's own: the agent's tabs there get every right, no consent card.
    const m = await launch(undefined, { RESSAC_CONTAINER_PORTS: `${server.port}-${server.port}` });
    const config = path.join(w!.dataDir, "workspace", ".ressac", "mcp.json");
    for (const deadline = Date.now() + 20_000; !existsSync(config); await new Promise((r) => setTimeout(r, 100)))
      if (Date.now() > deadline) throw new Error("the kernel did not write its MCP config");
    // The home page's panel starts the agent's session, which takes back every access: tools are called after it.
    await waitUi(m, "return doc.querySelector('.xterm-rows')?.textContent.includes('ready>')", [], 20_000, "agent");
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await callTool(w!.dataDir, name, args);
      expect(r.error, r.text).toBe(false);
      return r.text;
    };
    const other = await call("open_tab", { url: `${server.url}/?other` });
    const shown = await call("open_tab", { url: `${server.url}/` }); // open_tab displays it
    const working = `return document.documentElement.hasAttribute("ressac-agent-working");`;
    const slow = "await new Promise((r) => setTimeout(r, 2500)); 1";

    // A read takes a few ms, far less than the host's 50 ms grouping of access changes: the halo still lights.
    await call("read_tab", { id: shown });
    await waitFor(m, working, (v) => v === true, 1_000);
    await waitFor(m, working, (v) => v === false, 5_000);

    const onOther = call("run_js", { id: other, code: slow });
    const seen: boolean[] = [];
    let done = false;
    void onOther.then(() => (done = true), () => (done = true));
    while (!done) {
      seen.push(await m.execute<boolean>(working));
      await new Promise((r) => setTimeout(r, 100));
    }
    await onOther;
    expect(seen.length).toBeGreaterThan(5);
    expect(seen.some(Boolean)).toBe(false);

    const onShown = call("run_js", { id: shown, code: "await new Promise((r) => setTimeout(r, 5000)); 1" });
    onShown.catch(() => {}); // awaited below; a failed wait must not leave it unhandled
    await waitFor(m, working, (v) => v === true, 2_000);
    // Showing another tab puts it out at once (no hold), showing the worked-on tab again lights it.
    await dispatch(m, { type: "activateTab", id: other });
    const switched = Date.now();
    await waitFor(m, working, (v) => v === false, 1_000);
    expect(Date.now() - switched).toBeLessThan(1_000);
    await dispatch(m, { type: "activateTab", id: shown });
    await waitFor(m, working, (v) => v === true, 1_000);
    const ring = `const s = getComputedStyle(document.getElementById("tabbrowser-tabbox"), "::after"); return { events: s.pointerEvents, image: s.backgroundImage, display: s.display };`;
    // None over a video in fullscreen.
    await m.execute(`document.documentElement.setAttribute("inDOMFullscreen", "true");`);
    expect((await m.execute<{ display: string }>(ring)).display).toBe("none");
    await m.execute(`document.documentElement.removeAttribute("inDOMFullscreen");`);
    await onShown;
    const end = Date.now();
    await waitFor(m, working, (v) => v === false, 3_000);
    expect(Date.now() - end).toBeLessThanOrEqual(3_000);
    // The ring sits over the page and lets the mouse through.
    const shape = await m.execute<{ events: string; image: string }>(ring);
    expect(shape.events).toBe("none");
    expect(shape.image).toContain("conic-gradient");
  }, 60_000);
});
