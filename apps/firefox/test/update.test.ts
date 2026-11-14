import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../core/state/actions";
import { initialState } from "../core/state/initial-state";
import { loadSession, SessionRecorder } from "../core/state/persistence";
import { isSignatureFailure, isStaleUpdate, showUpdateCard, updateCardTitle, updatePhase, updateStatusText } from "../core/update";
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

describe("isStaleUpdate", () => {
  const compare = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });
  it("an offered update no newer than the running Ressac, while downloading or ready", () => {
    expect(isStaleUpdate("ready", "0.1.5", "0.1.6", compare)).toBe(true);
    expect(isStaleUpdate("downloading", "0.1.6", "0.1.6", compare)).toBe(true);
    expect(isStaleUpdate("ready", "0.1.7", "0.1.6", compare)).toBe(false);
    expect(isStaleUpdate("ready", "0.1.10", "0.1.9", compare)).toBe(false);
  });
  it("an unknown version or another phase is left alone", () => {
    expect(isStaleUpdate("ready", null, "0.1.6", compare)).toBe(false);
    expect(isStaleUpdate("ready", "", "0.1.6", compare)).toBe(false);
    expect(isStaleUpdate("failed", "0.1.5", "0.1.6", compare)).toBe(false);
  });
});

describe("update texts", () => {
  const u = (phase: UpdateShown["phase"], version: string | null, progress: number | null = null): UpdateShown => ({ phase, version, progress, dismissed: false });
  it("name the version when known", () => {
    expect(updateCardTitle("0.1.5")).toBe("Ressac 0.1.5 est prête");
    expect(updateStatusText(u("downloading", "0.1.5", 40))).toBe("Téléchargement de 0.1.5… 40 %");
    expect(updateStatusText(u("ready", "0.1.5"))).toBe("0.1.5 prête, installée au redémarrage");
  });
  it("read right without a version", () => {
    for (const v of [null, ""]) {
      expect(updateCardTitle(v)).toBe("Une mise à jour est prête");
      expect(updateStatusText(u("downloading", v))).toBe("Téléchargement…");
      expect(updateStatusText(u("ready", v))).toBe("Mise à jour prête, installée au redémarrage");
    }
  });
  it("other phases", () => {
    expect(updateStatusText(u("idle", null))).toBe("À jour");
    expect(updateStatusText(u("checking", null))).toBe("Recherche…");
    expect(updateStatusText(u("failed", ""))).toBe("La mise à jour a échoué");
    // The app folder is not writable: À propos shows only the DMG link.
    expect(updateStatusText(u("unwritable", null))).toBe("");
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
  const compare = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });
  const calls: string[] = [];
  const prefs: Record<string, string> = {};
  async function stubFirefox(AppUpdater: unknown, um: object, elevationRequired = false) {
    const { vi } = await import("vitest");
    calls.length = 0;
    vi.stubGlobal("__RESSAC_VERSION__", "0.1.4");
    vi.stubGlobal("Services", {
      env: { get: () => "" },
      obs: { addObserver: () => {} },
      vc: { compare },
      appinfo: { version: "0.1.1" },
      prefs: { setCharPref: (k: string, v: string) => void (prefs[k] = v) },
    });
    vi.stubGlobal("ChromeUtils", { importESModule: () => ({ AppUpdater }) });
    vi.stubGlobal("Ci", {});
    vi.stubGlobal("Cc", {
      "@mozilla.org/updates/update-manager;1": { getService: () => ({ cleanupActiveUpdates: async () => void calls.push("cleanup"), ...um }) },
      "@mozilla.org/updates/update-service;1": { getService: () => ({ elevationRequired, stopDownload: async () => void calls.push("stopDownload") }) },
    });
  }

  it("an update no newer than the running Ressac is never shown and is dropped (an unpublished build)", async () => {
    const { vi } = await import("vitest");
    const READY = 12;
    let listener: (status: number) => void = () => {};
    class AppUpdater {
      static STATUS = { debugStringFor: (s: number) => (s === READY ? "READY_FOR_RESTART" : null) };
      update = { displayVersion: "0.1.4" };
      addListener(l: (status: number) => void) {
        listener = l;
      }
      async check() {
        listener(READY);
      }
      stop() {
        calls.push("stop");
      }
    }
    await stubFirefox(AppUpdater, {});
    try {
      const { installUpdates } = await import("../chrome/store/updates");
      const dispatched: unknown[] = [];
      installUpdates((a) => void dispatched.push(a), () => {});
      await vi.waitFor(() => expect(calls).toEqual(["stop", "stopDownload", "cleanup"]));
      expect(dispatched).toEqual([{ type: "setUpdate", update: { phase: "idle", version: null, progress: null } }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("an app folder needing elevation (macOS) shows unwritable, never checks, drops any update", async () => {
    const { vi } = await import("vitest");
    let checked = false;
    class AppUpdater {
      static STATUS = { debugStringFor: () => null };
      addListener() {}
      async check() {
        checked = true;
      }
    }
    await stubFirefox(AppUpdater, {}, true);
    try {
      const { installUpdates } = await import("../chrome/store/updates");
      const dispatched: unknown[] = [];
      installUpdates((a) => void dispatched.push(a), () => {});
      await vi.waitFor(() => expect(calls).toEqual(["stopDownload", "cleanup"]));
      expect(dispatched).toEqual([{ type: "setUpdate", update: { phase: "unwritable", version: null, progress: null } }]);
      expect(checked).toBe(false);
      // Firefox's background check skips an update needing elevation for this Gecko version.
      expect(prefs).toEqual({ "app.update.elevate.version": "0.1.1", "app.update.elevate.never": "0.1.1" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

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
    stubFirefox(AppUpdater, { getReadyUpdate: async () => ({ displayVersion: readyVersion }) });
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
