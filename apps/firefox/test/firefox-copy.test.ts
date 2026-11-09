import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GECKO_ID, VERSION_FOUR } from "../host/extensions/amo";
import { firefoxManifest, nextVersion, firefoxDenial } from "../host/extensions/firefox-copy";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("Firefox copy", () => {
  it("manifest: gecko id, background scripts, counted version", () => {
    const classic = firefoxManifest({ version: "1.2", background: { service_worker: "webaios-fond.js" } }, "ma-ext", 7, "./fond.js");
    expect(classic.background).toEqual({ scripts: ["webaios-garde-fond.js", "fond.js"] });
    expect(classic.version).toBe("1.2.0.7");
    expect(classic.browser_specific_settings).toEqual({ gecko: { id: "ma-ext@agent.webaios", data_collection_permissions: { required: ["none"] } } });
    expect(firefoxManifest({ version: "1.2", background: { service_worker: "webaios-fond.js", type: "module" } }, "ma-ext", 1, undefined).background).toEqual({ scripts: ["webaios-fond.js"], type: "module" });
    expect(firefoxManifest({ version: "1", background: { service_worker: "webaios-fond.js" } }, "ma-ext", 1, undefined).background).toEqual({ scripts: ["webaios-garde-fond.js"] });
    // Pages sandboxed without allow-popups: document.open(url, "_blank") and <a target=_blank> open nothing.
    const csp = firefoxManifest({ version: "1", content_security_policy: { extension_pages: "default-src 'self'" } }, "ma-ext", 1, undefined).content_security_policy;
    expect(csp).toEqual({ extension_pages: "default-src 'self'; sandbox allow-scripts allow-same-origin allow-forms allow-modals" });
    // No string CSP: the sandbox is set all the same.
    expect(firefoxManifest({ version: "1" }, "ma-ext", 1, undefined).content_security_policy).toEqual({ extension_pages: "script-src 'self'; sandbox allow-scripts allow-same-origin allow-forms allow-modals" });
  });

  it("refusals: gecko id written by the agent, four-part version, generated page name", () => {
    expect(firefoxDenial({ browser_specific_settings: { gecko: { id: "x@y" } } }, [])).toEqual([GECKO_ID]);
    expect(firefoxDenial({ version: "1.2.3.4" }, [])).toEqual([VERSION_FOUR]);
    expect(firefoxDenial({ version: "1.2.3" }, ["_generated_background_page.html"])).toHaveLength(1);
    expect(firefoxDenial({ version: "1.2.3" }, ["fond.js"])).toEqual([]);
  });

  it("refusals: a right agent extensions cannot use, or a manifest key that grants a power", () => {
    const right = (n: string) => `Droit non pris en charge par WebAiOs : ${n}`;
    const allowed = ["scripting", "storage", "unlimitedStorage", "tabs", "contextMenus", "cookies", "webNavigation", "alarms", "offscreen", "clipboardRead", "clipboardWrite", "declarativeNetRequest", "declarativeNetRequestWithHostAccess", "declarativeNetRequestFeedback"];
    expect(firefoxDenial({ version: "1", permissions: allowed }, [])).toEqual([]);
    expect(firefoxDenial({ version: "1", permissions: ["storage", "identity", "notifications", "dns", "find", "activeTab", "https://x.test/*"] }, [])).toEqual(
      ["identity", "notifications", "dns", "find", "activeTab", "https://x.test/*"].map(right),
    );
    expect(firefoxDenial({ version: "1", optional_permissions: ["menus"] }, [])).toEqual([right("menus")]);
    expect(firefoxDenial({ version: "1", chrome_settings_overrides: {}, protocol_handlers: [], user_scripts: {} }, [])).toEqual(
      ["chrome_settings_overrides", "protocol_handlers", "user_scripts"].map(right),
    );
  });

  it("version counter: increases per id, survives, never lowered", async () => {
    const d = mkdtempSync(join(tmpdir(), "webaios-amo-versions-"));
    dirs.push(d);
    expect(await nextVersion(d, "a")).toBe(1);
    expect(await nextVersion(d, "a")).toBe(2);
    expect(await nextVersion(d, "b")).toBe(1);
    expect(await nextVersion(d, "a")).toBe(3);
  });
});
