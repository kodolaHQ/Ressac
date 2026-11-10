import { rm } from "node:fs/promises";
import {
  UNREADABLE_WARNING,
  pluggedCommand,
  startExternalServer,
  ReviewStore,
  reviewStore,
  commentsFile,
  portTaken,
  externalProject,
  type DesignFolders,
  type ExternalRegistry,
  type Remarks,
  type DeclarationResult,
} from "@webaios/kernel";
import type { ExternalsState } from "../../shared/api";

const DEFAULT_NAME = "Claude Code";
const NAME_MAX = 60;

/** Reason displayed when the external MCP does not start (other than a taken port) or its registry is unreadable. */
export const failureReason = (e: unknown): string => `Le MCP externe n'a pas pu démarrer : ${e instanceof Error ? e.message : String(e)}`;

export interface ExternalService {
  state(): ExternalsState;
  connect(name: string): Promise<{ command: string }>;
  revoke(id: string): Promise<void>;
  forget(id: string): Promise<void>;
  stop(): Promise<void>;
}

/**
 * The external MCP: the local server (never another port than the one requested), a project's declaration by a Claude
 * Code (registry, first review snapshot, notification) and the Applications page's gestures.
 */
export async function startExternals(o: {
  registry: ExternalRegistry;
  remarks: Remarks;
  folders: DesignFolders;
  port: number;
  ranges: [number, number][];
  spaceRoot: string;
  home: string;
  /** Notification of a project's first declaration. */
  notify(n: { title: string; text: string }): void;
}): Promise<ExternalService> {
  let server: { port: number; stop(): Promise<void> } | null = null;
  let serverState: ExternalsState["server"];
  try {
    server = await startExternalServer({
      registry: o.registry,
      remarks: o.remarks,
      port: o.port,
      declare: async (client, d): Promise<DeclarationResult> => {
        const r = await o.registry.declare(client.id, d, { ranges: o.ranges, spaceRoot: o.spaceRoot, home: o.home });
        if (r.readable) {
          // The review's first snapshot is taken in the background: an error does not prevent the declaration.
          const id = externalProject(r.project.id);
          void new ReviewStore({ repo: reviewStore(o.folders, id), folder: r.project.folder })
            .ensureReference()
            .catch((e) => console.error("[external] first review snapshot failed:", e));
        }
        if (r.first) o.notify({ title: "WebAiOs", text: `${client.name} a branché le projet ${r.project.name}` });
        return { project: r.project, ...(r.readable ? {} : { warning: UNREADABLE_WARNING }) };
      },
    });
    serverState = { state: "ready", port: server.port };
  } catch (e) {
    // Port taken or any other error: the section says so, never « démarre » endlessly.
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") serverState = { state: "off", reason: portTaken(o.port) };
    else {
      console.error("[external] start failed:", e);
      serverState = { state: "off", reason: failureReason(e) };
    }
  }

  return {
    state: () => {
      const clients = o.registry.clients();
      return {
        server: serverState,
        projects: o.registry.projects().map((p) => ({ ...p, client: p.client, clientName: clients.find((c) => c.id === p.client)?.name ?? null })),
        clients: clients.map((c) => ({ id: c.id, name: c.name, created: c.created })),
      };
    },
    connect: async (name) => {
      if (serverState.state !== "ready") throw new Error(serverState.reason);
      const clean = name.trim().slice(0, NAME_MAX) || DEFAULT_NAME;
      const { token: token } = await o.registry.connect(clean);
      return { command: pluggedCommand(serverState.port, token) };
    },
    revoke: (id) => o.registry.revoke(id),
    forget: async (id) => {
      const project = externalProject(id);
      await o.registry.forget(id);
      await o.remarks.forget(project);
      await Promise.all([
        // Through the repository queue: goes after a first snapshot in progress, which would otherwise recreate it.
        new ReviewStore({ repo: reviewStore(o.folders, project), folder: o.spaceRoot }).delete(),
        rm(commentsFile(o.folders, project), { force: true }),
      ]);
    },
    stop: async () => {
      await server?.stop();
    },
  };
}
