import { describe, it, expect } from "vitest";
import { countNew, elementsDe, identity, notificationText } from "../../src/widgets/nouveautes.js";

describe("nouveautes", () => {
  it("identity by url, otherwise canonical JSON (key order irrelevant)", () => {
    expect(identity({ url: "https://a.example/1", titre: "x" })).toBe(identity({ titre: "autre", url: "https://a.example/1" }));
    expect(identity({ url: "https://a.example/1" })).not.toBe(identity({ url: "https://a.example/2" }));
    expect(identity({ a: 1, b: { c: 2, d: 3 } })).toBe(identity({ b: { d: 3, c: 2 }, a: 1 }));
    expect(identity({ a: 1 })).not.toBe(identity({ a: 2 }));
    // A url that is not text does not count as a url.
    expect(identity({ url: 1, a: 1 })).toBe(identity({ a: 1, url: 1 }));
    expect(identity({ url: 1 })).not.toBe(identity({ url: 2 }));
    expect(identity("texte")).toBe(identity("texte"));
  });

  it("object data { annonces: [...] }: its elements count", () => {
    expect(elementsDe([1, 2])).toEqual([1, 2]);
    expect(elementsDe({ annonces: [{ id: 1 }, { id: 2 }], titre: "x", autres: [{ id: 3 }] })).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(elementsDe(null)).toEqual([]);
    expect(elementsDe("texte")).toEqual([]);
    expect(elementsDe({ titre: "x" })).toEqual([]);
    const before = { annonces: [{ url: "https://a.example/1", prix: 10 }] };
    const after = { annonces: [{ url: "https://a.example/1", prix: 12 }, { url: "https://a.example/2" }, { url: "https://a.example/3" }] };
    expect(countNew(before, after)).toBe(2);
    expect(countNew(null, after)).toBe(3);
    expect(countNew(after, after)).toBe(0);
    // Twice the same element: only one new.
    expect(countNew([], [{ a: 1 }, { a: 1 }])).toBe(1);
  });

  it("texteNotification(1) and (7)", () => {
    expect(notificationText(1)).toBe("1 nouvel élément");
    expect(notificationText(7)).toBe("7 nouveaux éléments");
  });
});
