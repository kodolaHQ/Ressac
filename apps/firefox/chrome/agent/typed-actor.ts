// What the user typed in a page's fields (design § 5.2): an address form's value is offered to the passport only if
// typed here (passport/typed-fields.ts). The child's word only narrows what Firefox captured (the gate is the frozen bar
// and Touch ID), so a compromised process gains nothing by lying. Packaged: a change here needs build:ui.

import { bounded, typedFields } from "../passport/typed-fields";

/** A list waits this long for the submissions Firefox notes after it (the page may be gone, or its fields cleared). */
const KEEP_MS = 60_000;
const KEEP_DOCS = 32;

/** Per document (innerWindowId): its last non-empty list, for every section of a submission noted after a send. */
const kept = new Map<number, { at: number; values: string[] }>();
const keep = (id: number, values: string[]) => {
  kept.delete(id);
  kept.set(id, { at: Date.now(), values });
  // The oldest first: a page sending in a loop holds at most KEEP_DOCS lists.
  for (const k of kept.keys()) if (kept.size > KEEP_DOCS) kept.delete(k);
};

export class RessacTypedParent extends JSWindowActorParent {
  /** What the user typed in document `wgp`: its live answer, else its fresh kept list. */
  static async typedOf(wgp: any): Promise<string[]> {
    const id = wgp.innerWindowId;
    try {
      const live = bounded(await wgp.getActor("RessacTyped").sendQuery("typedValues"));
      if (live.length) {
        keep(id, live);
        return live;
      }
    } catch {
      // The document is gone (the send navigated) or is not https.
    }
    const k = kept.get(id);
    return k && Date.now() - k.at < KEEP_MS ? k.values : [];
  }

  receiveMessage(m: { name: string; data?: unknown }): void {
    const values = m.name === "typed" ? bounded(m.data) : [];
    if (values.length) keep(this.manager.innerWindowId, values);
  }
}

type Field = HTMLInputElement | HTMLTextAreaElement;
const field = (t: EventTarget | undefined): Field | null => {
  const el = t as Element | undefined;
  return el?.tagName === "TEXTAREA" || (el?.tagName === "INPUT" && (el as HTMLInputElement).type !== "password") ? (el as Field) : null;
};

export class RessacTypedChild extends JSWindowActorChild {
  private typed = typedFields<Field>();

  handleEvent(e: Event): void {
    const el = field(e.composedPath()[0]);
    if (e.type === "keydown" || e.type === "paste" || e.type === "drop") return void (el && this.typed.arm(el, e.isTrusted));
    if (e.type === "keyup" || e.type === "focusout") return void (el && this.typed.disarm(el));
    if (e.type === "input") return void (el && this.typed.input(el, e.isTrusted, (e as InputEvent).inputType));
    // submit, beforeunload, pagehide: the parent keeps the list for a submission it notes after the page is gone.
    const v = this.typed.take();
    if (v.length) this.sendAsyncMessage("typed", v);
  }

  receiveMessage(m: { name: string }): unknown {
    return m.name === "typedValues" ? this.typed.take() : null;
  }

  didDestroy(): void {
    this.typed.clear();
  }
}
