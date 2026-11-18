import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitFor, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";

// 0.1.14, small Macs: macOS memory pressure reaches the host (the models unload, the machine stops unless in use).
// The real path (`sudo memory_pressure`) needs a person; here Gecko's own topic is fired from chrome.

let w: LaunchedRessac;
let m: Marionette;
const calls = () => {
  const file = join(w.dataDir, "workspace", "fake-machine-calls.log");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l === "relieve") : [];
};
const press = (data: string) => m.execute(`Services.obs.notifyObservers(null, "memory-pressure", arguments[0]);`, [data]);

beforeAll(async () => {
  w = await launchRessac({ env: { RESSAC_TEST_MACHINE: "running", RESSAC_D1_URL: "http://127.0.0.1:9", RESSAC_EMBED_URL: "http://127.0.0.1:9" } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
});
afterAll(async () => {
  await w?.close();
});

describe("memory pressure", () => {
  it("Firefox answers macOS pressure from « warn », unloading background tabs first (release builds answer nothing by default)", async () => {
    expect(await m.execute(`return [Services.prefs.getIntPref("browser.lowMemoryResponseMask"), Services.prefs.getBoolPref("browser.lowMemoryResponseOnWarn")];`)).toEqual([3, true]);
  });

  it("each new pressure asks the host to relieve the machine, the ongoing repeats do not", async () => {
    await press("low-memory");
    await waitFor(m, "return true", () => calls().length === 1, 10_000);
    await press("low-memory-ongoing");
    await press("low-memory-ongoing");
    await press("heap-minimize");
    await waitFor(m, "return true", () => calls().length === 2, 10_000);
    await new Promise((r) => setTimeout(r, 500));
    expect(calls()).toHaveLength(2);
  });
});
