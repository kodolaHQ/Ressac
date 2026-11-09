import { expect, test } from "vitest";
import type { BrowserState } from "../shared/model";
import { accumulateParts, readableProfiles, allowedUrl } from "../core/agent/invisible-read";

const state = (profiles: string[], spaces: { profile: string; private: boolean }[]) =>
  ({ profiles: profiles.map((id) => ({ id })), spaces: spaces.map((e, i) => ({ id: `e${i}`, ...e })) }) as unknown as BrowserState;

test("readableProfiles excludes a private space's profiles, even shared with a non-private space", () => {
  const e = state(
    ["defaut", "travail", "secret", "libre"],
    [
      { profile: "defaut", private: false },
      { profile: "travail", private: false },
      { profile: "travail", private: true },
      { profile: "secret", private: true },
    ],
  );
  expect(readableProfiles(e)).toEqual(["defaut", "libre"]);
});

test("urlPermise: http(s) only; with domains, the exact host (trailing dot ignored), like the kernel", () => {
  expect(allowedUrl("https://exemple.test/a", undefined)).toBe(true);
  expect(allowedUrl("javascript:alert(1)", undefined)).toBe(false);
  expect(allowedUrl("pas une url", undefined)).toBe(false);
  expect(allowedUrl("https://exemple.test./a", ["exemple.test"])).toBe(true);
  expect(allowedUrl("https://EXEMPLE.test/a", ["exemple.test."])).toBe(true);
  expect(allowedUrl("https://autre.test/", ["exemple.test"])).toBe(false);
  expect(allowedUrl("https://exemple.test.autre.test/", ["exemple.test"])).toBe(false);
  expect(allowedUrl("https://www.exemple.test/", ["exemple.test"])).toBe(false);
  expect(allowedUrl("data:text/html,x", ["exemple.test"])).toBe(false);
});

test("urlPermise refuses local addresses, except for the tests option", () => {
  for (const u of ["http://localhost./", "http://localhost:11434/api", "http://127.0.0.1:11434/", "http://192.168.1.1/", "http://[::1]/", "http://10.0.0.2/", "http://box.local/"]) {
    expect(allowedUrl(u, undefined), u).toBe(false);
    expect(allowedUrl(u, undefined, true), u).toBe(true);
  }
  expect(allowedUrl("http://127.0.0.1/", ["127.0.0.1"])).toBe(false);
  expect(allowedUrl("http://127.0.0.1/", ["127.0.0.1"], true)).toBe(true);
  expect(allowedUrl("https://exemple.test/", undefined, false)).toBe(true);
});

test("accumulateParts: lines kept once in order of appearance, links by address with the longest text", () => {
  const r = accumulateParts([
    { title: "A", text: "en-tête\nx\n10 €\ny", links: [{ url: "https://e.test/1", text: "court" }] },
    { title: "B", text: "en-tête\nx\n10 €\ny", links: [{ url: "https://e.test/1", text: "plus long" }] },
    { title: "C", text: "en-tête\nz\n10 €\nw", links: [{ url: "https://e.test/2", text: "deux" }, { url: 3 }] },
  ]);
  expect(r.title).toBe("C");
  expect(r.text).toBe("en-tête\nx\n10 €\ny\nz\n10 €\nw");
  expect(r.links).toEqual([
    { url: "https://e.test/1", text: "plus long" },
    { url: "https://e.test/2", text: "deux" },
  ]);
});

test("accumulateParts: a list that advances (virtualized) is realigned on what it shares with the previous snapshot, identical prices kept", () => {
  const r = accumulateParts([
    { title: "T", text: "En-tête\nA1\n4 500 €\nA2\n4 500 €\nChargement…", links: [] },
    // A1 left the page; A2 is still there; A3 and A4 arrive, at the same price.
    { title: "T", text: "En-tête\nA2\n4 500 €\nA3\n4 500 €\nA4\n4 500 €", links: [] },
    // Nothing new: the page no longer moved.
    { title: "T", text: "En-tête\nA2\n4 500 €\nA3\n4 500 €\nA4\n4 500 €", links: [] },
  ]);
  expect(r.text).toBe("En-tête\nA1\n4 500 €\nA2\n4 500 €\nChargement…\nA3\n4 500 €\nA4\n4 500 €");
});
