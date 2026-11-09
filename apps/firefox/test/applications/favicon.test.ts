import { expect, test } from "vitest";
import { memeOrigine } from "../../core/applications/favicon";

test("memeOrigine compares origins and refuses unreadable addresses", () => {
  expect(memeOrigine("http://localhost:15280/f.png", "http://localhost:15280/")).toBe(true);
  expect(memeOrigine("http://localhost:15281/f.png", "http://localhost:15280/")).toBe(false);
  expect(memeOrigine("file:///Users/x/photo.png", "http://localhost:15280/")).toBe(false);
  expect(memeOrigine("pas une adresse", "http://localhost:15280/")).toBe(false);
});
