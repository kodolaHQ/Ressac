import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GECKO_ID, VERSION_QUATRE } from "../noyau/extensions/amo";
import { manifesteFirefox, prochaineVersion, refusFirefox } from "../noyau/extensions/copie-firefox";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("Firefox copy", () => {
  it("manifest: gecko id, background scripts, counted version", () => {
    const classique = manifesteFirefox({ version: "1.2", background: { service_worker: "webaios-fond.js" } }, "ma-ext", 7, "./fond.js");
    expect(classique.background).toEqual({ scripts: ["webaios-garde-fond.js", "fond.js"] });
    expect(classique.version).toBe("1.2.0.7");
    expect(classique.browser_specific_settings).toEqual({ gecko: { id: "ma-ext@agent.webaios", data_collection_permissions: { required: ["none"] } } });
    expect(manifesteFirefox({ version: "1.2", background: { service_worker: "webaios-fond.js", type: "module" } }, "ma-ext", 1, undefined).background).toEqual({ scripts: ["webaios-fond.js"], type: "module" });
    expect(manifesteFirefox({ version: "1", background: { service_worker: "webaios-fond.js" } }, "ma-ext", 1, undefined).background).toEqual({ scripts: ["webaios-garde-fond.js"] });
    // Pages sandboxed without allow-popups: document.open(url, "_blank") and <a target=_blank> open nothing.
    const csp = manifesteFirefox({ version: "1", content_security_policy: { extension_pages: "default-src 'self'" } }, "ma-ext", 1, undefined).content_security_policy;
    expect(csp).toEqual({ extension_pages: "default-src 'self'; sandbox allow-scripts allow-same-origin allow-forms allow-modals" });
    // No string CSP: the sandbox is set all the same.
    expect(manifesteFirefox({ version: "1" }, "ma-ext", 1, undefined).content_security_policy).toEqual({ extension_pages: "script-src 'self'; sandbox allow-scripts allow-same-origin allow-forms allow-modals" });
  });

  it("refusals: gecko id written by the agent, four-part version, generated page name", () => {
    expect(refusFirefox({ browser_specific_settings: { gecko: { id: "x@y" } } }, [])).toEqual([GECKO_ID]);
    expect(refusFirefox({ version: "1.2.3.4" }, [])).toEqual([VERSION_QUATRE]);
    expect(refusFirefox({ version: "1.2.3" }, ["_generated_background_page.html"])).toHaveLength(1);
    expect(refusFirefox({ version: "1.2.3" }, ["fond.js"])).toEqual([]);
  });

  it("refusals: a right agent extensions cannot use, or a manifest key that grants a power", () => {
    const droit = (n: string) => `Droit non pris en charge par WebAiOs : ${n}`;
    const permis = ["scripting", "storage", "unlimitedStorage", "tabs", "contextMenus", "cookies", "webNavigation", "alarms", "offscreen", "clipboardRead", "clipboardWrite", "declarativeNetRequest", "declarativeNetRequestWithHostAccess", "declarativeNetRequestFeedback"];
    expect(refusFirefox({ version: "1", permissions: permis }, [])).toEqual([]);
    expect(refusFirefox({ version: "1", permissions: ["storage", "identity", "notifications", "dns", "find", "activeTab", "https://x.test/*"] }, [])).toEqual(
      ["identity", "notifications", "dns", "find", "activeTab", "https://x.test/*"].map(droit),
    );
    expect(refusFirefox({ version: "1", optional_permissions: ["menus"] }, [])).toEqual([droit("menus")]);
    expect(refusFirefox({ version: "1", chrome_settings_overrides: {}, protocol_handlers: [], user_scripts: {} }, [])).toEqual(
      ["chrome_settings_overrides", "protocol_handlers", "user_scripts"].map(droit),
    );
  });

  it("version counter: increases per id, survives, never lowered", async () => {
    const d = mkdtempSync(join(tmpdir(), "webaios-amo-versions-"));
    dirs.push(d);
    expect(await prochaineVersion(d, "a")).toBe(1);
    expect(await prochaineVersion(d, "a")).toBe(2);
    expect(await prochaineVersion(d, "b")).toBe(1);
    expect(await prochaineVersion(d, "a")).toBe(3);
  });
});
