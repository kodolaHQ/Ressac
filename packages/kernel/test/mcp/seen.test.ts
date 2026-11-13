import { expect, test } from "vitest";
import { SeenUrls, SEEN_MAX } from "../../src/mcp/seen.js";

test("a DuckDuckGo redirect makes its target seen", () => {
  const s = new SeenUrls();
  s.add(["https://duckduckgo.com/l/?uddg=https%3A%2F%2Fcible.fr%2Fp%3Fx%3D1"]);
  expect(s.has("https://cible.fr/p?x=1")).toBe(true);
});

test("a fragment is dropped when added, never when checked", () => {
  const s = new SeenUrls();
  s.add(["https://a.fr/p#x"]);
  expect(s.has("https://a.fr/p#x")).toBe(true);
  expect(s.has("https://a.fr/p")).toBe(true);
  const t = new SeenUrls();
  t.add(["https://a.fr/p"]);
  expect(t.has("https://a.fr/p#données")).toBe(false);
});

test("only http(s) addresses of at most 4096 characters", () => {
  const s = new SeenUrls();
  s.add(["javascript:alert(1)", "data:text/html,x", `https://a.fr/${"x".repeat(4096)}`]);
  expect(s.has("javascript:alert(1)")).toBe(false);
  expect(s.has("data:text/html,x")).toBe(false);
  expect(s.has(`https://a.fr/${"x".repeat(4096)}`)).toBe(false);
});

test("beyond the limit the oldest goes, unless has touched it", () => {
  const s = new SeenUrls();
  s.add(["https://a.fr/0", "https://a.fr/1"]);
  s.add(Array.from({ length: SEEN_MAX - 2 }, (_, i) => `https://b.fr/${i}`));
  expect(s.has("https://a.fr/0")).toBe(true);
  s.add(["https://c.fr/new"]);
  expect(s.has("https://a.fr/1")).toBe(false);
  expect(s.has("https://a.fr/0")).toBe(true);
  expect(s.has("https://c.fr/new")).toBe(true);
});
