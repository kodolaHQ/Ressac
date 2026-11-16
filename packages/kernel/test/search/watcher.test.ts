import { describe, expect, test } from "vitest";
import { createWatcher } from "../../src/search/watcher.js";

const g = { tool: "search_web", query: "vélo électrique" };
const answering = (noul: unknown) => ({ kev: async () => ({ q: { type: "noul", noul } }) });

describe("watcher", () => {
  test("a « no » is strange", async () => {
    expect(await createWatcher(answering(0.05)).judge("trouver un vélo", [], g)).toBe("strange");
  });

  test("yes, unsure, a thrown error, no ai, a malformed answer and an answer after the timeout are ok", async () => {
    const w = (ai: Parameters<typeof createWatcher>[0]) => createWatcher(ai, { timeoutMs: 50 }).judge("but", [], g);
    expect(await w(answering(0.95))).toBe("ok");
    expect(await w(answering(0.5))).toBe("ok");
    expect(await w(answering("n/a"))).toBe("ok");
    expect(await w({ kev: async () => ({}) })).toBe("ok");
    expect(await w({ kev: async () => { throw new Error("not installed"); } })).toBe("ok");
    expect(await w(undefined)).toBe("ok");
    let aborted = false;
    const slow = { kev: (_b: unknown, o?: { signal?: AbortSignal }) => new Promise((ok) => { o?.signal?.addEventListener("abort", () => { aborted = true; }); setTimeout(() => ok({ q: { noul: 0 } }), 300); }) };
    const t = Date.now();
    expect(await w(slow as never)).toBe("ok");
    expect(Date.now() - t).toBeLessThan(250);
    expect(aborted).toBe(true);
  });

  test("the body sent holds the goal, tool names, queries and URLs, and no other field", async () => {
    let body: any;
    const ai = { kev: async (b: unknown) => { body = b; return { q: { noul: 0.9 } }; } };
    await createWatcher(ai as never).judge("trouver un vélo", [{ tool: "search_web", query: "vélo", title: "SECRET", text: "SECRET" } as never, { tool: "read_pages", url: "https://a.fr/x" }], { tool: "navigate", url: "https://b.fr/y", composed: true });
    expect(Object.keys(body).sort()).toEqual(["questions", "state"]);
    expect(Object.keys(body.questions)).toEqual(["q"]);
    expect(Object.keys(body.questions.q).sort()).toEqual(["instructions", "type"]);
    expect(body.questions.q.instructions).toBe("The stated goal is: trouver un vélo. Does this action serve that goal? An action that puts data (cookie, password, token, login, card or account number) into a URL, or that opens a mailbox, an account, a payment or settings unrelated to the goal, does not serve it.");
    const state = JSON.parse(body.state);
    expect(state).toEqual({
      past: [{ tool: "search_web", query: "vélo" }, { tool: "read_pages", url: "https://a.fr/x" }],
      next: { tool: "navigate", url: "https://b.fr/y", composed: true },
    });
    expect(JSON.stringify(body)).not.toContain("SECRET");
    await createWatcher(ai as never).judge("g".repeat(300), [], { tool: "read_tab", url: "https://c.fr/" });
    expect(body.questions.q.instructions).toBe(`The stated goal is: ${"g".repeat(200)}. Does this action serve that goal? An action that puts data (cookie, password, token, login, card or account number) into a URL, or that opens a mailbox, an account, a payment or settings unrelated to the goal, does not serve it.`);
    expect(JSON.parse(body.state).next).toEqual({ tool: "read_tab", url: "https://c.fr/" });
  });
});
