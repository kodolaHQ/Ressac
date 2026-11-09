import { pathInContainer, remarksPrefix, type SpacePaths, type ProjectId, type Lot, type TrackedProject } from "@webaios/kernel";
import type { WindowId } from "../../shared/model";

export interface SendOptions {
  chemins: SpacePaths;
  /** The main window the agent considers active. */
  fenetreAgent(): WindowId | undefined;
  dossierLot(p: ProjectId, lot: string): string;
  /** `agent.preRemplir`: opens the panel and puts the text in the input, without sending it. */
  preRemplir(f: WindowId, text: string): void;
  /** Like ⌘J: the agent's terminal takes the keyboard. */
  donnerLeTerminal(f: WindowId): void;
  /** The main window comes to the front (no effect in invisible mode). */
  devant(f: WindowId): void;
  /** No main window: reopen one (like the Review page), which receives the text. */
  rouvrir?(): void;
}

/** No main window, even reopened: the batch is written, but nothing could be pre-filled. */
export const NO_WINDOW = "Aucune fenêtre principale pour l'agent : le lot est enregistré, rouvre une fenêtre pour le lui donner.";

/**
 * After writing a batch: for an agent batch (app, demo), a line is pre-filled in its session, never
 * sent. An external project has nothing more: its batch is already in the queue of the connected Claude Code.
 */
export function createSend(o: SendOptions): (p: TrackedProject, lot: Lot) => Promise<void> {
  return async (p, lot) => {
    if (p.type === "externe") return;
    let f = o.fenetreAgent();
    if (f === undefined) {
      o.rouvrir?.();
      f = o.fenetreAgent();
    }
    if (f === undefined) throw new Error(NO_WINDOW);
    const batchPath = pathInContainer(o.dossierLot(lot.projet, lot.id), o.chemins);
    const project =
      p.type === "app" ? ({ type: "app", nom: p.nom, dossier: p.dossier } as const)
      : p.type === "site" ? ({ type: "site", nom: p.nom, id: p.id } as const)
      : ({ type: "demo", port: p.port } as const);
    o.preRemplir(f, remarksPrefix({ projet: project, lot, cheminLot: batchPath }));
    o.donnerLeTerminal(f);
    o.devant(f);
  };
}
