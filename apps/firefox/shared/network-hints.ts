/**
 * What, in the HTML of a widget display, would make something leave the machine without going through the CSP:
 * `<link>` (dns-prefetch resolves a name chosen by the widget: the data leaves in the DNS request), `<meta
 * http-equiv>` (x-dns-prefetch-control: link resolution would be turned back on) and speculation rules. Refused
 * in affichage.html (served from a copy, widget-frame.ts) as in the HTML that the display writes (guard placed
 * at the top of the served copy, widget-frame.ts).
 *
 * No imports: the guard serialized into the served copy must pull nothing else.
 */
export const NETWORK_HINTS_PATTERN = "<\\s*link(?![a-z0-9-])|http-equiv|speculationrules";

/**
 * Decodes what can hide a `<` in an attribute (`srcdoc="&lt;link …"`, including nested: `&amp;lt;`) before
 * looking for the pattern. A false positive (the word in a text) only refuses the display: the agent rewrites it.
 */
export function containsNetworkHint(html: string): boolean {
  let before: string;
  let x = html;
  do {
    before = x;
    x = x.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(lt|gt|amp|quot|apos));?/gi, (_m, dec?: string, hex?: string, name?: string) => {
      if (name) return ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as Record<string, string>)[name.toLowerCase()]!;
      const n = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : String.fromCharCode(0xfffd);
    });
  } while (x !== before);
  return new RegExp(NETWORK_HINTS_PATTERN, "i").test(x);
}
