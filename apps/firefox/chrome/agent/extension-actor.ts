// Extension actor: on the agent's extension pages (background, popup, options), a frozen window.__webaios asks the
// parent, which reads the add-on id from the document's principal (never from the page) and answers from the grants.
// Kept small: the build copies this file, so any change here needs a rebuild of the app (build:ui).
import type { WebAiOsStore } from "../store";
import type { CheckKind } from "../store/agent-extensions";

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
// Keep in sync with noyau/extensions/copie-firefox.ts SUFFIXE_ID.
const SUFFIX = "@agent.webaios";
const KINDS: readonly string[] = ["urlPermise", "hotePermis", "estOnglet"] satisfies CheckKind[];

export class WebAiOsExtensionParent extends JSWindowActorParent {
  async receiveMessage(m: { name: string; data?: unknown }): Promise<boolean> {
    if (!KINDS.includes(m.name)) return false;
    const addonId: string = this.manager.documentPrincipal.addonId;
    const { agentExtensions } = (await ChromeUtils.importESModule(STORE).ready) as WebAiOsStore;
    await agentExtensions.scopesKnown;
    return agentExtensions.check(addonId, m.name as CheckKind, m.data);
  }
}

export class WebAiOsExtensionChild extends JSWindowActorChild {
  // DOMWindowCreated: before the page's first script (spike S5).
  handleEvent() {
    const win = this.contentWindow as any;
    // Any page of an add-on with the agent's suffix; the parent answers false for one it did not grant.
    if (!(this.document as any).nodePrincipal.addonId?.endsWith(SUFFIX)) return;
    const api = Cu.createObjectIn(win);
    for (const kind of KINDS)
      Cu.exportFunction(
        (value: unknown) => {
          // Only a string or a number crosses: never a page object (getters, proxies).
          const v = typeof value === "string" || typeof value === "number" ? value : null;
          return new win.Promise((resolve: (b: boolean) => void) => this.sendQuery(kind, v).then((r) => resolve(r === true), () => resolve(false)));
        },
        api,
        { defineAs: kind },
      );
    Object.freeze(Cu.waiveXrays(api));
    Object.defineProperty(win.wrappedJSObject, "__webaios", { value: api, writable: false, configurable: false, enumerable: false });
    // As Electron's window-open handler: an agent page opens nothing itself (chrome.tabs.create, checked, does).
    Object.defineProperty(win.wrappedJSObject, "open", { value: Cu.exportFunction(() => null, win), writable: false, configurable: false, enumerable: true });
  }
}
