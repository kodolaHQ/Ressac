import { randomUUID } from "node:crypto";
import { DEFAULT_AURA } from "../../shared/aura";
import { DEFAULT_CLAUDE_ENGINE, DEFAULT_CODEX_ENGINE } from "../../shared/settings";
import { DEFAULT_PROFILE, type BrowserState } from "../../shared/model";

export function initialState(genId: () => string = randomUUID): BrowserState {
  const space = genId();
  return {
    version: 3,
    spaces: [{ id: space, name: "Perso", icon: "🏠", pinned: [], private: false, profile: DEFAULT_PROFILE, aura: DEFAULT_AURA }],
    profiles: [{ id: DEFAULT_PROFILE }],
    essentials: [],
    tabs: {},
    windows: [
      {
        id: genId(),
        activeSpace: space,
        order: { [space]: [] },
        active: { [space]: null },
        compact: false,
        agentPanelOpen: false,
        recentlyClosed: [],
        frame: null,
      },
    ],
    settings: { engine: "google", agentProfile: "claude", agentPanelWidth: 420, decisionModel: "pplx-decider-flash", codexEngine: { ...DEFAULT_CODEX_ENGINE }, claudeEngine: { ...DEFAULT_CLAUDE_ENGINE }, onboarded: false, seenVersion: null, hints: { enabled: true, seen: [] }, sidebarSide: "left", shortcuts: {}, vimMode: false },
  };
}
