import type { Portee } from "../../../../packages/noyau/src/index.ts";
import type { CarteExtension } from "../../../navigateur/src/commun/extensions";
import { hotePermisAgent, urlPermiseAgent } from "../../../navigateur/src/main/extensions/reseau";
import type { IdProfil } from "../../../navigateur/src/commun/modele";
import type { Handler } from "../../shared/rpc";
import type { AgentHost } from "../agent/host";
import type { Questions } from "../agent/questions";
import type { Store } from "./store";
import type { WindowRegistry } from "./windows";

const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");

// Keep in sync with noyau/extensions/copie-firefox.ts SUFFIXE_ID.
const SUFFIX = "@agent.webaios";
const REFUSED_CALLS = new Set(["tabs.captureVisibleTab", "tabs.captureTab", "tabs.detectLanguage"]);
// Keep in sync with chrome/window/tabs.ts (not imported: it runs window code at load).
const TAB_ID = "webaios-tab-id";
const PARKING = "webaios-parking";

/** How long a checkpoint waits for the first grants (the host starting) before it refuses. */
export const SCOPES_WAIT_MS = 5_000;

export type CheckKind = "urlPermise" | "hotePermis" | "estOnglet";
type Scopes = Record<string, { cle: string; accord: Portee; profils: IdProfil[]; actif: boolean }>;

export interface AgentExtensions {
  /** The requests the noyau host sends about its extensions (extensions.*, navigateur.espaces). */
  readonly handlers: Record<string, Handler>;
  /** Each new host process: extensions.pret, with the about:addons changes it has not acknowledged yet. */
  hostStarted(): void;
  /** Settled once the first host answered extensions.pret (the granted extensions handled). */
  readonly ready: Promise<void>;
  /** Settled once a host sent the grants (extensions.portees), or after SCOPES_WAIT_MS: then check refuses what it does not know. */
  scopesKnown(): Promise<void>;
  /** The extension actor's checkpoints (window.__webaios), for the add-on id read from the page's principal. */
  check(addonId: string, kind: CheckKind, value: unknown): boolean;
}

