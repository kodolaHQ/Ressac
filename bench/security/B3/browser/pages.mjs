// The pages of the real-browser replay (B3): what the local web server answers, from the same rules as harness.mts pageAt.
//   node pages.mjs --selftest
import { readFileSync } from "node:fs";
import { PROFILES } from "../profiles.mjs";

/** B3's search engine; its search template is `${ENGINE}?q=%s`. */
export const ENGINE = "https://www.cherchetout.fr/";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const doc = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>${body}</body></html>`;
const inline = (s) => {
  let out = "", last = 0;
  for (const m of s.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)) {
    out += esc(s.slice(last, m.index).replace(/[*_]/g, "")) + `<a href="${esc(m[2])}">${esc(m[1].replace(/[*_]/g, ""))}</a>`;
    last = m.index + m[0].length;
  }
  return out + esc(s.slice(last).replace(/[*_]/g, ""));
};

/** Markdown (headings, paragraphs, `- ` lists, links) to a full HTML document. */
export function mdToHtml(md, title) {
  const body = md.split(/\n\s*\n/).map((block) => {
    const lines = block.split("\n").filter((l) => l.trim());
    if (!lines.length) return "";
    if (lines.every((l) => l.startsWith("- "))) return `<ul>${lines.map((l) => `<li>${inline(l.slice(2))}</li>`).join("")}</ul>`;
    const h = lines[0].match(/^(#{1,3}) (.*)$/);
    if (h && lines.length === 1) return `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
    return `<p>${lines.map(inline).join(" ")}</p>`;
  }).join("\n");
  return doc(title, body);
}

const withoutHash = (u) => { try { const x = new URL(u); x.hash = ""; return x.href; } catch { return u; } };
const paragraphs = (text) => text.split("\n").map((l) => `<p>${esc(l)}</p>`).join("");

/** The answer to an address, for case `c` and profile `p`. shortcut: no engine-redirect unwrapping (no frozen case wraps a link), upgrade if one does. */
export function router(c, p) {
  const P = PROFILES[p];
  const casePage = () => ({ kind: "case", html: mdToHtml(c.page_markdown, c.title).replace("</body>", `<ul>${c.links.map((l) => `<li><a href="${esc(l.url)}">${esc(l.text)}</a></li>`).join("")}</ul></body>`) });
  const own = new Set(c.links.map((l) => withoutHash(l.url)));
  return (url) => {
    if (url === P.mailUrl) return { kind: "mail", html: doc(P.mail.title, paragraphs(P.mail.text)) };
    if (url === P.bankUrl) return { kind: "bank", html: doc(P.bank.title, paragraphs(P.bank.text)) };
    if (url.startsWith(ENGINE)) return new URL(url).searchParams.get("q") ? casePage() : { kind: "engine-empty", html: doc("Cherchetout", "") };
    const h = P.history.find((x) => x.url === url);
    if (h) return { kind: "history", html: doc(h.title, paragraphs(h.text)) };
    if (own.has(withoutHash(url))) return casePage();
    return { kind: "other", html: doc("", "") };
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.argv.includes("--selftest")) throw new Error("usage: node pages.mjs --selftest");
  const assert = (await import("node:assert")).strict;
  const h = mdToHtml("# T\n\nA [x](https://a.test/p?q=1) <b>", "T");
  for (const s of ["<h1>T</h1>", '<a href="https://a.test/p?q=1">x</a>', "&lt;b&gt;"]) assert.ok(h.includes(s), s);
  const { model } = JSON.parse(readFileSync(new URL("replay-cases.json", import.meta.url), "utf8"));
  assert.ok(model.length > 0);
  for (const c of model) {
    const r = router(c, "a");
    assert.equal(r(`${ENGINE}?q=x`).kind, "case", c.id);
    assert.equal(r(ENGINE).kind, "engine-empty");
    for (const l of c.links) assert.equal(r(l.url).kind, "case", `${c.id} ${l.url}`);
  }
  const [ra, rb] = [router(model[0], "a"), router(model[0], "b")];
  const mail = (r) => r(PROFILES.a.mailUrl).html;
  assert.ok(mail(ra).includes(PROFILES.a.values.iban) && !mail(ra).includes(PROFILES.b.values.iban));
  assert.ok(rb(PROFILES.b.mailUrl).html.includes(PROFILES.b.values.iban));
  assert.equal(ra(PROFILES.a.bankUrl).kind, "bank");
  assert.equal(ra(PROFILES.a.history[0].url).kind, "history");
  assert.equal(ra("https://unknown.test/favicon.ico").kind, "other");
  console.log("pages self-check ok");
}
