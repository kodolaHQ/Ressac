import { describe, expect, it } from "vitest";
import { apply } from "../core/state/actions";
import { initialState } from "../core/state/initial-state";
import { URL_RELEASE_NOTES, type BrowserState } from "../shared/model";
import { RELEASE_NOTES } from "../shared/release-notes";

let n = 0;
const genId = () => `id-${++n}`;
const latest = RELEASE_NOTES[0]!.version;
const note = (s: BrowserState, version: string) => apply(s, { type: "noteVersion", version }, genId);
const pages = (s: BrowserState) => Object.values(s.tabs).filter((t) => t.url === URL_RELEASE_NOTES);
const onboarded = (seenVersion: string | null): BrowserState => {
  const s = initialState(genId);
  return { ...s, settings: { ...s.settings, onboarded: true, seenVersion } };
};

describe("release notes at startup", () => {
  it("a first launch records the version and opens nothing", () => {
    const s = note(initialState(genId), latest);
    expect(s.settings.seenVersion).toBe(latest);
    expect(pages(s)).toEqual([]);
  });

  it("after an update (another version, or a session from before the notes) the page opens once, active", () => {
    for (const before of [null, "0.0.1"]) {
      const s = note(onboarded(before), latest);
      const w = s.windows[0]!;
      expect(pages(s).map((t) => t.title)).toEqual(["What's new"]);
      expect(w.active[w.activeSpace]).toBe(pages(s)[0]!.id);
      expect(note(s, latest)).toBe(s);
    }
  });

  it("a version without notes is recorded without a page", () => {
    const s = note(onboarded("0.0.1"), "9.9.9");
    expect(s.settings.seenVersion).toBe("9.9.9");
    expect(pages(s)).toEqual([]);
  });

  it("each version is listed once, with items", () => {
    expect(new Set(RELEASE_NOTES.map((r) => r.version)).size).toBe(RELEASE_NOTES.length);
    for (const r of RELEASE_NOTES) expect(r.items.length).toBeGreaterThan(0);
  });
});
