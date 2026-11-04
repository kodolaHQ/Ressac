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
  /** Listens to AddonManager, then tells the host it may install the granted extensions (extensions.pret). */
  start(host: AgentHost): void;
}

/** Firefox's side of the agent's extensions: the noyau host decides, this installs, enables, disables, uninstalls. */
export function createAgentExtensions(store: Store, windows: WindowRegistry): AgentExtensions {
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
    "extensions.installer": async (p: { addonId: string; xpi: string; temporaire: boolean; version: string }) => {
      const id = agentId(p.addonId);
      const present = await AddonManager.getAddonByID(id);
      if (present && present.version === p.version) return { version: present.version };
      return own(id, async () => {
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

  return {
    handlers,
    start(host) {
      const outside = (addon: { id: string }, quoi: "desinstallee" | "desactivee") => {
        // Quitting unloads temporary add-ons: not a choice made in about:addons.
        if (!addon.id.endsWith(SUFFIX) || ours.has(addon.id) || Services.startup.shuttingDown) return;
        host.notify("extensions.horsWebaios", { addonId: addon.id, quoi });
      };
      AddonManager.addAddonListener({
        onUninstalled: (a: { id: string }) => outside(a, "desinstallee"),
        onDisabled: (a: { id: string }) => outside(a, "desactivee"),
      });
      host.request("extensions.pret", {}).catch((e) => console.error("[extensions] agent extensions not started:", e));
    },
  };
}
