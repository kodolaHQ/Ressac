import { describe, it, expect } from "vitest";
import { countNew, elementsOf, identity, notificationText } from "../../src/widgets/novelties.js";

describe("novelties", () => {
  it("identity by url, otherwise canonical JSON (key order irrelevant)", () => {
    expect(identity({ url: "https://a.example/1", title: "x" })).toBe(identity({ title: "autre", url: "https://a.example/1" }));
    expect(identity({ url: "https://a.example/1" })).not.toBe(identity({ url: "https://a.example/2" }));
    expect(identity({ a: 1, b: { c: 2, d: 3 } })).toBe(identity({ b: { d: 3, c: 2 }, a: 1 }));
    expect(identity({ a: 1 })).not.toBe(identity({ a: 2 }));
    // A url that is not text does not count as a url.
    expect(identity({ url: 1, a: 1 })).toBe(identity({ a: 1, url: 1 }));
    expect(identity({ url: 1 })).not.toBe(identity({ url: 2 }));
    expect(identity("texte")).toBe(identity("texte"));
  });

  it("object data { annonces: [...] }: its elements count", () => {
    expect(elementsOf([1, 2])).toEqual([1, 2]);
    expect(elementsOf({ announcements: [{ id: 1 }, { id: 2 }], title: "x", others: [{ id: 3 }] })).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(elementsOf(null)).toEqual([]);
    expect(elementsOf("texte")).toEqual([]);
    expect(elementsOf({ title: "x" })).toEqual([]);
    const before = { announcements: [{ url: "https://a.example/1", price: 10 }] };
    const after = { announcements: [{ url: "https://a.example/1", price: 12 }, { url: "https://a.example/2" }, { url: "https://a.example/3" }] };
    expect(countNew(before, after)).toBe(2);
    expect(countNew(null, after)).toBe(3);
    expect(countNew(after, after)).toBe(0);
    // Twice the same element: only one new.
    expect(countNew([], [{ a: 1 }, { a: 1 }])).toBe(1);
  });

  it("texteNotification(1) and (7)", () => {
    expect(notificationText(1, "fr")).toBe("1 nouvel élément");
    expect(notificationText(1, "en")).toBe("1 new item");
    expect(notificationText(7, "fr")).toBe("7 nouveaux éléments");
    expect(notificationText(7, "en")).toBe("7 new items");
  });
});
