import { describe, expect, it, vi } from "vitest";
import { createDownloads, toItem, type DownloadLike } from "../chrome/store/downloads";

const base: DownloadLike = {
  target: { path: "/tmp/dl/fichier(1).txt" },
  currentBytes: 35,
  totalBytes: 100,
  hasProgress: true,
  succeeded: false,
  canceled: false,
  error: null,
  stopped: false,
  startTime: new Date(0),
};

describe("toItem", () => {
  it("maps a Firefox download to Electron's shape", () => {
    expect(toItem("a", { ...base, succeeded: true, stopped: true })).toEqual({ id: "a", nom: "fichier(1).txt", chemin: "/tmp/dl/fichier(1).txt", recus: 35, total: 100, etat: "termine" });
    expect(toItem("b", { ...base, error: new Error("x"), stopped: true }).etat).toBe("interrompu");
    expect(toItem("c", { ...base, canceled: true, stopped: true }).etat).toBe("annule");
    expect(toItem("d", { ...base, hasProgress: false })).toMatchObject({ etat: "en-cours", total: 0, recus: 35 });
  });
});

describe("createDownloads", () => {
  it("opens a finished download with the system's app, like Electron's shell.openPath", async () => {
    const launch = vi.fn(async () => {});
    const d = { ...base, succeeded: true, stopped: true, launch };
    vi.stubGlobal("ChromeUtils", {
      importESModule: () => ({ Downloads: { ALL: 0, getList: async () => ({ addView: async (v: any) => v.onDownloadAdded(d) }) } }),
    });
    try {
      const downloads = await createDownloads();
      downloads.open(downloads.list()[0]!.id);
      expect(launch).toHaveBeenCalledWith({ useSystemDefault: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
