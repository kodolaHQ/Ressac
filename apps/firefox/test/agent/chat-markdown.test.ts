import { expect, test } from "vitest";
import { renderMarkdown, plainTitle, renderPlain } from "../../ui/components/chat/markdown";
import { shiftRanges } from "../../ui/components/chat/draft";

test("HTML is escaped, never rendered", () => {
  const html = renderMarkdown('<script>alert("x")</script> & <img src=x onerror=1>');
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("&amp;");
});

test("bold, emphasis and inline code", () => {
  expect(renderMarkdown("**a**")).toBe("<p><strong>a</strong></p>");
  expect(renderMarkdown("un *mot* ici")).toBe("<p>un <em>mot</em> ici</p>");
  expect(renderMarkdown("`**x** <b>`")).toBe("<p><code>**x** &lt;b&gt;</code></p>");
});

test("fenced code is kept verbatim and escaped", () => {
  const html = renderMarkdown("avant\n\n```js\nconst a = **b** < 2;\n\n  [x](https://a.fr)\n```\napres");
  expect(html).toContain("<code>const a = **b** &lt; 2;\n\n  [x](https://a.fr)</code>");
  expect(html).not.toContain("<strong>");
  expect(html).not.toContain("<a ");
  expect(html).toContain("<p>avant</p>");
  expect(html).toContain("<p>apres</p>");
});

test("only http(s) links become links", () => {
  expect(renderMarkdown("[m](mailto:a@b.fr)")).not.toContain("<a");
  expect(renderMarkdown("[l](http://localhost:3000)")).toBe('<p><a href="http://localhost:3000" rel="noopener">l</a></p>');
  expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain("<a");
  expect(renderMarkdown("[x](javascript:alert(1))")).toContain("[x](javascript:alert(1))");
  expect(renderMarkdown("[x](https://a.fr)")).toBe('<p><a href="https://a.fr" rel="noopener">x</a></p>');
  expect(renderMarkdown('[x](https://a.fr/"onmouseover=1)')).not.toMatch(/href="[^"]*"onmouseover/);
});

test("lists and paragraphs", () => {
  expect(renderMarkdown("- un\n- deux\n\n1. a\n2. b")).toBe("<ul><li>un</li><li>deux</li></ul><ol><li>a</li><li>b</li></ol>");
  expect(renderMarkdown("ligne 1\nligne 2\n\nautre")).toBe("<p>ligne 1<br>ligne 2</p><p>autre</p>");
});

test("labels become chips, outside code only", () => {
  const chip = (label: string, type: string) => `<chip ${type}>`;
  expect(renderMarkdown("nom ⟨nom-abcdefgh⟩ ici", chip)).toContain("nom <chip nom> ici");
  expect(renderMarkdown("`⟨nom-abcdefgh⟩`", chip)).not.toContain("<chip");
  expect(renderPlain("<b>⟨iban-abcdefgh⟩</b>", chip)).toBe("&lt;b&gt;<chip iban>&lt;/b&gt;");
});

test("pasted ranges follow the edits around them", () => {
  // Typed before the paste: it moves right.
  expect(shiftRanges([[2, 5]], "abXYZ", "1abXYZ")).toEqual([[3, 6]]);
  // Typed after it: unchanged.
  expect(shiftRanges([[2, 5]], "abXYZ", "abXYZ!")).toEqual([[2, 5]]);
  // An edit inside it keeps the whole run pasted (the safe side).
  expect(shiftRanges([[2, 5]], "abXYZ", "abX1YZ")).toEqual([[2, 6]]);
  // Deleted entirely: gone.
  expect(shiftRanges([[2, 5]], "abXYZ", "ab")).toEqual([]);
});

test("a title shows its labels as their kind's words, never a token, and drops one the title cut", () => {
  const name = (type: string) => `${type} masqué`;
  expect(plainTitle("Mon adresse est ⟨email-wr4urdzq⟩@exemple", name)).toBe("Mon adresse est email masqué@exemple");
  expect(plainTitle("Répète exactement ce numéro : ⟨tel-ni212", name)).toBe("Répète exactement ce numéro :");
  expect(plainTitle("Appelle ⟨", name)).toBe("Appelle");
  expect(plainTitle("Bonjour", name)).toBe("Bonjour");
});
