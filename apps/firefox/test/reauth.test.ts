import { afterEach, expect, it, vi } from "vitest";
import { reauth } from "../chrome/agent/reauth";

const g = globalThis as { Services?: unknown; ChromeUtils?: unknown; __RESSAC_PACKAGED__?: boolean };
afterEach(() => {
  delete g.Services;
  delete g.ChromeUtils;
  delete g.__RESSAC_PACKAGED__;
});

/** A packaged build (no test seam) over a fake OSKeyStore. */
function keystore(o: { busy?: boolean; result?: unknown; throws?: boolean }) {
  g.Services = { env: { get: () => "pass" } };
  g.__RESSAC_PACKAGED__ = true;
  const ensureLoggedIn = vi.fn(async () => {
    if (o.throws) throw new Error("NS_ERROR_FAILURE");
    return o.result;
  });
  g.ChromeUtils = { importESModule: () => ({ OSKeyStore: { isUIBusy: o.busy === true, ensureLoggedIn } }) };
  return ensureLoggedIn;
}

it("a real success is a yes: the reason on the prompt, Ressac as its caption, no key generated", async () => {
  const ensure = keystore({ result: { authenticated: true, auth_details: "success" } });
  expect(await reauth("montrer votre code à l'agent")).toBe(true);
  expect(ensure).toHaveBeenCalledWith("montrer votre code à l'agent", "Ressac", null, false);
});

it("a cancel, an error, another prompt pending or a platform without prompt are a no", async () => {
  expect(await reauth("r")).toBe(false); // no ChromeUtils at all
  keystore({ result: { authenticated: false, auth_details: "fail" } });
  expect(await reauth("r")).toBe(false);
  keystore({ throws: true });
  expect(await reauth("r")).toBe(false);
  const ensure = keystore({ busy: true, result: { authenticated: true } });
  expect(await reauth("r")).toBe(false);
  expect(ensure).not.toHaveBeenCalled();
  keystore({ result: { authenticated: true, auth_details: "success_unsupported_platform" } });
  expect(await reauth("r")).toBe(false);
  keystore({ result: undefined });
  expect(await reauth("r")).toBe(false);
});

it("the e2e seam (dev builds only): pass is a yes, anything else a no, and OSKeyStore is never asked", async () => {
  const ensure = keystore({ result: { authenticated: true } });
  g.__RESSAC_PACKAGED__ = false;
  expect(await reauth("r")).toBe(true);
  g.Services = { env: { get: (n: string) => (n === "RESSAC_TEST_REAUTH" ? "fail" : "") } };
  expect(await reauth("r")).toBe(false);
  expect(ensure).not.toHaveBeenCalled();
});
