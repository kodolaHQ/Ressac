import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readUrlState, type DeclarationSite } from "@webaios/noyau";
import { TRACKING_INTERVAL_MS } from "../../shared/sites";
import { UrlTracking } from "../../core/sites/suivi";

const declaration: DeclarationSite = {
  nom: "Vidola",
  description: "",
  adresse: "https://vidola-a.example/",
  domaines: ["vidola-a.example"],
  connexion: [],
  suiviAdresse: { page: "https://adresses.example/", motif: "vidola" },
  retouches: [],
  reprise: false,
};

function tracking(liens: string[] | Error) {
  const signals: (AbortSignal | undefined)[] = [];
  const dossierSites = mkdtempSync(join(tmpdir(), "webaios-suivi-"));
  let now = 1_000_000;
  let lectures = 0;
  const s = new UrlTracking({
    lireLiens: async (_page, signal) => {
      signals.push(signal);
      lectures++;
      if (liens instanceof Error) throw liens;
      return liens;
    },
    dossierSites,
    adressesLocales: false,
    maintenant: () => now,
  });
  return { s, signaux: signals, dossierSites, lectures: () => lectures, avancer: (ms: number) => void (now += ms) };
}

test("the plan's interval is one minute", () => {
  expect(TRACKING_INTERVAL_MS).toBe(60_000);
});

test("links with vidola-b: change, etat.actuel vidola-b", async () => {
  const t = tracking(["https://adresses.example/autre", "https://vidola-b.example/"]);
  const r = await t.s.chercher("vidola", declaration);
  expect(r.t).toBe("change");
  if (r.t !== "change") return;
  expect(r.domaine).toBe("vidola-b.example");
  expect(r.etat.actuel).toBe("vidola-b.example");
  expect(r.etat.anciens).toEqual(["vidola-a.example"]);
  expect((await readUrlState(t.dossierSites, "vidola"))?.actuel).toBe("vidola-b.example");
});

test("two chercher in 30 s: the second « trop-tot », a single read", async () => {
  const t = tracking(["https://vidola-b.example/"]);
  expect((await t.s.chercher("vidola", declaration)).t).toBe("change");
  t.avancer(30_000);
  expect((await t.s.chercher("vidola", declaration)).t).toBe("trop-tot");
  expect(t.lectures()).toBe(1);
  t.avancer(31_000);
  expect((await t.s.chercher("vidola", declaration)).t).not.toBe("trop-tot");
  expect(t.lectures()).toBe(2);
});

test("two chercher at the same time: a single read", async () => {
  const t = tracking(["https://vidola-b.example/"]);
  const [a, b] = await Promise.all([t.s.chercher("vidola", declaration), t.s.chercher("vidola", declaration)]);
  expect([a.t, b.t].sort()).toEqual(["change", "trop-tot"]);
  expect(t.lectures()).toBe(1);
});

test("no valid link (http, local, page domain): introuvable, state unchanged", async () => {
  const t = tracking(["http://vidola-b.example/", "https://127.0.0.1/vidola", "https://vidola.adresses.example/", "https://tiers.example/vidola", "javascript:alert(1)"]);
  expect((await t.s.chercher("vidola", declaration)).t).toBe("introuvable");
  expect(await readUrlState(t.dossierSites, "vidola")).toBeNull();
});

test("the found link is the current domain: inchangee", async () => {
  const t = tracking(["https://vidola-a.example/"]);
  expect((await t.s.chercher("vidola", declaration)).t).toBe("inchangee");
  expect(await readUrlState(t.dossierSites, "vidola")).toBeNull();
});

test("read that throws: introuvable", async () => {
  const t = tracking(new Error("page de référence muette"));
  expect((await t.s.chercher("vidola", declaration)).t).toBe("introuvable");
});

test("two apps do not limit each other", async () => {
  const t = tracking(["https://vidola-b.example/"]);
  await t.s.chercher("un", declaration);
  expect((await t.s.chercher("deux", declaration)).t).not.toBe("trop-tot");
});

test("after a first change, a link to the current address is inchangee (compared to actuel, not to the declared address)", async () => {
  const t = tracking(["https://vidola-b.example/"]);
  expect((await t.s.chercher("vidola", declaration)).t).toBe("change");
  t.avancer(61_000);
  expect((await t.s.chercher("vidola", declaration)).t).toBe("inchangee");
  expect((await readUrlState(t.dossierSites, "vidola"))?.actuel).toBe("vidola-b.example");
});

test("a failed read counts in the interval: 30 s later, trop-tot", async () => {
  const t = tracking(new Error("muette"));
  expect((await t.s.chercher("vidola", declaration)).t).toBe("introuvable");
  t.avancer(30_000);
  expect((await t.s.chercher("vidola", declaration)).t).toBe("trop-tot");
  expect(t.lectures()).toBe(1);
});

test("the cancellation signal is passed to the read; a cancelled read gives introuvable and changes nothing", async () => {
  const dossierSites = mkdtempSync(join(tmpdir(), "webaios-suivi-"));
  const control = new AbortController();
  const s = new UrlTracking({
    lireLiens: (_p, signal) => new Promise((_ok, non) => signal?.addEventListener("abort", () => non(new Error("annulée")))),
    dossierSites,
    adressesLocales: false,
    maintenant: () => 0,
  });
  const r = s.chercher("vidola", declaration, control.signal);
  control.abort();
  expect((await r).t).toBe("introuvable");
  expect(await readUrlState(dossierSites, "vidola")).toBeNull();
});
