import type { Action, ApiDesign, ApiWebaios, ShownElement, ExternalsState, BatchShown, ExtensionResult } from "../shared/api";
import type { WindowId } from "../shared/model";
import { HOST_EXITED, type AgentHost } from "../chrome/agent/host";
import type { WindowController } from "../chrome/window/controller";
import {
  checkClientName,
  checkComment,
  checkLines,
  checkPath,
  checkProject,
  checkResolved,
  checkText,
  checkToken,
  CLIENT_ID,
  DESIGN_ID_MAX,
  EXTERNAL_ID,
  ID_PROJECT,
  INVALID_REQUEST,
  failureReason,
} from "../shared/design-guards";

// The section « Projets externes » and the Review page over the kernel host's externes.* and relecture.* RPCs, with
// the shared guards (shared/design-guards.ts) before any call.

/** An error from the store's realm, made again in this one (`instanceof Error` fails across realms). */
export const local = (e: unknown): Error => new Error(typeof (e as Error | null)?.message === "string" ? (e as Error).message : String(e));

export function createExternalApi(o: {
  host: Pick<AgentHost, "request" | "on">;
  window: WindowId;
  dispatch: (a: Action) => void;
  untilUnload: (f: () => void) => () => void;
}): ApiWebaios["external"] {
  const { host } = o;
  const call = (method: string, params: unknown) =>
    host.request(method, params).then(
      () => {},
      (e) => console.error(`[webaios] ${method} :`, local(e).message),
    );
  return {
    // A host that does not answer: the off server with its reason (spec §5.10).
    list: () =>
      host.request<ExternalsState>("external.list").then(
        (v) => structuredClone(v),
        (e) => ({ server: { state: "off" as const, reason: failureReason(local(e)) }, projects: [], clients: [] }),
      ),
    onChange(cb) {
      // accueil.change: the host sends it at each kernel start.
      const offs = ["external.change", HOST_EXITED, "home.change"].map((m) => host.on(m, () => cb()));
      return o.untilUnload(() => offs.forEach((f) => f()));
    },
    async connect(name) {
      const n = checkClientName(name);
      return host.request<{ command: string }>("external.connect", { name: n }).then(
        (r) => structuredClone(r),
        (e) => Promise.reject(local(e)),
      );
    },
    async revoke(id) {
      if (typeof id === "string" && CLIENT_ID.test(id)) await call("external.revoke", { id });
    },
    async forget(id) {
      if (typeof id === "string" && EXTERNAL_ID.test(id)) await call("external.forget", { id });
    },
    review(id) {
      if (typeof id !== "string" || !EXTERNAL_ID.test(id)) return;
      void host.request<string | null>("external.name", { id }).then(
        (name) => {
          if (typeof name === "string") o.dispatch({ type: "openReview", windowId: o.window, project: "ext-" + id, name: name.slice(0, 80) });
        },
        (e) => console.error("[webaios] externes.nom :", local(e).message),
      );
    },
  };
}

/** The Review page: the shared guards, then the handler of the same name; a rejection keeps its message. */
export function createReviewApi(o: { host: Pick<AgentHost, "request"> }): ApiWebaios["review"] {
  const ask = <T>(method: string, params: Record<string, unknown>): Promise<T> =>
    o.host.request<T>(method, params).then(
      (v) => structuredClone(v),
      (e) => Promise.reject(local(e)),
    );
  return {
    async open(project, token) {
      return ask("review.open", { project: checkProject(project), token: token === undefined || token === null ? null : checkToken(token) });
    },
    async file(project, token, path) {
      return ask("review.file", { project: checkProject(project), token: checkToken(token), path: checkPath(path) });
    },
    async lines(project, token, path, start, end) {
      const p = checkProject(project);
      [start, end] = checkLines(start, end);
      return ask("review.lines", { project: p, token: checkToken(token), path: checkPath(path), start: start, end: end });
    },
    async comments(project) {
      return ask("review.comments", { project: checkProject(project) });
    },
    async comment(project, token, c) {
      const p = checkProject(project);
      if (typeof c !== "object" || c === null) throw new Error("lignes invalides");
      const [start, end] = checkLines(c.start, c.end);
      return ask("review.comment", { project: p, token: checkToken(token), c: { file: checkPath(c.file), start: start, end: end, text: checkText(c.text) } });
    },
    async editComment(project, id, text) {
      return ask("review.editComment", { project: checkProject(project), id: checkComment(id), text: checkText(text) });
    },
    async resolve(project, id, resolved) {
      const p = checkProject(project);
      const r = checkResolved(resolved);
      return ask("review.resolve", { project: p, id: checkComment(id), resolved: r });
    },
    async deleteComment(project, id) {
      return ask("review.deleteComment", { project: checkProject(project), id: checkComment(id) });
    },
    async send(project) {
      return ask("review.send", { project: checkProject(project) });
    },
    async reviewed(project, token) {
      return ask("review.reviewed", { project: checkProject(project), token: checkToken(token) });
    },
  };
}

/**
 * The design mode of this window's active tab: the target is this window, never an id
 * the UI sends. A cart, batch or send is only for the project of the tab's state (projetPermis); the host checks again.
 */
export function createDesignApi(o: { win: WindowController; untilUnload: (f: () => void) => () => void }): ApiDesign {
  const { design, agent: host } = o.win.store;
  const t = { type: "fenetre" as const, windowId: o.win.windowId };
  const copy = <T>(p: Promise<T>): Promise<T> =>
    p.then(
      (v) => structuredClone(v),
      (e) => Promise.reject(local(e)),
    );
  const appState = () => copy(design.state(t));
  const allowed = async (p: unknown): Promise<boolean> => typeof p === "string" && ID_PROJECT.test(p) && p === (await appState().catch(() => null))?.project?.project;
  const id = (x: unknown): x is string => typeof x === "string" && x.length <= DESIGN_ID_MAX;
  return {
    state: appState,
    toggle: () => void design.toggle(t),
    review: () => void design.review(t),
    basket: async (p) => ((await allowed(p)) ? copy(host.request<ShownElement[]>("design.basket", { project: p })) : []),
    batches: async (p) => ((await allowed(p)) ? copy(host.request<BatchShown[]>("design.batches", { project: p })) : []),
    async remove(p, x) {
      if ((await allowed(p)) && id(x)) await copy(host.request("design.remove", { project: p, id: x }));
    },
    async handled(p, batch) {
      if ((await allowed(p)) && id(batch)) await copy(host.request("design.handled", { project: p, batch: batch }));
    },
    send: async (p) => ((await allowed(p)) ? copy(host.request<ExtensionResult>("design.send", { project: p })) : { ok: false, error: INVALID_REQUEST }),
    onChange(cb) {
      // accueil.change: the host sends it at each kernel start.
      const offs = [...["design.change", HOST_EXITED, "home.change"].map((m) => host.on(m, () => cb())), design.onChange(() => cb())];
      return o.untilUnload(() => offs.forEach((f) => f()));
    },
  };
}
