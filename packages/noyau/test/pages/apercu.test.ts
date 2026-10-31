import { describe, expect, it } from "vitest";
import { APERCU_MAX, apercuResultats, resultatsVides } from "../../src/pages/apercu.js";

const ticket = (i: number) => ({ titre: `Ticket ${i} ` + "x".repeat(200), priorite: "haute", url: `https://gitlab.com/t/${i}` });

describe("apercuResultats", () => {
  it("décrit la forme d'une liste d'objets et garde 3 exemples", () => {
    const a = JSON.parse(apercuResultats({ tickets: Array.from({ length: 23 }, (_, i) => ticket(i)) }));
    expect(a.forme.tickets).toBe("liste (23) d'objets { titre: texte, priorite: texte, url: texte }");
    expect(a.exemples.tickets).toHaveLength(3);
    expect(a.exemples.tickets[0].titre.length).toBeLessThanOrEqual(121);
  });

  it("2 Mo de résultats : aperçu ≤ 6 000 caractères, la forme de tickets reste", () => {
    const gros = { tickets: Array.from({ length: 10_000 }, (_, i) => ticket(i)), texte: "y".repeat(2_000_000) };
    const s = apercuResultats(gros);
    expect(s.length).toBeLessThanOrEqual(APERCU_MAX);
    expect(JSON.parse(s).forme.tickets).toContain("liste (10000) d'objets");
  });

  it("un texte de 100 000 caractères est coupé à 120", () => {
    const a = JSON.parse(apercuResultats({ page: "z".repeat(100_000) }));
    expect(a.exemples.page.length).toBeLessThanOrEqual(121);
    expect(a.exemples.page.startsWith("zzz")).toBe(true);
  });

  it("30 niveaux d'imbrication : borné, sans erreur", () => {
    let v: unknown = "fond";
    for (let i = 0; i < 30; i++) v = { a: v };
    const s = apercuResultats(v);
    expect(s.length).toBeLessThanOrEqual(APERCU_MAX);
    expect(() => JSON.parse(s)).not.toThrow();
  });

  it("des centaines de clés larges restent bornées, et __proto__ est une clé comme une autre", () => {
    const large: Record<string, unknown> = JSON.parse('{"__proto__": {"x": 1}}');
    for (let i = 0; i < 500; i++) large["cle" + i + "é".repeat(50)] = { n: i, liste: [1, 2, 3, 4] };
    const s = apercuResultats(large);
    expect(s.length).toBeLessThanOrEqual(APERCU_MAX);
    expect(() => JSON.parse(s)).not.toThrow();
  });
});

describe("resultatsVides", () => {
  it("null, texte vide, [], {}, objets de vides : vrais ; { total: 0 } faux", () => {
    expect(resultatsVides(null)).toBe(true);
    expect(resultatsVides("")).toBe(true);
    expect(resultatsVides([])).toBe(true);
    expect(resultatsVides({})).toBe(true);
    expect(resultatsVides({ tickets: [], a: { b: "" } })).toBe(true);
    expect(resultatsVides({ total: 0 })).toBe(false);
    expect(resultatsVides({ a: [1] })).toBe(false);
  });
});
