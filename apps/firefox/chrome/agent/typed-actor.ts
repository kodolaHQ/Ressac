// What the user typed in a page's fields (design § 5.2): an address form's value is offered to the passport only if
// typed here, by keyboard. The child's word only narrows what Firefox captured (the gate is the frozen bar and Touch ID),
// so a compromised process gains nothing by lying. Packaged: a change here needs build:ui.

const MAX_VALUES = 64;
const MAX_LENGTH = 300;
/** A pushed list waits this long for the submission Firefox notes after it (the page may be gone by then). */
const KEEP_MS = 60_000;
const KEEP_DOCS = 32;

const bounded = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string").map((x) => x.trim()))].filter((x) => x && x.length <= MAX_LENGTH).slice(0, MAX_VALUES) : [];

/** Per document (innerWindowId): its last pushed list, for a submission noted once it navigated away. */
const pushed = new Map<number, { at: number; values: string[] }>();

export class RessacTypedParent extends JSWindowActorParent {
  /** What the user typed in document `wgp`: its live answer, else what it pushed at its last send. Read once. */
  static async typedOf(wgp: any): Promise<string[]> {
    const kept = pushed.get(wgp.innerWindowId);
    pushed.delete(wgp.innerWindowId);
    try {
      return bounded(await wgp.getActor("RessacTyped").sendQuery("typedValues"));
    } catch {
      // The document is gone (the send navigated) or is not https.
      return kept && Date.now() - kept.at < KEEP_MS ? kept.values : [];
    }
  }

  receiveMessage(m: { name: string; data?: unknown }): void {
    if (m.name !== "typed") return;
    pushed.delete(this.manager.innerWindowId);
    pushed.set(this.manager.innerWindowId, { at: Date.now(), values: bounded(m.data) });
    // The oldest first: a page sending in a loop holds at most KEEP_DOCS lists.
    for (const k of pushed.keys()) if (pushed.size > KEEP_DOCS) pushed.delete(k);
  }
}

const field = (t: EventTarget | undefined): HTMLInputElement | HTMLTextAreaElement | null => {
  const el = t as Element | undefined;
  return el?.tagName === "TEXTAREA" || (el?.tagName === "INPUT" && (el as HTMLInputElement).type !== "password") ? (el as HTMLInputElement) : null;
};

export class RessacTypedChild extends JSWindowActorChild {
  /** Each field the user typed in, with its value after the last keystroke. */
  private typed = new Map<HTMLInputElement | HTMLTextAreaElement, string>();

  /** The fields whose value is still the one typed: a script that changed it since leaves it out. */
  private values(): string[] {
    return bounded([...this.typed].filter(([el, v]) => el.value === v).map(([, v]) => v));
  }

  handleEvent(e: Event): void {
    if (e.type === "input") {
      const el = field(e.composedPath()[0]);
      if (!el) return;
      const kind = (e as InputEvent).inputType;
      // A keyboard edit (typing, deleting, pasting); not a script's event, an autofill's or an autocomplete's replacement.
      if (e.isTrusted && typeof kind === "string" && /^(insert|delete)/.test(kind) && kind !== "insertReplacementText") this.typed.set(el, el.value);
      else this.typed.delete(el);
      return;
    }
    // submit, beforeunload: the parent keeps the list for a submission it notes after the page is gone.
    const v = this.values();
    if (v.length) this.sendAsyncMessage("typed", v);
  }

  receiveMessage(m: { name: string }): unknown {
    return m.name === "typedValues" ? this.values() : null;
  }

  didDestroy(): void {
    this.typed.clear();
  }
}
