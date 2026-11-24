import { randomBytes } from "node:crypto";
import type { Zone } from "./detectors.js";
import { maskText, type MaskContext } from "./mask.js";
import { LABEL_SOURCE, type LabelTable } from "./table.js";

const PRIVATE_USE = /[-]/g;
const TAGGED = /([0-9a-f]{16})([^-]*)/g;
const URL = /https?:\/\/[^\s<>"'`]+/g;
const LABEL = new RegExp(LABEL_SOURCE);

/** `text` without the marks `wrap` puts in, for what reads a result raw (the outflow rules). */
export const unwrap = (text: string) => text.replace(/[0-9a-f]{16}|/g, "");

/**
 * The zones of one request's results. A handler tags each part it builds from a source with `wrap`; `apply` masks
 * each part by its zone and origin, the rest as `web` with no origin. A tag is a fresh random token: page text cannot
 * forge one (wrap strips the mark characters from it, and an unknown token counts as untagged).
 */
export class Segments {
  private readonly tags = new Map<string, Tag>();
  private rawGiven = false;

  /** `seen`, if given, receives this part as masked: what the agent was shown of it. */
  wrap(text: string, zone: Zone, origin: string | null, seen?: (masked: string) => void): string {
    return this.tag(text, { zone, origin, ...(seen ? { seen } : {}) });
  }

  /** Kernel text printed as it is, never masked again: an issued handle (masking it with the table's entries would be an oracle). */
  verbatim(text: string): string {
    return this.tag(text, "verbatim");
  }

  /**
   * The one exception to masking: the value the user agreed to reveal (`reveal_value`), left as it is in this one result.
   * Once per request, so no other part of a result can ride on it; page text cannot forge its random token.
   */
  raw(value: string): string {
    if (this.rawGiven) throw new Error("one raw value per result");
    this.rawGiven = true;
    return this.tag(value, "verbatim");
  }

  apply(text: string, table: LabelTable): string {
    let out = "";
    let at = 0;
    for (const m of text.matchAll(TAGGED)) {
      const tag = this.tags.get(m[1]!);
      out += mask(text.slice(at, m.index), { table, zone: "web", origin: null });
      if (tag === "verbatim") out += m[2]!;
      else {
        const masked = mask(m[2]!, { table, zone: tag?.zone ?? "web", origin: tag ? tag.origin : null });
        tag?.seen?.(masked);
        out += masked;
      }
      at = m.index + m[0].length;
    }
    return out + mask(text.slice(at), { table, zone: "web", origin: null });
  }

  private tag(text: string, tag: Tag): string {
    const token = randomBytes(8).toString("hex");
    this.tags.set(token, tag);
    return `${token}${text.replace(PRIVATE_USE, "")}`;
  }
}

type Tag = { zone: Zone; origin: string | null; seen?: (masked: string) => void } | "verbatim";

/**
 * `maskText`, plus a handle for each web address it rewrote: the agent may give the masked address back whole and the
 * kernel opens the real one. Addresses pair up in order; if masking changed their count, no handle is kept. No other
 * table lookup by address: rewriting a real address the table knows, in any zone, would tell a page its guess was right.
 */
function mask(s: string, ctx: MaskContext): string {
  if (!s) return s;
  const out = maskText(s, ctx);
  const real = s.replace(PRIVATE_USE, "").match(URL) ?? [];
  const shown = out.match(URL) ?? [];
  if (real.length === shown.length) shown.forEach((u, i) => u !== real[i] && LABEL.test(u) && ctx.table.handle(u, real[i]!, ctx.origin ?? ""));
  return out;
}
