import type { Marionette } from "./marionette";

/** The UI iframes: the sidebar (`#ressac-sidebar`), the agent panel (`#ressac-agent`) and the design overlays, with what shows each is mounted. */
const FRAMES = {
  sidebar: { id: "ressac-sidebar", mounted: '[data-testid="sidebar"]' },
  agent: { id: "ressac-agent", mounted: '[data-testid="agent-panel"]' },
  // The design mode's overlay (bubble, message) and a main window's cart column (chrome/window/design-overlays.ts).
  overlay: { id: "ressac-design-calque", mounted: "#app" },
  panel: { id: "ressac-design-volet", mounted: "#app" },
  // The pill of the agent's last tab (chrome/window/agent-pill.ts).
  agentview: { id: "ressac-agent-pill", mounted: "#app" },
};
export type Frame = keyof typeof FRAMES;

/**
 * Runs `body` (an async function body, chrome context) with `doc` = the document of a Ressac UI iframe (the sidebar by
 * default) and `ui` = its window. `arguments[i]` are the args. Waits up to 10 s for the UI to be mounted.
 */
export function inUi<T = unknown>(m: Marionette, body: string, args: unknown[] = [], frame: Frame = "sidebar"): Promise<T> {
  const f = FRAMES[frame];
  return m.execute<T>(
    `return (async () => {
      const frame = document.getElementById(${JSON.stringify(f.id)});
      for (let i = 0; i < 100 && !frame?.contentDocument?.querySelector(${JSON.stringify(f.mounted)}); i++) await new Promise((r) => setTimeout(r, 100));
      const doc = frame.contentDocument;
      const ui = doc.defaultView;
      ${body}
    })();`,
    args,
  );
}

/**
 * Evaluates `expr` (awaited, JSON-serializable) in the page of a frame <browser>, through the RessacFrame actor's test
 * hook (RESSAC_TEST_FRAMES, set by launchRessac): `target` is a selector in the UI `frame` (throws if nothing matches),
 * or `{ browser }` a chrome expression (null if it gives nothing). `chrome`: in a system sandbox.
 */
export async function inFrame<T = unknown>(m: Marionette, target: string | { browser: string }, expr: string, frame: Frame = "sidebar", chrome = false): Promise<T> {
  const byExpr = typeof target !== "string";
  const body = `const b = ${byExpr ? `(${target.browser})` : "doc.querySelector(arguments[0])"};
     if (!b) { if (${byExpr}) return null; throw new Error("no frame browser " + arguments[0]); }
     return b.browsingContext.currentWindowGlobal.getActor("RessacFrame").sendQuery("test", { expr: arguments[1], chrome: arguments[2] });`;
  const args = [byExpr ? null : target, expr, chrome];
  const json = await (byExpr ? m.execute<string | null | undefined>(body, args) : inUi<string | undefined>(m, body, args, frame));
  return (json == null ? json : JSON.parse(json)) as T;
}

/** Polls `body` (see inUi) until it returns a truthy value; returns it. */
export async function waitUi<T = unknown>(m: Marionette, body: string, args: unknown[] = [], ms = 10_000, frame: Frame = "sidebar"): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await inUi<T>(m, body, args, frame);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting in the ${frame} UI on: ${body}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * A trusted mouse click (`button` 0) or right click (2: mousedown, contextmenu, mouseup) at the centre of the first element matching
 * `selector` in the UI, and whose text contains `text` if given. Waits for it to appear.
 */
export async function click(m: Marionette, selector: string, o: { button?: 0 | 2; text?: string; frame?: Frame } = {}): Promise<void> {
  const find = "const el = [...doc.querySelectorAll(arguments[0])].find((e) => !arguments[1] || e.textContent.includes(arguments[1]));";
  await waitUi(m, `${find} return !!el;`, [selector, o.text ?? null], 10_000, o.frame);
  await inUi(
    m,
    `${find}
     el.scrollIntoView({ block: "center" });
     // Like a person: the press waits until the element has stopped moving and is the one under the pointer. A
     // layout still sliding or a canvas still fitting (measured: a block under the builder's tabs for a few frames)
     // sent the press to a neighbour. After 2 s it is pressed anyway, where it is.
     let x, y, before = "";
     for (const end = Date.now() + 2000; ; ) {
       await new Promise((r) => requestAnimationFrame(r));
       const r = el.getBoundingClientRect();
       [x, y] = [r.left + r.width / 2, r.top + r.height / 2];
       const hit = doc.elementFromPoint(x, y);
       const now = [r.left, r.top, r.width, r.height].join();
       // An element that takes no pointer yet (a card not armed) is not pressable, even with a parent under the pointer.
       const under = hit && (el.contains(hit) || hit.contains(el)) && doc.defaultView.getComputedStyle(el).pointerEvents !== "none";
       if ((now === before && under) || Date.now() > end) break;
       // Content loaded above it can push it out of view after the first scroll (measured: Réglages sections pushed
       // the Mozilla card 344 px down, the press landed outside the window): scrolled to again.
       if (!under) el.scrollIntoView({ block: "center" });
       before = now;
     }
     // A right click as Gecko delivers it on macOS: contextmenu on the press, then the release, whose click (button 2) reaches chrome documents.
     const types = arguments[2] === 2 ? ["mousedown", "contextmenu", "mouseup"] : ["mousedown", "mouseup"];
     for (const type of types) ui.synthesizeMouseEvent(type, x, y, { button: arguments[2], clickCount: 1 });`,
    [selector, o.text ?? null, o.button ?? 0],
    o.frame,
  );
}

