import { expect, it } from "vitest";
import { agentPageDecision } from "../chrome/agent/page-guard";

const ports: [number, number] = [5300, 5319];
const req = (o: Partial<Parameters<typeof agentPageDecision>[0]>) =>
  agentPageDecision({ from: "http://localhost:5301/", to: "https://evil.example/?d=x", document: false, gesture: false, method: "GET", ...o }, ports);

it("an agent page's image to the web is cancelled", () => {
  expect(req({})).toBe("cancel");
});

it("local addresses stay reachable", () => {
  expect(req({ to: "http://localhost:5302/a.js" })).toBe("allow");
  expect(req({ to: "http://127.0.0.1:9999/x" })).toBe("allow");
});

it("known CDNs are reachable with GET only", () => {
  expect(req({ to: "https://fonts.gstatic.com/s/inter.woff2" })).toBe("allow");
  expect(req({ to: "https://fonts.gstatic.com/s/inter.woff2", method: "POST" })).toBe("cancel");
});

it("a local page outside the agent's ports is not guarded", () => {
  expect(req({ from: "http://localhost:8080/" })).toBe("allow");
  expect(req({ from: "http://localhost/" })).toBe("allow");
});

it("a top-level navigation leaves only on a user gesture", () => {
  expect(req({ document: true, to: "https://example.com/" })).toBe("cancel");
  expect(req({ document: true, gesture: true, to: "https://example.com/" })).toBe("allow");
});

it("only agent pages are guarded", () => {
  expect(req({ from: "https://example.com/" })).toBe("allow");
  expect(req({ from: "" })).toBe("allow");
});
