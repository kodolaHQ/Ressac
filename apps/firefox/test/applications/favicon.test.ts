import { expect, test } from "vitest";
import { sameOrigin } from "../../core/applications/favicon";

test("sameOrigin compares origins and refuses unreadable addresses", () => {
  expect(sameOrigin("http://localhost:15280/f.png", "http://localhost:15280/")).toBe(true);
  expect(sameOrigin("http://localhost:15281/f.png", "http://localhost:15280/")).toBe(false);
  expect(sameOrigin("file:///Users/x/photo.png", "http://localhost:15280/")).toBe(false);
  expect(sameOrigin("pas une adresse", "http://localhost:15280/")).toBe(false);
});
