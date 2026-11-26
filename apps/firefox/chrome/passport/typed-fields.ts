// What the user typed in a page's fields (design § 5.2, ruling R14), kept apart from the actor so it is testable.
// Imported by typed-actor.ts only: a module shared by two actor entries would become a chunk the jar does not ship.

const MAX_VALUES = 64;
const MAX_LENGTH = 300;

/** Strings only, trimmed, deduplicated, at most MAX_VALUES of MAX_LENGTH chars: what a content process sends is bounded. */
export const bounded = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string").map((x) => x.trim()))].filter((x) => x && x.length <= MAX_LENGTH).slice(0, MAX_VALUES) : [];

/**
 * A field counts as typed when its input follows a trusted keydown, paste or drop on that same field (consumed by that
 * input, dropped at its keyup or when the field loses focus), or is a trusted composition: a script's change, execCommand and
 * Firefox's autofill never qualify. A value counts only while the field still holds it.
 */
export function typedFields<E extends { value: string }>() {
  const armed = new Set<E>();
  const typed = new Map<E, string>();
  return {
    /** A trusted keydown, paste or drop on `el`. */
    arm(el: E, trusted: boolean): void {
      if (trusted) armed.add(el);
    },
    /** A keyup or focusout on `el`: a key that typed nothing (Tab, Enter) leaves no arm for a later script. */
    disarm(el: E): void {
      armed.delete(el);
    },
    input(el: E, trusted: boolean, kind: unknown): void {
      const was = armed.delete(el);
      const k = typeof kind === "string" ? kind : "";
      // A composition (a dead key, the accent menu, an IME) is the keyboard's even when no key comes just before: its input
      // can follow the key's keyup, or a click in the accent menu. No page or autofill makes a trusted one.
      // Not an autofill's or autocomplete's replacement, even right after a key.
      if (trusted && /^(insert|delete)/.test(k) && k !== "insertReplacementText" && (was || k.includes("Composition"))) typed.set(el, el.value);
      // A replacement (autofill, a spelling fix) is not typed; the field's old value no longer matches unless typed again.
      else if (!(trusted && k === "insertReplacementText")) typed.delete(el);
    },
    /** The values still in their fields, bounded; then forgotten, so a form detected again is not offered again. */
    take(): string[] {
      const out = bounded([...typed].filter(([el, v]) => el.value === v).map(([, v]) => v));
      typed.clear();
      return out;
    },
    clear(): void {
      armed.clear();
      typed.clear();
    },
  };
}
