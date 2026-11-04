import type { Handler } from "../../shared/rpc";
import type { AgentHost } from "../agent/host";
import type { Store } from "./store";
import type { WindowRegistry } from "./windows";

const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");

// Keep in sync with noyau/extensions/copie-firefox.ts SUFFIXE_ID.
const SUFFIX = "@agent.webaios";

export interface AgentExtensions {
  /** The requests the noyau host sends about its extensions (extensions.*, navigateur.espaces). */
  readonly handlers: Record<string, Handler>;
  /** Each new host process: extensions.pret, with the about:addons changes it has not acknowledged yet. */
  hostStarted(): void;
  /** Settled once the first host answered extensions.pret (the granted extensions handled). */
  readonly ready: Promise<void>;
}

/** Firefox's side of the agent's extensions: the noyau host decides, this installs, enables, disables, uninstalls. */
export function createAgentExtensions(store: Store, windows: WindowRegistry, host: () => AgentHost): AgentExtensions {
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

  let settle = () => {};
  const ready = new Promise<void>((r) => (settle = r));
  return {
    handlers,
    ready,
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
