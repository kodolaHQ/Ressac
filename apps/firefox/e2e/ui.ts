import type { Marionette } from "./marionette";

/** The UI iframes: the sidebar (`#webaios-sidebar`), the agent panel (`#webaios-agent`) and the design overlays, with what shows each is mounted. */
const FRAMES = {
  sidebar: { id: "webaios-sidebar", mounted: '[data-testid="sidebar"]' },
  agent: { id: "webaios-agent", mounted: '[data-testid="agent-panel"]' },
  // The design mode's overlay (bubble, message) and a main window's cart column (chrome/window/design-overlays.ts).
  overlay: { id: "webaios-design-calque", mounted: "#app" },
  panel: { id: "webaios-design-volet", mounted: "#app" },
};
export type Frame = keyof typeof FRAMES;

/**
 * Runs `body` (an async function body, chrome context) with `doc` = the document of a WebAiOs UI iframe (the sidebar by
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
     await new Promise((r) => requestAnimationFrame(r));
     const r = el.getBoundingClientRect();
     const x = r.left + r.width / 2, y = r.top + r.height / 2;
     // A right click as Gecko delivers it on macOS: contextmenu on the press, then the release, whose click (button 2) reaches chrome documents.
     const types = arguments[2] === 2 ? ["mousedown", "contextmenu", "mouseup"] : ["mousedown", "mouseup"];
     for (const type of types) ui.synthesizeMouseEvent(type, x, y, { button: arguments[2], clickCount: 1 });`,
    [selector, o.text ?? null, o.button ?? 0],
    o.frame,
  );
}

const TIP = `const tip = (window.webaiosTestTip ??= Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor));
  tip.beginInputTransactionForTests(window);
  const CODES = { "[": "BracketLeft", "]": "BracketRight", "{": "BracketLeft", "}": "BracketRight", Meta: "MetaLeft", Control: "ControlLeft", Shift: "ShiftLeft", Alt: "AltLeft", " ": "Space", "-": "Minus", ",": "Comma", "/": "Slash", "$": "Digit4" };
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

/** ApiWebaios members the UI reached that the Firefox api does not implement. */
export function missingApi(m: Marionette): Promise<string[]> {
  return inUi(m, "return [...(ui.webaiosMissingApi ?? [])]");
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
