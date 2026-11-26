import { LABELS } from "../../../../../packages/kernel/src/mask/table";

/**
 * The agent's text as HTML, for `{@html}`: paragraphs, lists, `**bold**`, `*em*`, inline and fenced code, http(s) and
 * mailto links. Everything else is escaped: no HTML from the agent (or a page it read) ever reaches the panel as markup.
 */

/** A masked label's chip, built by the caller (its own markup, trusted): `type` is the label's kind (`nom`, `iban`…). */
export type Chip = (label: string, type: string) => string;

export const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const SAFE_URL = /^(https?:\/\/|mailto:)/i;

/** Escaped text with its labels as chips (a user's message, a link's text). */
export function renderPlain(text: string, chip?: Chip): string {
  const html = escape(text);
  return chip ? html.replace(LABELS, (label, type: string) => chip(label, type)) : html;
}

function emphasis(text: string, chip?: Chip): string {
  const html = escape(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>");
  return chip ? html.replace(LABELS, (label, type: string) => chip(label, type)) : html;
}

function links(text: string, chip?: Chip): string {
  let out = "";
  let at = 0;
  for (const m of text.matchAll(/\[([^\]\n]+)\]\(([^)\s]+)\)/g)) {
    out += emphasis(text.slice(at, m.index), chip);
    out += SAFE_URL.test(m[2]!) ? `<a href="${escape(m[2]!)}" rel="noopener">${emphasis(m[1]!, chip)}</a>` : emphasis(m[0], chip);
    at = m.index + m[0].length;
  }
  return out + emphasis(text.slice(at), chip);
}

function inline(text: string, chip?: Chip): string {
  return text
    .split(/(`[^`\n]+`)/)
    .map((part, i) => (i % 2 ? `<code>${escape(part.slice(1, -1))}</code>` : links(part, chip)))
    .join("");
}

/** `copy`: markup put first in each code block (its copy button). */
export function renderMarkdown(src: string, chip?: Chip, copy = ""): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let list = null as { tag: "ul" | "ol"; items: string[] } | null;
  const flush = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map((l) => inline(l, chip)).join("<br>")}</p>`);
    paragraph = [];
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i, chip)}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) code.push(lines[i]!);
      out.push(`<pre>${copy}<code>${escape(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const item = /^\s*(?:([-*+])|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const tag = item[1] ? "ul" : "ol";
      if (paragraph.length || list?.tag !== tag) flush();
      (list ??= { tag, items: [] }).items.push(item[2]!);
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      out.push(`<p><strong>${inline(heading[1]!, chip)}</strong></p>`);
      continue;
    }
    if (list) flush();
    paragraph.push(line);
  }
  flush();
  return out.join("");
}
