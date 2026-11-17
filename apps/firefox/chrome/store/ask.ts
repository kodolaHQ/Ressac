import type { AskHit, AskResult, WindowId } from "../../shared/model";
import type { AgentHost } from "../agent/host";

export interface Ask {
  /** False while the host is down or the search model is missing. */
  usable(): Promise<boolean>;
  warm(): void;
  /** Never rejects: the agent while the host is down. */
  find(question: string): Promise<AskResult>;
  /** Sends the question to the window's agent with the pages already shown, then opens its panel; false when the host refused it (panel left closed). */
  handOff(windowId: WindowId, question: string, shown: AskHit[]): Promise<boolean>;
}

/** The ⌘T questions: the history search and the agent live in the kernel host. */
export function createAsk(host: AgentHost, openAgent: (windowId: WindowId) => void): Ask {
  return {
    usable: () => host.request<boolean>("ask.usable").catch(() => false),
    warm: () => host.notify("ask.warm"),
    find: (question) => host.request<AskResult>("ask.find", { question }).catch((): AskResult => ({ kind: "agent" })),
    async handOff(windowId, question, shown) {
      try {
        await host.request("ask.handOff", { window: windowId, question, shown });
      } catch (e) {
        // Nothing was sent: the panel stays closed, the bar keeps the question.
        console.error("[ask] hand-off failed:", e);
        return false;
      }
      openAgent(windowId);
      return true;
    },
  };
}
