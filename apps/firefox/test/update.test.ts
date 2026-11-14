import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../core/state/actions";
import { initialState } from "../core/state/initial-state";
import { loadSession, SessionRecorder } from "../core/state/persistence";
import { isSignatureFailure, showUpdateCard, updatePhase } from "../core/update";
import type { BrowserState, UpdateShown } from "../shared/model";

let n = 0;
const genId = () => `id-${++n}`;
const set = (s: BrowserState, version: string, phase: UpdateShown["phase"] = "ready") => apply(s, { type: "setUpdate", update: { phase, version, progress: null } }, genId);

describe("updatePhase", () => {
  it.each([
    ["NEVER_CHECKED", "idle"],
    ["NO_UPDATES_FOUND", "idle"],
    ["CHECKING", "checking"],
    ["DOWNLOADING", "downloading"],
    ["STAGING", "downloading"],
    ["READY_FOR_RESTART", "ready"],
    // Auto mode downloads by itself: this status only waits for a user's go Ressac never asks for.
    ["DOWNLOAD_AND_INSTALL", "idle"],
    ["DOWNLOAD_FAILED", "failed"],
    ["CHECKING_FAILED", "failed"],
    ["INTERNAL_ERROR", "failed"],
    ["NO_UPDATER", "disabled"],
    ["UNSUPPORTED_SYSTEM", "disabled"],
    ["UPDATE_DISABLED_BY_POLICY", "disabled"],
    ["OTHER_INSTANCE_HANDLING_UPDATES", "disabled"],
    ["MANUAL_UPDATE", "unwritable"],
    ["SOMETHING_NEW", "idle"],
  ])("%s → %s", (status, phase) => expect(updatePhase(status)).toBe(phase));
});

describe("setUpdate / dismissUpdate", () => {
  it("« Plus tard » holds for the same version, not for a newer one", () => {
    let s = set(initialState(genId), "0.1.5");
    expect(s.update).toEqual({ phase: "ready", version: "0.1.5", progress: null, dismissed: false });
    s = apply(s, { type: "dismissUpdate" }, genId);
    expect(s.update?.dismissed).toBe(true);
    expect(set(s, "0.1.5").update?.dismissed).toBe(true);
    expect(set(s, "0.1.6").update?.dismissed).toBe(false);
  });

  it("dismissing before anything is known changes nothing", () => {
    const s = initialState(genId);
    expect(apply(s, { type: "dismissUpdate" }, genId)).toBe(s);
  });
});

describe("showUpdateCard", () => {
  const u = (phase: UpdateShown["phase"], dismissed = false): UpdateShown => ({ phase, version: "0.1.5", progress: null, dismissed });
  it("only for a ready update not put off", () => {
    expect(showUpdateCard(u("ready"))).toBe(true);
    expect(showUpdateCard(u("ready", true))).toBe(false);
    expect(showUpdateCard(u("downloading"))).toBe(false);
    expect(showUpdateCard(null)).toBe(false);
  });
});

describe("isSignatureFailure", () => {
  it("the MAR security codes, not network or other failures", () => {
    for (const code of [17, 18, 19, 20, 21, 22, 23]) expect(isSignatureFailure(code)).toBe(true);
    for (const code of [0, 7, 16, 24, 2152398878]) expect(isSignatureFailure(code)).toBe(false);
  });
});

describe("persistence", () => {
  it("the update state is never saved and loads as unknown", async () => {
    const d = mkdtempSync(join(tmpdir(), "ressac-update-"));
    const recorder = new SessionRecorder(d);
    recorder.schedule(set(initialState(genId), "0.1.5"));
    await recorder.clear();
    expect(JSON.parse(readFileSync(join(d, "session.json"), "utf8"))).not.toHaveProperty("update");
    expect((await loadSession(d)).update).toBeNull();
  });
});

describe("installUpdates", () => {
  it("an update already pending at a check gets the manager's version, at start and later", async () => {
    const { vi } = await import("vitest");
    const READY = 12;
    let listener: (status: number) => void = () => {};
    let readyVersion = "0.1.5";
    class AppUpdater {
      static STATUS = { debugStringFor: (s: number) => (s === READY ? "READY_FOR_RESTART" : null) };
      // check() clears its update and reports READY synchronously when one is pending (AppUpdater.sys.mjs).
      update = null;
      addListener(l: (status: number) => void) {
        listener = l;
      }
      async check() {
        listener(READY);
      }
    }
    vi.stubGlobal("Services", { env: { get: () => "" }, obs: { addObserver: () => {} } });
    vi.stubGlobal("ChromeUtils", { importESModule: () => ({ AppUpdater }) });
    vi.stubGlobal("Ci", {});
    vi.stubGlobal("Cc", { "@mozilla.org/updates/update-manager;1": { getService: () => ({ getReadyUpdate: async () => ({ displayVersion: readyVersion }) }) } });
    try {
      const { installUpdates } = await import("../chrome/store/updates");
      const dispatched: unknown[] = [];
      const updates = installUpdates((a) => void dispatched.push(a), () => {});
      await vi.waitFor(() => expect(dispatched).toEqual([{ type: "setUpdate", update: { phase: "ready", version: "0.1.5", progress: null } }]));
      readyVersion = "0.1.6";
      updates.check();
      await vi.waitFor(() => expect(dispatched.at(-1)).toEqual({ type: "setUpdate", update: { phase: "ready", version: "0.1.6", progress: null } }));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
