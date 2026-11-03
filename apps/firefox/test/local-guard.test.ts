import { afterEach, expect, it, vi } from "vitest";
import { isLocalHost } from "../chrome/agent/local-guard";

const resolver = (addresses: string[]) => vi.fn(async (_h: string) => addresses);
afterEach(() => vi.unstubAllEnvs());

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

it("WEBAIOS_TEST_ADRESSES_PUBLIQUES makes 127.0.0.1 public", async () => {
  vi.stubEnv("WEBAIOS_TEST_ADRESSES_PUBLIQUES", "10.0.0.1,127.0.0.1");
  expect(await isLocalHost("127.0.0.1", resolver([]))).toBe(false);
  expect(await isLocalHost("page.test", resolver(["127.0.0.1"]))).toBe(false);
  expect(await isLocalHost("localtest.me", resolver(["::1"]))).toBe(true);
});
