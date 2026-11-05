import { expect, it } from "vitest";
import { pacedTarget } from "../chrome/agent/paced";

it("gives the host of a document on another site", () => {
  expect(pacedTarget("http://a.test/x", "http://b.test/y")).toBe("b.test");
});

it("is null for the same site or an unreadable address", () => {
  expect(pacedTarget("http://www.a.test/", "http://a.test/z")).toBeNull();
  expect(pacedTarget("http://A.test./", "http://a.test/")).toBeNull();
  expect(pacedTarget("http://a.test/", "pas une url")).toBeNull();
});
