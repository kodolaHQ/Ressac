import type { AskHit, AskResult, WindowId } from "../../shared/model";
import type { AgentHost } from "../agent/host";

export interface Ask {
  /** False while the host is down or Gemma is missing. */
  usable(): Promise<boolean>;
  warm(): void;
  /** Never rejects: the agent while the host is down. */
  find(question: string): Promise<AskResult>;
  /** Sends the question to the window's agent with the pages already shown, then opens its panel. */
  handOff(windowId: WindowId, question: string, shown: AskHit[]): Promise<void>;
}

/** The ⌘T questions: the history search and the agent live in the kernel host. */
export function createAsk(host: AgentHost, openAgent: (windowId: WindowId) => void): Ask {
  return {
    usable: () => host.request<boolean>("ask.usable").catch(() => false),
    warm: () => host.notify("ask.warm"),
    find: (question) => host.request<AskResult>("ask.find", { question }).catch((): AskResult => ({ kind: "agent" })),
    async handOff(windowId, question, shown) {
      // Host down: the panel still opens and shows the agent's state.
      await host.request("ask.handOff", { window: windowId, question, shown }).catch(() => {});
      openAgent(windowId);
    },
  };
}
