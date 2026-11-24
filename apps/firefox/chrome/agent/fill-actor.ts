// The fill actor (spec § 5.4, `fill_field`), in every http(s) frame of a tab. The child lists the fields of its own
// document and writes a value only after it has checked, in one synchronous block, that the field is still exactly
// the one sealed. It acts only on the parent's demand (chrome/agent/fill.ts), which computes the frame chain itself,
// keeps the seals and fetches the saved logins: nothing the child answers widens where a value goes.
// Packaged: a change here needs build:ui.

import { FIELDS_MAX } from "../../../../packages/kernel/src/mcp/bridge";

/**
 * What the parent sealed, as the child checks it again before it writes. `frames[0]`: this document's origin;
 * `placement`: the token of where the field sat when this seal was made (each `facts` answer has its own).
 */
export type Seal = {
  innerWindowId: number; handle: number; frames: string[]; action: string | null; type: string; autocomplete: string; placement: string;
  /** The field's label as the card names it: relabelled since (« Newsletter » become « Supprimer mon compte »), nothing is written. */
  label: string;
  /** Firefox's login pairing when sealed: the other field's number and this field's role in the pair; null outside one. */
  partner: number | null; role: "username" | "password" | null;
};

const LABEL_MAX = 80;
/** Placements of seals never committed (a card refused) are dropped past this many, oldest first. */
const PLACED_MAX = 64;
const XHTML = "http://www.w3.org/1999/xhtml";
/** The input types that take typed text. */
const TEXT_TYPES = new Set(["text", "password", "email", "tel", "search", "url", "number"]);
/** The input types the agent ticks rather than types into. */
const TICK_TYPES = new Set(["checkbox", "radio"]);
/** A select's options listed at most, each bounded like a label. */
const OPTIONS_MAX = 50;
/** The `contenteditable` values that make an editing host. */
const EDITABLE = new Set(["", "true", "plaintext-only"]);

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
};
const autocompleteOf = (el: any): string => (el.getAttribute("autocomplete") ?? "").trim().toLowerCase();
/** One line, without « »: a label never plants a quoted site in the card's sentence. */
const clean = (s: unknown) => String(s ?? "").replace(/[«»]/g, "").replace(/\s+/g, " ").trim();
/** Never the field's content: its label, ARIA name, placeholder or name; a radio's question (its fieldset's legend) first. */
const labelOf = (el: any): string => {
  const own = clean(el.labels?.[0]?.textContent || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name"));
  const legend = el.type === "radio" ? clean(el.closest("fieldset")?.querySelector("legend")?.textContent) : "";
  // Trimmed after the cut, as boundFields does: a sealed label compares equal to the one read.
  return (legend ? `${legend} : ${own}` : own).slice(0, LABEL_MAX).trim();
};
/** What a select's option says: what the user sees in the list, as compared again before the choice. */
const optionText = (o: any): string => clean(o.label || o.text).slice(0, LABEL_MAX).trim();
/** The form a control belongs to (inside it or tied with `form=`); an editing host has none. */
const formOf = (el: any): any => (el.localName === "input" || el.localName === "textarea" || el.localName === "select" ? (el.form ?? null) : null);
/** A box to tick or a list to choose from: what the agent sets, never types. */
export type Choice = { check: boolean } | { option: number; text: string };

export class RessacFillParent extends JSWindowActorParent {}

export class RessacFillChild extends JSWindowActorChild {
  /** Each field seen in this document keeps its number for the document's life: the kernel numbers fields from its read. */
  private readonly refs = new Map<number, WeakRef<Element>>();
  private readonly numbers = new WeakMap<Element, number>();
  /**
   * Where a field sat when it was sealed (parent node, element siblings, form), by the seal's placement token: a later
   * seal of the same handle never changes an earlier one's. Moved since, it is not the field sealed.
   */
  private readonly placed = new Map<string, { handle: number; parent: WeakRef<Node>; previous: WeakRef<Element> | null; next: WeakRef<Element> | null; form: WeakRef<Element> | null }>();
  private next = 0;

  receiveMessage(m: { name: string; data?: any }) {
    if (m.name === "fields") return this.fields();
    if (m.name === "facts") return this.facts(m.data?.handle);
    if (m.name === "fill") return this.fill(m.data?.seal, m.data?.value);
    return undefined;
  }

  /** The visible, enabled fields of this document, in document order (not those of its frames: each has its own actor). */
  private fields() {
    // shortcut: fields inside shadow roots are not offered (querySelectorAll stays out of them), and submit controls in one
    // escape the formaction rule; upgrade when a real site the agent must fill puts its form in a shadow root.
    for (const [n, ref] of this.refs) if (!ref.deref()) this.refs.delete(n);
    type Listed = { n: number; type: string; autocomplete: string; label: string; offscreen?: true; checked?: boolean; options?: string[]; selected?: number };
    const found: { el: any; type: string }[] = [];
    for (const el of this.document.querySelectorAll("input, textarea, select, [contenteditable]")) {
      const type = this.typeOf(el);
      if (type) found.push({ el, type });
    }
    // Over the cap, boxes and lists give way to the fields that take text (a page of filters must not hide its form).
    const texts = found.filter((f) => !this.choosable(f.type)).length;
    let room = Math.max(0, FIELDS_MAX - texts);
    const kept = found.filter((f) => !this.choosable(f.type) || room-- > 0).slice(0, FIELDS_MAX);
    const w = this.contentWindow!;
    return kept.map(({ el, type }): Listed => {
      // Two forms with the same field (a page's hero and its form below): the one in view is the one the user means.
      const r = el.getBoundingClientRect();
      const offscreen = r.bottom <= 0 || r.right <= 0 || r.top >= w.innerHeight || r.left >= w.innerWidth;
      const state = TICK_TYPES.has(type) ? { checked: el.checked === true } : type === "select" ? { options: [...el.options].slice(0, OPTIONS_MAX).map(optionText), selected: el.selectedIndex } : {};
      return { n: this.numberOf(el), type, autocomplete: autocompleteOf(el), label: labelOf(el), ...(offscreen ? { offscreen: true as const } : {}), ...state };
    });
  }

  private numberOf(el: Element): number {
    let n = this.numbers.get(el);
    if (n === undefined) {
      n = this.next++;
      this.numbers.set(el, n);
      this.refs.set(n, new WeakRef(el));
    }
    return n;
  }

  private choosable = (type: string) => TICK_TYPES.has(type) || type === "select";

  /** An input that takes text, a box to tick, a one-choice list, a textarea or an editing host, enabled and visible; null for anything else. */
  private typeOf(el: any): string | null {
    if (el.namespaceURI !== XHTML) return null;
    let type: string | null = null;
    if (el.localName === "input") type = TEXT_TYPES.has(el.type) || TICK_TYPES.has(el.type) ? el.type : null;
    else if (el.localName === "textarea") type = "textarea";
    // shortcut: a multiple-choice list is not offered; upgrade when a form the agent must fill needs one.
    else if (el.localName === "select") type = el.multiple ? null : "select";
    else if (EDITABLE.has(el.getAttribute("contenteditable") ?? "-") && el.isContentEditable && !el.parentElement?.isContentEditable) type = "contenteditable";
    if (!type || el.disabled || el.readOnly || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return null;
    return type;
  }

  /**
   * Where the form sends the field: the form's resolved action, or another origin that one of its submit controls
   * (`formaction`, inside it or tied with `form=`) would send to (fail closed); null without a form.
   */
  private actionOf(form: any): string | null {
    if (!form) return null;
    // Through the prototype: a control named « action » stands for the property on the form itself.
    const action = String(Object.getOwnPropertyDescriptor((this.contentWindow as any).HTMLFormElement.prototype, "action")!.get!.call(form));
    const own = originOf(action);
    for (const c of this.document.querySelectorAll("button, input") as any) {
      if (c.form !== form || !c.hasAttribute("formaction")) continue;
      const submits = c.localName === "button" ? c.type === "submit" : c.type === "submit" || c.type === "image";
      const to = originOf(c.formAction);
      if (submits && to !== own) return to;
    }
    return action;
  }

  private factsOf(el: any): { type: string; autocomplete: string; label: string; action: string | null; partner: number | null; role: "username" | "password" | null } | null {
    if (!el?.isConnected || el.ownerDocument !== this.document) return null;
    const type = this.typeOf(el);
    return type ? { type, autocomplete: autocompleteOf(el), label: labelOf(el), action: this.actionOf(formOf(el)), ...this.pairOf(el) } : null;
  }

  /**
   * A field's login pair, as Firefox's own autofill makes it (LoginManagerChild's form detection): the form's username
   * and password fields, both numbered by a read. Gives the other field's number and this field's role; none outside a
   * pair. Part of the seal: a pairing changed between the card and the write writes nothing.
   */
  private pairOf(el: any): { partner: number | null; role: "username" | "password" | null } {
    const none = { partner: null, role: null };
    if (el.localName !== "input") return none;
    try {
      const [user, pass] = (this as any).manager.getActor("LoginManager").stateForDocument(this.document).getUserNameAndPasswordFields(el);
      if (!user || !pass) return none;
      const role = el === user ? "username" : el === pass ? "password" : null;
      const partner = role && this.numbers.get(role === "username" ? pass : user);
      return role && partner !== undefined ? { partner, role } : none;
    } catch {
      return none;
    }
  }

  /** The facts the parent seals, with the token of where the field sits now; null for a handle that is no field of this document now. */
  private facts(handle: unknown) {
    const el: any = typeof handle === "number" ? this.refs.get(handle)?.deref() : undefined;
    const facts = this.factsOf(el);
    if (!facts) return null;
    const ref = (x: any) => (x ? new WeakRef(x) : null);
    const placement = crypto.randomUUID();
    this.placed.set(placement, { handle: handle as number, parent: new WeakRef(el.parentNode), previous: ref(el.previousElementSibling), next: ref(el.nextElementSibling), form: ref(formOf(el)) });
    if (this.placed.size > PLACED_MAX) this.placed.delete(this.placed.keys().next().value!);
    return { ...facts, placement };
  }

  /**
   * One synchronous block, the page runs nothing in between: find the field by its handle, recompute its seal, compare,
   * then write. Any difference writes nothing. The frame chain above this document is the parent's to check (it does,
   * just before it sends): an ancestor that navigates takes this document down with it.
   */
  private fill(seal: Seal, value: unknown): "filled" | "changed" {
    if (!seal || typeof seal.handle !== "number") return "changed";
    const v: any = value;
    const kind = typeof v === "string" ? "text" : typeof v?.check === "boolean" ? "check" : Number.isInteger(v?.option) && typeof v?.text === "string" ? "option" : null;
    if (!kind) return "changed";
    const el: any = this.refs.get(seal.handle)?.deref();
    const at = typeof seal.placement === "string" ? this.placed.get(seal.placement) : undefined;
    if (at) this.placed.delete(seal.placement);
    const now = this.factsOf(el);
    const same =
      !!now &&
      !!at &&
      at.handle === seal.handle &&
      // A document kept in the back-forward cache is not on screen: nothing goes into it.
      !this.windowContext.isInBFCache &&
      this.windowContext.innerWindowId === seal.innerWindowId &&
      (this.document as any).nodePrincipal.originNoSuffix === seal.frames?.[0] &&
      now.type === seal.type &&
      now.autocomplete === seal.autocomplete &&
      now.label === seal.label &&
      now.action === seal.action &&
      now.partner === seal.partner &&
      now.role === seal.role &&
      at.parent.deref() === el.parentNode &&
      (at.previous?.deref() ?? null) === el.previousElementSibling &&
      (at.next?.deref() ?? null) === el.nextElementSibling &&
      (at.form?.deref() ?? null) === formOf(el);
    if (!same) return "changed";
    // Each value only into its kind of field: text into a field that takes text, a tick into a box, a choice into a list.
    if (kind !== (TICK_TYPES.has(now.type) ? "check" : now.type === "select" ? "option" : "text")) return "changed";
    if (kind === "check") {
      // A radio is only ever ticked: unticking one is ticking another.
      if (now.type === "radio" && !v.check) return "changed";
      // The page's own click: the frameworks that watch a box listen to it, and it fires input and change.
      if (el.checked !== v.check) el.click();
      return el.checked === v.check ? "filled" : "changed";
    }
    const win = this.contentWindow as any;
    if (kind === "option") {
      // The option the agent read, at the same place: a list reordered since chooses nothing.
      const o = el.options[v.option];
      if (!o || o.disabled || optionText(o) !== v.text) return "changed";
      el.selectedIndex = v.option;
    } else if (now.type === "contenteditable") el.textContent = v;
    else el.value = v;
    for (const type of ["input", "change"]) el.dispatchEvent(new win.Event(type, { bubbles: true }));
    return "filled";
  }
}