const TIP = `const tip = (window.ressacTestTip ??= Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor));
  tip.beginInputTransactionForTests(window);
  const CODES = { "[": "BracketLeft", "]": "BracketRight", "{": "BracketLeft", "}": "BracketRight", Meta: "MetaLeft", Control: "ControlLeft", Shift: "ShiftLeft", Alt: "AltLeft", " ": "Space", "-": "Minus", ",": "Comma", "/": "Slash", "?": "Slash", "$": "Digit4" };
  const ev = (key) => new KeyboardEvent("", { key, code: CODES[key] ?? (/^[0-9]$/.test(key) ? "Digit" + key : key.length === 1 ? "Key" + key.toUpperCase() : key) });`;

/** Holds a key down in the browser window (trusted, nsITextInputProcessor): "Control", "Meta", "Tab"… */
export function keyDown(m: Marionette, key: string): Promise<unknown> {
  return m.execute(`${TIP} tip.keydown(ev(arguments[0]));`, [key]);
}

export function keyUp(m: Marionette, key: string): Promise<unknown> {
  return m.execute(`${TIP} tip.keyup(ev(arguments[0]));`, [key]);
}

/** Presses a combo like "Meta+t", "Control+Tab" or "Escape": modifiers down in order, the key, then all up. */
export async function pressKeys(m: Marionette, combo: string): Promise<void> {
  const keys = combo.split("+");
  for (const k of keys) await keyDown(m, k);
  for (const k of keys.reverse()) await keyUp(m, k);
}

/** Types `text` key by key where the keyboard is (trusted keys). */
export async function typeText(m: Marionette, text: string): Promise<void> {
  for (const k of text) await pressKeys(m, k);
}

/** ApiRessac members the UI reached that the Firefox api does not implement. */
export function missingApi(m: Marionette): Promise<string[]> {
  return inUi(m, "return [...(ui.ressacMissingApi ?? [])]");
}

/** The RGB colour at (x, y) of a Marionette screenshot of the browser window (chrome context). */
export async function pixel(m: Marionette, x: number, y: number): Promise<[number, number, number]> {
  const png = (await m.command<{ value: string }>("WebDriver:TakeScreenshot", { full: false, hash: false })).value;
  return m.execute(
    `return (async () => {
      const img = new Image();
      img.src = "data:image/png;base64," + arguments[0];
      await img.decode();
      const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const c = canvas.getContext("2d");
      c.drawImage(img, 0, 0);
      // The screenshot is in device pixels.
      const d = c.getImageData(Math.round(arguments[1] * devicePixelRatio), Math.round(arguments[2] * devicePixelRatio), 1, 1).data;
      return [d[0], d[1], d[2]];
    })();`,
    [png, x, y],
  );
}

/** Opens the window's agent panel with ✦ if it is closed (it never opens on its own) and waits for its session to be ready; the panel stays open. */
export async function agentPanelReady(m: Marionette): Promise<void> {
  if (await m.execute<boolean>("return document.getElementById('ressac-agent').hidden")) await click(m, '[data-testid="agent-button"]');
  await waitUi(m, "return doc.querySelector('.xterm-rows')?.textContent.includes('ready>')", [], 20_000, "agent");
}

/** Opens the window's agent panel (✦: it never opens on its own) until its session is ready, then closes it: the session goes on. */
export async function startAgentSession(m: Marionette): Promise<void> {
  await click(m, '[data-testid="agent-button"]');
  await waitUi(m, "return doc.querySelector('.xterm-rows')?.textContent.includes('ready>')", [], 20_000, "agent");
  await click(m, '[data-testid="agent-button"]');
  for (const end = Date.now() + 10_000; !(await m.execute<boolean>("return document.getElementById('ressac-agent').hidden")); await new Promise((r) => setTimeout(r, 100)))
    if (Date.now() > end) throw new Error("the agent panel did not close");
}
