import type { Marionette } from "./marionette";

/**
 * Runs `body` (an async function body, chrome context) with `doc` = the document of the WebAiOs UI iframe and `ui` = its
 * window. `arguments[i]` are the args. Waits up to 10 s for the UI to be mounted.
 */
export function inUi<T = unknown>(m: Marionette, body: string, args: unknown[] = []): Promise<T> {
  return m.execute<T>(
    `return (async () => {
      const frame = document.getElementById("webaios-sidebar");
      for (let i = 0; i < 100 && !frame?.contentDocument?.querySelector('[data-testid="barre-laterale"]'); i++) await new Promise((r) => setTimeout(r, 100));
      const doc = frame.contentDocument;
      const ui = doc.defaultView;
      ${body}
    })();`,
    args,
  );
}

/** Polls `body` (see inUi) until it returns a truthy value; returns it. */
export async function waitUi<T = unknown>(m: Marionette, body: string, args: unknown[] = [], ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await inUi<T>(m, body, args);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting in the UI on: ${body}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * A trusted mouse click (`button` 0) or right click (2: contextmenu) at the centre of the first element matching
 * `selector` in the UI, and whose text contains `text` if given. Waits for it to appear.
 */
export async function click(m: Marionette, selector: string, o: { button?: 0 | 2; text?: string } = {}): Promise<void> {
  const find = "const el = [...doc.querySelectorAll(arguments[0])].find((e) => !arguments[1] || e.textContent.includes(arguments[1]));";
  await waitUi(m, `${find} return !!el;`, [selector, o.text ?? null]);
  await inUi(
    m,
    `${find}
     const r = el.getBoundingClientRect();
     const x = r.left + r.width / 2, y = r.top + r.height / 2;
     if (arguments[2] === 2) ui.synthesizeMouseEvent("contextmenu", x, y, { button: 2 });
     else for (const type of ["mousedown", "mouseup"]) ui.synthesizeMouseEvent(type, x, y, { button: 0, clickCount: 1 });`,
    [selector, o.text ?? null, o.button ?? 0],
  );
}

const TIP = `const tip = (window.webaiosTestTip ??= Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor));
  tip.beginInputTransactionForTests(window);
  const CODES = { "[": "BracketLeft", "]": "BracketRight", Meta: "MetaLeft", Control: "ControlLeft", Shift: "ShiftLeft", Alt: "AltLeft" };
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
