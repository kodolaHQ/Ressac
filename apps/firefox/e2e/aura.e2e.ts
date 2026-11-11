import { afterEach, describe, expect, it } from "vitest";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import { waitUi } from "./ui";

let w: LaunchedWebAiOs | undefined;
afterEach(() => w?.close());

async function launch(prefs?: Record<string, number>) {
  w = await launchWebAiOs({ prefs });
  const m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow", (v) => v === true);
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"sidebar\"]')");
  return m;
}

// --a1..--a3 are registered colors: computed as rgb(). Read once the 900 ms transition is over.
const variable = (name: string) =>
  `return [document.documentElement, document.getElementById("webaios-sidebar").contentDocument.documentElement]
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

  it("reduced motion stops the aura drift", async () => {
    const m = await launch({ "ui.prefersReducedMotion": 1 });
    const names = await m.execute<string[]>(`return [...document.querySelectorAll("#webaios-aura i")].map((i) => getComputedStyle(i).animationName);`);
    expect(names).toEqual(["none", "none", "none"]);
  });
});
