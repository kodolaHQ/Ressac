import { pathInContainer, remarksPrefix, type SpacePaths, type ProjectId, type Batch, type TrackedProject } from "@webaios/kernel";
import type { WindowId } from "../../shared/model";

export interface SendOptions {
  paths: SpacePaths;
  /** The main window the agent considers active. */
  agentWindow(): WindowId | undefined;
  batchFolder(p: ProjectId, batch: string): string;
  /** `prefill`: opens the panel and sends the text to the agent. */
  prefill(f: WindowId, text: string): void;
  /** Like ⌘J: the agent's terminal takes the keyboard. */
  giveTerminal(f: WindowId): void;
  /** The main window comes to the front (no effect in invisible mode). */
  toFront(f: WindowId): void;
  /** No main window: reopen one (like the Review page), which receives the text. */
  reopen?(): void;
}

/** No main window, even reopened: the batch is written, but nothing could be pre-filled. */
export const NO_WINDOW = "Aucune fenêtre principale pour l'agent : le lot est enregistré, rouvre une fenêtre pour le lui donner.";

/**
 * After writing a batch: for an agent batch (app, demo, site), a line is sent in its session. An external project has nothing more: its batch is already in the queue of the connected Claude Code.
 */
export function createSend(o: SendOptions): (p: TrackedProject, batch: Batch) => Promise<void> {
  return async (p, batch) => {
    if (p.type === "externe") return;
    let f = o.agentWindow();
    if (f === undefined) {
      o.reopen?.();
      f = o.agentWindow();
    }
    if (f === undefined) throw new Error(NO_WINDOW);
    const batchPath = pathInContainer(o.batchFolder(batch.project, batch.id), o.paths);
    const project =
      p.type === "app" ? ({ type: "app", name: p.name, folder: p.folder } as const)
      : p.type === "site" ? ({ type: "site", name: p.name, id: p.id } as const)
      : ({ type: "demo", port: p.port } as const);
    o.prefill(f, remarksPrefix({ project: project, batch: batch, batchPath: batchPath }));
    o.giveTerminal(f);
    o.toFront(f);
  };
}
