import { expect, it } from "vitest";
import { agentPageDecision, agentPortRange } from "../chrome/agent/page-guard";

const ports: [number, number] = [5300, 5319];
const req = (o: Partial<Parameters<typeof agentPageDecision>[0]>) =>
  agentPageDecision({ from: "http://localhost:5301/", to: "https://evil.example/?d=x", document: false, gesture: false, method: "GET", ...o }, ports);

it("an agent page's image to the web is cancelled", () => {
  expect(req({})).toBe("cancel");
});

it("the agent's own ports on the loopback stay reachable", () => {
  expect(req({ to: "http://localhost:5302/a.js" })).toBe("allow");
  expect(req({ to: "http://127.0.0.1:5319/x", method: "POST" })).toBe("allow");
  expect(req({ to: "http://[::1]:5300/x" })).toBe("allow");
});

it("other local services are not: Ollama, a dev server, the LAN", () => {
  expect(req({ to: "http://127.0.0.1:9999/x" })).toBe("cancel");
  expect(req({ to: "http://localhost:11434/api/pull", method: "POST" })).toBe("cancel");
  expect(req({ to: "http://192.168.1.1:5301/admin" })).toBe("cancel");
});

it("an IPv4-mapped or NAT64 IPv6 address is any IPv4 host, never local", () => {
  expect(req({ to: "http://[::ffff:8.8.8.8]/", method: "POST" })).toBe("cancel");
  expect(req({ to: "http://[::ffff:8.8.8.8]:5301/", method: "POST" })).toBe("cancel");
  expect(req({ to: "http://[64:ff9b::808:808]:5301/", method: "POST" })).toBe("cancel");
});

it("a bad RESSAC_CONTAINER_PORTS gives the kernel's range, unset the host's default", () => {
  expect(agentPortRange("5400-5300")).toEqual([5280, 5299]);
  expect(agentPortRange("")).toEqual([5300, 5319]);
  expect(agentPortRange("5340-5359")).toEqual([5340, 5359]);
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

it("an agent port under a public name is an agent page too", () => {
  expect(req({ from: "http://127.0.0.1.nip.io:5301/" })).toBe("cancel");
  expect(req({ from: "http://localtest.me:5301/" })).toBe("cancel");
});
