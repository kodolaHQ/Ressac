import { expect, test } from "vitest";
// @ts-expect-error plain .mjs that runs inside the image, no type declarations
import { parseFeed } from "../../docker/engine/feed.mjs";

test("parseFeed reads RSS and Atom items", () => {
  const rss = `<rss><channel><item><title>Un &amp; deux</title><link>https://a.example/1</link><pubDate>Mon</pubDate><description><![CDATA[<b>résumé</b>]]></description></item>
<item><title>Trois</title><link>https://a.example/3</link></item></channel></rss>`;
  expect(parseFeed(rss)).toEqual([
    { title: "Un & deux", url: "https://a.example/1", date: "Mon", summary: "<b>résumé</b>" },
    { title: "Trois", url: "https://a.example/3", date: "", summary: "" },
  ]);
  const atom = `<feed><entry><title type="html">A</title><link rel="alternate" href="https://b.example/a"/><updated>2026</updated><summary>s</summary></entry></feed>`;
  expect(parseFeed(atom)).toEqual([{ title: "A", url: "https://b.example/a", date: "2026", summary: "s" }]);
});

test("20 000 unclosed items or titles are read in linear time", () => {
  const start = Date.now();
  expect(parseFeed("<rss>" + "<item>x".repeat(20_000) + "<item><title>ok</title></item>")).toMatchObject([{ title: "ok" }]);
  expect(parseFeed("<rss><item>" + "<title>x".repeat(20_000) + "<title>ok</title></item>")).toMatchObject([{ title: "ok" }]);
  // Unclosed opening tags: the attribute scan stops at the next `<`.
  expect(parseFeed("<rss>" + "<item a".repeat(20_000))).toEqual([]);
  expect(parseFeed("<rss><item>" + "<title a".repeat(20_000) + "</item>")).toMatchObject([{ title: "" }]);
  expect(parseFeed("<rss><item>" + "<link a".repeat(20_000) + "</item>")).toMatchObject([{ url: "" }]);
  expect(Date.now() - start).toBeLessThan(500);
});
