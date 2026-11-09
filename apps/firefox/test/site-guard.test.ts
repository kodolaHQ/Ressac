import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { blockedNotice, NOTICE_GAP_MS } from "../chrome/store/site-guard";

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

const pub = "http://pub.localhost/x";
const other = "http://autre-pub.localhost/x";

function watched() {
  const sent: (string | null)[] = [];
  const n = blockedNotice(() => sent.push(n.notice?.kind === "link-blocked" ? n.notice.domain : null));
  return { n, sent };
}

it("twenty alternated blocks over 1.2 s: at most 3 broadcasts, the last one pub.localhost", () => {
  const { n, sent } = watched();
  for (let i = 0; i < 20; i++) {
    n.block(i % 2 ? pub : other);
    vi.advanceTimersByTime(50);
  }
  vi.advanceTimersByTime(1200 - 20 * 50);
  vi.advanceTimersByTime(NOTICE_GAP_MS);
  expect(sent.length).toBeGreaterThanOrEqual(1);
  expect(sent.length).toBeLessThanOrEqual(3);
  expect(sent.at(-1)).toBe("pub.localhost");
  expect(n.notice).toEqual({ kind: "link-blocked", domain: "pub.localhost" });
});

it("one mention per domain; the last URL is kept for « Ouvrir dans un onglet »", () => {
  const { n, sent } = watched();
  n.block(pub);
  n.block("http://pub.localhost/y");
  vi.advanceTimersByTime(2000);
  expect(sent).toEqual(["pub.localhost"]);
  expect(n.take()).toBe("http://pub.localhost/y");
  expect(n.notice).toBeNull();
  expect(n.take()).toBeNull();
});

it("about:blank and javascript: are refused without a mention", () => {
  const { n, sent } = watched();
  for (const u of ["about:blank", "javascript:alert(1)", "", "pas une adresse"]) n.block(u);
  vi.advanceTimersByTime(2000);
  expect(sent).toEqual([]);
  expect(n.notice).toBeNull();
  expect(n.take()).toBeNull();
});

it("a new page clears the mention and the URL; the next block is shown again", () => {
  const { n, sent } = watched();
  n.block(pub);
  n.clear();
  expect(n.notice).toBeNull();
  expect(n.take()).toBeNull();
  vi.advanceTimersByTime(NOTICE_GAP_MS);
  n.block(pub);
  expect(sent).toEqual(["pub.localhost", "pub.localhost"]);
});