/** Firefox's side of the agent's extensions: the noyau host decides, this installs, enables, disables, uninstalls. */
export function createAgentExtensions(store: Store, windows: WindowRegistry, questions: Questions, host: () => AgentHost): AgentExtensions {
  // Add-ons this module is changing: their AddonManager events are ours, not about:addons'.
  const ours = new Set<string>();
  const own = async <T>(addonId: string, f: () => Promise<T>): Promise<T> => {
    ours.add(addonId);
    try {
      return await f();
    } finally {
      ours.delete(addonId);
    }
  };
  const agentId = (addonId: string) => {
    if (typeof addonId !== "string" || !addonId.endsWith(SUFFIX)) throw new Error(`Pas une extension de l'agent : ${addonId}`);
    return addonId;
  };

  const handlers: Record<string, Handler> = {
    // Inactive (decision 4): never installed fresh; an upgrade keeps the disabled state, so it is disabled first.
    "extensions.installer": async (p: { addonId: string; xpi: string; temporaire: boolean; version: string; actif: boolean }) => {
      const id = agentId(p.addonId);
      const present = await AddonManager.getAddonByID(id);
      if (!p.actif && !present) return null;
      if (present && present.version === p.version) return { version: present.version };
      return own(id, async () => {
        if (!p.actif && !present.userDisabled) await present.disable();
        let path = p.xpi;
        if (p.temporaire) {
          // A temporary add-on is read from its file for as long as it runs: a copy of ours, which the noyau moves.
          const dir = PathUtils.join(PathUtils.tempDir, "webaios-agent-addons");
          await IOUtils.makeDirectory(dir, { ignoreExisting: true });
          path = PathUtils.join(dir, `${id}-${p.version}.xpi`);
          await IOUtils.copy(p.xpi, path);
        }
        const file = new FileUtils.File(path);
        const addon = p.temporaire ? await AddonManager.installTemporaryAddon(file) : await (await AddonManager.getInstallForFile(file)).install();
        if (addon?.id !== id) {
          await addon?.uninstall();
          throw new Error(`Module inattendu : ${addon?.id}`);
        }
        return { version: addon.version };
      });
    },
    "extensions.activer": async (p: { addonId: string; actif: boolean }) => {
      const addon = await AddonManager.getAddonByID(agentId(p.addonId));
      if (!addon || addon.userDisabled === !p.actif) return;
      await own(addon.id, () => (p.actif ? addon.enable() : addon.disable()));
    },
    "extensions.desinstaller": async (p: { addonId: string }) => {
      const addon = await AddonManager.getAddonByID(agentId(p.addonId));
      if (addon) await own(addon.id, () => addon.uninstall());
    },
    // The grant card, in that window if still open, else the active one; no window: it falls at once.
    "extensions.accord": (p: { carte: CarteExtension; fenetre: string | null }, signal) => {
      const f = p.fenetre && windows.get(p.fenetre) ? p.fenetre : windows.active();
      return f ? questions.askExtension(p.carte, f, signal) : { accepte: false, empreinte: p.carte.empreinte, retiree: true };
    },
    "navigateur.espaces": () => ({
      espaces: store.state.espaces,
      fenetres: store.state.fenetres.filter((f) => windows.get(f.id)).map((f) => ({ id: f.id, espaceActif: f.espaceActif })),
      premierPlan: windows.active() ?? null,
    }),
  };

  // about:addons changes not acknowledged by a host: sent again with the next extensions.pret, so none is lost while no host runs.
  const pending = new Map<string, "desinstallee" | "desactivee">();
  const send = (addonId: string, quoi: "desinstallee" | "desactivee") =>
    host()
      .request("extensions.horsWebaios", { addonId, quoi })
      .then(() => pending.get(addonId) === quoi && pending.delete(addonId))
      .catch(() => {});
  AddonManager.addAddonListener({
    onUninstalled: (a: { id: string }) => outside(a, "desinstallee"),
    onDisabled: (a: { id: string }) => outside(a, "desactivee"),
  });
  function outside(addon: { id: string }, quoi: "desinstallee" | "desactivee") {
    // Quitting unloads temporary add-ons: not a choice made in about:addons.
    if (!addon.id.endsWith(SUFFIX) || ours.has(addon.id) || Services.startup.shuttingDown) return;
    pending.set(addon.id, quoi);
    void send(addon.id, quoi);
  }

  let scopes: Scopes = {};
  let scopesSettle = () => {};
  const scopesSent = new Promise<void>((r) => (scopesSettle = r));
  let scopesArrived = false;
  void scopesSent.then(() => (scopesArrived = true));
  const scopesKnown = () => (scopesArrived ? scopesSent : Promise.race([scopesSent, new Promise<void>((r) => setTimeout(r, SCOPES_WAIT_MS))]));
  handlers["extensions.portees"] = (p: Scopes) => {
    scopes = p;
    scopesSettle();
  };
  const tabOf = (tabId: unknown) => {
    if (typeof tabId !== "number") return null;
    try {
      return ExtensionParent.apiManager.global.tabTracker.getTab(tabId);
    } catch {
      return null; // Unknown id: getTab throws.
    }
  };

  function check(addonId: string, kind: CheckKind, value: unknown): boolean {
    const scope = Object.hasOwn(scopes, addonId) ? scopes[addonId]! : null;
    if (!scope?.actif) return false;
    switch (kind) {
      case "urlPermise": {
        // Relative: within the extension. Its own pages only; anything else as Electron's urlPermiseAgent.
        const host = WebExtensionPolicy.getByID(addonId)?.mozExtensionHostname;
        if (typeof value !== "string" || !host) return false;
        let u: URL;
        try {
          u = new URL(value, `moz-extension://${host}/`);
        } catch {
          return false;
        }
        return u.protocol === "moz-extension:" ? u.host === host : urlPermiseAgent(u.href, scope.accord, "");
      }
      case "hotePermis": {
        const spec = tabOf(value)?.linkedBrowser?.currentURI?.spec;
        return typeof spec === "string" && hotePermisAgent(spec, scope.accord);
      }
      case "estOnglet": {
        // A WebAiOs tab only: never the parking tab, never an invisible read (not a tab at all).
        const tab = tabOf(value);
        return !!tab?.hasAttribute?.(TAB_ID) && !tab.hasAttribute(PARKING);
      }
    }
    return false;
  }

  // The network guard beyond the copy's CSP, as Electron's equiperPagesAgent and more: every http(s) request an agent
  // extension loads or starts, of any type (navigation, window, a redirect of one, but also what Firefox's parent loads
  // for it, such as a notification icon, which no CSP sees), goes only where urlPermise says. Fail closed before the
  // grants arrive. Content scripts carry an expanded principal (no addonId): not concerned.
  Services.obs.addObserver((subject: any) => {
    const channel = subject.QueryInterface(Ci.nsIHttpChannel);
    const info = channel.loadInfo;
    const addonId: string = info.loadingPrincipal?.addonId || info.triggeringPrincipal?.addonId || "";
    if (addonId.endsWith(SUFFIX) && !check(addonId, "urlPermise", channel.URI.spec)) channel.cancel(Cr.NS_BINDING_ABORTED);
  }, "http-on-modify-request");
  // Electron has none of these, and Firefox grants activeTab to an MV3 extension on a click of its button, its menu
  // item or its command even without the right (originControls): refused in the parent, for every page of the agent's
  // extensions (background, popup, tabs), before Firefox looks at the call.
  // The conduit bound its recv methods at startup: its APICall entry is the one to wrap.
  const api = ExtensionParent.ParentAPIManager;
  const recvAPICall = api.conduit.recv.get("APICall");
  api.conduit.recv.set("APICall", (data: { childId: number; callId?: number; path: string }, meta: unknown) => {
    if (REFUSED_CALLS.has(data.path) && api.getContextUnchecked(data.childId)?.extension?.id?.endsWith(SUFFIX)) {
      if (data.callId) api.conduit.sendCallResult(data.childId, { childId: data.childId, callId: data.callId, path: data.path, error: { message: `${data.path} non pris en charge par WebAiOs` } });
      return;
    }
    return recvAPICall(data, meta);
  });
  // runtime.setUninstallURL: Firefox opens it with a null principal when the add-on goes, so it is read through
  // urlPermise then (null: no tab). Hooked on each agent extension as it starts, and on those already running.
  const guardUninstallUrl = (extension: { id: string; uninstallURL: string | null }) => {
    if (!extension?.id?.endsWith(SUFFIX)) return;
    let url = extension.uninstallURL;
    Object.defineProperty(extension, "uninstallURL", {
      get: () => (url && check(extension.id, "urlPermise", url) ? url : null),
      set: (v: string | null) => void (url = v),
      configurable: true,
    });
  };
  ExtensionParent.apiManager.on("startup", (_: string, extension: { id: string; uninstallURL: string | null }) => guardUninstallUrl(extension));
  for (const policy of WebExtensionPolicy.getActiveExtensions()) if (policy.extension) guardUninstallUrl(policy.extension);

  let settle = () => {};
  const ready = new Promise<void>((r) => (settle = r));
  return {
    handlers,
    ready,
    scopesKnown,
    check,
    hostStarted() {
      const sent = [...pending].map(([addonId, quoi]) => ({ addonId, quoi }));
      host()
        .request("extensions.pret", { horsWebaios: sent })
        .then(
          () => sent.forEach((h) => pending.get(h.addonId) === h.quoi && pending.delete(h.addonId)),
          (e) => console.error("[extensions] agent extensions not started:", e),
        )
        .finally(settle);
    },
  };
}
