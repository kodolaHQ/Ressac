import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readUrlState, type DeclarationSite } from "@ressac/kernel";
import { TRACKING_INTERVAL_MS } from "../../shared/sites";
import { UrlTracking } from "../../core/sites/tracking";

const declaration: DeclarationSite = {
  name: "Vidola",
  description: "",
  url: "https://vidola-a.example/",
  domains: ["vidola-a.example"],
  login: [],
  urlTracking: { page: "https://adresses.example/", pattern: "vidola" },
  tweaks: [],
  resume: false,
};

function tracking(links: string[] | Error) {
  const signals: (AbortSignal | undefined)[] = [];
  const sitesFolder = mkdtempSync(join(tmpdir(), "ressac-suivi-"));
  let now = 1_000_000;
  let reads = 0;
  const s = new UrlTracking({
    readLinks: async (_page, signal) => {
      signals.push(signal);
      reads++;
      if (links instanceof Error) throw links;
      return links;
    },
    sitesFolder: sitesFolder,
    localAddresses: false,
    now: () => now,
  });
  return { s, signals: signals, sitesFolder: sitesFolder, reads: () => reads, forward: (ms: number) => void (now += ms) };
}

test("the plan's interval is one minute", () => {
  expect(TRACKING_INTERVAL_MS).toBe(60_000);
});

test("links with vidola-b: change, etat.actuel vidola-b", async () => {
  const t = tracking(["https://adresses.example/autre", "https://vidola-b.example/"]);
  const r = await t.s.find("vidola", declaration);
  expect(r.t).toBe("change");
  if (r.t !== "change") return;
  expect(r.domain).toBe("vidola-b.example");
  expect(r.state.current).toBe("vidola-b.example");
  expect(r.state.previous).toEqual(["vidola-a.example"]);
  expect((await readUrlState(t.sitesFolder, "vidola"))?.current).toBe("vidola-b.example");
});

test("two chercher in 30 s: the second « trop-tot », a single read", async () => {
  const t = tracking(["https://vidola-b.example/"]);
  expect((await t.s.find("vidola", declaration)).t).toBe("change");
  t.forward(30_000);
  expect((await t.s.find("vidola", declaration)).t).toBe("too-soon");
  expect(t.reads()).toBe(1);
  t.forward(31_000);
  expect((await t.s.find("vidola", declaration)).t).not.toBe("too-soon");
  expect(t.reads()).toBe(2);
});

test("two chercher at the same time: a single read", async () => {
  const t = tracking(["https://vidola-b.example/"]);
  const [a, b] = await Promise.all([t.s.find("vidola", declaration), t.s.find("vidola", declaration)]);
  expect([a.t, b.t].sort()).toEqual(["change", "too-soon"]);
  expect(t.reads()).toBe(1);
});

test("no valid link (http, local, page domain): introuvable, state unchanged", async () => {
  const t = tracking(["http://vidola-b.example/", "https://127.0.0.1/vidola", "https://vidola.adresses.example/", "https://tiers.example/vidola", "javascript:alert(1)"]);
  expect((await t.s.find("vidola", declaration)).t).toBe("not-found");
  expect(await readUrlState(t.sitesFolder, "vidola")).toBeNull();
});

test("the found link is the current domain: inchangee", async () => {
  const t = tracking(["https://vidola-a.example/"]);
  expect((await t.s.find("vidola", declaration)).t).toBe("unchanged");
  expect(await readUrlState(t.sitesFolder, "vidola")).toBeNull();
});

test("read that throws: introuvable", async () => {
  const t = tracking(new Error("page de référence muette"));
  expect((await t.s.find("vidola", declaration)).t).toBe("not-found");
});

test("two apps do not limit each other", async () => {
  const t = tracking(["https://vidola-b.example/"]);
  await t.s.find("un", declaration);
  expect((await t.s.find("deux", declaration)).t).not.toBe("too-soon");
});

test("after a first change, a link to the current address is inchangee (compared to actuel, not to the declared address)", async () => {
  const t = tracking(["https://vidola-b.example/"]);
  expect((await t.s.find("vidola", declaration)).t).toBe("change");
  t.forward(61_000);
  expect((await t.s.find("vidola", declaration)).t).toBe("unchanged");
  expect((await readUrlState(t.sitesFolder, "vidola"))?.current).toBe("vidola-b.example");
});

test("a failed read counts in the interval: 30 s later, trop-tot", async () => {
  const t = tracking(new Error("muette"));
  expect((await t.s.find("vidola", declaration)).t).toBe("not-found");
  t.forward(30_000);
  expect((await t.s.find("vidola", declaration)).t).toBe("too-soon");
  expect(t.reads()).toBe(1);
});

test("the cancellation signal is passed to the read; a cancelled read gives introuvable and changes nothing", async () => {
  const sitesFolder = mkdtempSync(join(tmpdir(), "ressac-suivi-"));
  const control = new AbortController();
  const s = new UrlTracking({
    readLinks: (_p, signal) => new Promise((_ok, non) => signal?.addEventListener("abort", () => non(new Error("annulée")))),
    sitesFolder: sitesFolder,
    localAddresses: false,
    now: () => 0,
  });
  const r = s.find("vidola", declaration, control.signal);
  control.abort();
  expect((await r).t).toBe("not-found");
  expect(await readUrlState(sitesFolder, "vidola")).toBeNull();
});
