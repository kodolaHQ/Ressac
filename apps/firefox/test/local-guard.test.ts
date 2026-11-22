import { afterEach, expect, it, vi } from "vitest";
import { isLocalHost, localLiteral } from "../chrome/agent/local-guard";

const resolver = (addresses: string[]) => vi.fn(async (_h: string) => addresses);
afterEach(() => (vi.unstubAllEnvs(), vi.unstubAllGlobals()));

it("public name resolving to ::1 is local", async () => {
  expect(await isLocalHost("localtest.me", resolver(["93.184.216.34", "::1"]))).toBe(true);
});

it("public name resolving to 93.184.216.34 is not", async () => {
  expect(await isLocalHost("example.com", resolver(["93.184.216.34"]))).toBe(false);
});

it("literal 127.0.0.1, [::1], localhost., box.local are local without resolving", async () => {
  const resolve = resolver([]);
  for (const h of ["127.0.0.1", "[::1]", "localhost.", "box.local"]) expect(await isLocalHost(h, resolve)).toBe(true);
  expect(resolve).not.toHaveBeenCalled();
});

it("RESSAC_TEST_PUBLIC_ADDRESSES makes 127.0.0.1 public", async () => {
  vi.stubEnv("RESSAC_TEST_PUBLIC_ADDRESSES", "10.0.0.1,127.0.0.1");
  expect(await isLocalHost("127.0.0.1", resolver([]))).toBe(false);
  expect(await isLocalHost("page.test", resolver(["127.0.0.1"]))).toBe(false);
  expect(await isLocalHost("localtest.me", resolver(["::1"]))).toBe(true);
});

it("a failed or empty resolution is refused (fail closed)", async () => {
  expect(await isLocalHost("down.example", vi.fn(async () => Promise.reject(new Error("NXDOMAIN"))))).toBe(true);
  expect(await isLocalHost("empty.example", resolver([]))).toBe(true);
});

it("in Firefox, RESSAC_TEST_PUBLIC_ADDRESSES is honoured under automation only", () => {
  let automation = false;
  vi.stubGlobal("__RESSAC_PACKAGED__", false);
  vi.stubGlobal("Services", { env: { get: (n: string) => (n === "RESSAC_TEST_PUBLIC_ADDRESSES" ? "127.0.0.1" : "") } });
  vi.stubGlobal("Cu", { get isInAutomation() { return automation; } });
  vi.stubGlobal("Ci", { nsIMarionette: {} });
  vi.stubGlobal("Cc", { "@mozilla.org/remote/marionette;1": { getService: () => ({ running: false }) } });
  expect(localLiteral("127.0.0.1")).toBe(true);
  automation = true;
  expect(localLiteral("127.0.0.1")).toBe(false);
});
