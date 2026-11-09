import { expect, test, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../../core/state/actions";
import { initialState } from "../../core/state/initial-state";
import { chargerSession, SessionRecorder } from "../../core/state/persistence";
import type { BrowserState } from "../../shared/model";

const dossier = () => mkdtempSync(join(tmpdir(), "webaios-session-"));
const mis_de_cote = (d: string, suffix: string) => readdirSync(d).filter((f) => f.startsWith("session.json.") && f.endsWith(suffix));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function richState(): BrowserState {
  let n = 0;
  const g = () => `g${++n}`;
  let e = initialState(g);
  const F = e.fenetres[0]!.id;
  e = apply(e, { type: "ouvrirOnglet", fenetreId: F, url: "https://a.test/" }, g);
  e = apply(e, { type: "ouvrirOnglet", fenetreId: F, url: "https://b.test/" }, g);
  const [a, b] = Object.keys(e.onglets);
  e = apply(e, { type: "majOnglet", id: a!, champs: { titre: "A", zoom: 1.2, chargement: true, peutReculer: true, plante: true } }, g);
  e = apply(e, { type: "epinglerOnglet", id: b! }, g);
  e = apply(e, { type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut" }, g);
  return e;
}

test("round trip: identical, apart from volatile fields reset to defaults", async () => {
  const d = dossier();
  const state = richState();
  const recorder = new SessionRecorder(d);
  recorder.planifier(state);
  await recorder.vider();
  const reviewed = await chargerSession(d);
  const a = Object.values(reviewed.onglets).find((o) => o.url === "https://a.test/")!;
  expect(a).toMatchObject({ titre: "A", zoom: 1.2, chargement: false, peutReculer: false, peutAvancer: false, plante: false });
  const expected = structuredClone(state);
  for (const o of Object.values(expected.onglets)) Object.assign(o, { chargement: false, peutReculer: false, peutAvancer: false, plante: false, erreur: null });
  expect(reviewed).toEqual(expected);
});

/** The same state as a browser from before configurable spaces saved it (version 1). */
function enV1(state: BrowserState): unknown {
  const { profils: _profiles, ...rest } = structuredClone(state);
  return { ...rest, version: 1, espaces: rest.espaces.map(({ prive: _private, profil: _profile, ...e }) => e) };
}

test("session v1 → v2: non-private spaces on the default sign-in profile, tabs intact", async () => {
  const d = dossier();
  const state = richState();
  writeFileSync(join(d, "session.json"), JSON.stringify(enV1(state)));
  const e = await chargerSession(d);
  expect(e.version).toBe(2);
  expect(e.profils).toEqual([{ id: "defaut" }]);
  for (const space of e.espaces) expect(space).toMatchObject({ prive: false, profil: "defaut" });
  const expected = structuredClone(state);
  for (const o of Object.values(expected.onglets)) Object.assign(o, { chargement: false, peutReculer: false, peutAvancer: false, plante: false, erreur: null });
  expect(e).toEqual(expected);
  expect(mis_de_cote(d, ".corrompu")).toEqual([]);
});

test("session v2 with a private space and a second sign-in profile: identical round trip", async () => {
  const d = dossier();
  let n = 100;
  const g = () => `h${++n}`;
  const state = apply(richState(), { type: "creerEspace", nom: "Banque", icone: "🏦", prive: true, profil: "nouveau" }, g);
  expect(state.profils).toHaveLength(2);
  const recorder = new SessionRecorder(d);
  recorder.planifier(state);
  await recorder.vider();
  const reviewed = await chargerSession(d);
  expect(reviewed.version).toBe(2);
  expect(reviewed.profils).toEqual(state.profils);
  expect(reviewed.espaces).toEqual(state.espaces);
});

test("a session saved before the windows' frame loads (frame = null)", async () => {
  const d = dossier();
  const old = structuredClone(initialState()) as unknown as { fenetres: Record<string, unknown>[] };
  for (const f of old.fenetres) delete f.cadre;
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  const e = await chargerSession(d);
  expect(e.fenetres[0]!.cadre).toBeNull();
  expect(mis_de_cote(d, ".corrompu")).toEqual([]);
});

test("missing file → initial state", async () => {
  const e = await chargerSession(dossier());
  expect(e.espaces).toHaveLength(1);
  expect(e.fenetres).toHaveLength(1);
});

test("invalid JSON → initial state and old file set aside (….corrompu)", async () => {
  const d = dossier();
  writeFileSync(join(d, "session.json"), "{ pas du json");
  const e = await chargerSession(d);
  expect(e.onglets).toEqual({});
  const [kept] = mis_de_cote(d, ".corrompu");
  expect(readFileSync(join(d, kept!), "utf8")).toBe("{ pas du json");
});

test("corrupted session: the name of the file set aside is returned to warn the user, nothing without a file", async () => {
  const d = dossier();
  const kept = vi.fn();
  await chargerSession(d, kept);
  expect(kept).not.toHaveBeenCalled();
  writeFileSync(join(d, "session.json"), "{ pas du json");
  await chargerSession(d, kept);
  expect(kept).toHaveBeenCalledWith(join(d, mis_de_cote(d, ".corrompu")[0]!));
});

test("unknown version → initial state and file set aside", async () => {
  const d = dossier();
  writeFileSync(join(d, "session.json"), JSON.stringify({ ...richState(), version: 3 }));
  const e = await chargerSession(d);
  expect(e.onglets).toEqual({});
  expect(mis_de_cote(d, ".corrompu")).toHaveLength(1);
});

test("two corrupted sessions in a row: the second does not overwrite the first", async () => {
  const d = dossier();
  writeFileSync(join(d, "session.json"), "premier");
  await chargerSession(d);
  writeFileSync(join(d, "session.json"), "second");
  await chargerSession(d);
  const guards = mis_de_cote(d, ".corrompu").map((f) => readFileSync(join(d, f), "utf8"));
  expect(guards.sort()).toEqual(["premier", "second"]);
});

test("unreadable session (permissions) → initial state, and the next save does not overwrite it", async () => {
  const d = dossier();
  const path = join(d, "session.json");
  writeFileSync(path, JSON.stringify(richState()));
  chmodSync(path, 0o000);
  const e = await chargerSession(d);
  expect(e.onglets).toEqual({});
  const recorder = new SessionRecorder(d, 0);
  recorder.planifier(e);
  await recorder.vider();
  const [kept] = mis_de_cote(d, ".illisible");
  chmodSync(join(d, kept!), 0o600);
  expect(Object.keys(JSON.parse(readFileSync(join(d, kept!), "utf8")).onglets)).toHaveLength(2);
});

test("inconsistent state (no space) → initial state", async () => {
  const d = dossier();
  writeFileSync(join(d, "session.json"), JSON.stringify({ ...richState(), espaces: [] }));
  expect((await chargerSession(d)).espaces).toHaveLength(1);
});

test("planifier batches writes (3 close calls → 1 write)", async () => {
  const d = dossier();
  const spy = vi.spyOn(fsp, "rename");
  const recorder = new SessionRecorder(d, 50);
  const e = richState();
  recorder.planifier(e);
  recorder.planifier(e);
  recorder.planifier(e);
  await wait(150);
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();
});

test("atomic write: goes through a temporary file then rename", async () => {
  const d = dossier();
  const spy = vi.spyOn(fsp, "rename");
  const recorder = new SessionRecorder(d);
  recorder.planifier(richState());
  await recorder.vider();
  expect(spy.mock.calls[0]![0]).toMatch(/session\.json\..*tmp$/);
  expect(spy.mock.calls[0]![1]).toBe(join(d, "session.json"));
  spy.mockRestore();
});

test("vider() writes the pending state immediately; with nothing pending, does nothing", async () => {
  const d = dossier();
  const recorder = new SessionRecorder(d, 10_000);
  await recorder.vider();
  expect(existsSync(join(d, "session.json"))).toBe(false);
  recorder.planifier(richState());
  await recorder.vider();
  expect(existsSync(join(d, "session.json"))).toBe(true);
});

test("vider() waits for the write in progress: nothing is lost on exit, no temporary file remains", async () => {
  const d = dossier();
  const recorder = new SessionRecorder(d, 10_000);
  const a = richState();
  const b = apply(a, { type: "choisirMoteur", moteur: "qwant" });
  recorder.planifier(a);
  const premiere = recorder.vider(); // write in progress…
  const sortie = recorder.vider(); // …the exit has nothing pending any more, but must wait
  await sortie;
  expect(existsSync(join(d, "session.json"))).toBe(true);
  recorder.planifier(b);
  await Promise.all([recorder.vider(), recorder.vider(), premiere]);
  expect(JSON.parse(readFileSync(join(d, "session.json"), "utf8")).reglages.moteur).toBe("qwant");
  const { readdirSync } = await import("node:fs");
  expect(readdirSync(d).filter((f) => f.endsWith(".tmp"))).toEqual([]);
});

test("a failed write leaves no temporary file and the state is rewritten on the next vider()", async () => {
  const d = dossier();
  const spy = vi.spyOn(fsp, "rename").mockRejectedValueOnce(new Error("disque plein"));
  const recorder = new SessionRecorder(d, 10_000);
  recorder.planifier(richState());
  await recorder.vider();
  expect(readdirSync(d)).toEqual([]);
  await recorder.vider();
  expect(Object.keys(JSON.parse(readFileSync(join(d, "session.json"), "utf8")).onglets)).toHaveLength(2);
  spy.mockRestore();
});

test("a tab's load error is not saved", async () => {
  const d = dossier();
  let e = richState();
  const id = Object.keys(e.onglets)[0]!;
  e = apply(e, { type: "majOnglet", id, champs: { erreur: "ERR_NAME_NOT_RESOLVED" } });
  const recorder = new SessionRecorder(d);
  recorder.planifier(e);
  await recorder.vider();
  expect((await chargerSession(d)).onglets[id]?.erreur).toBeNull();
});

test("a session saved without profilAgent loads with claude", async () => {
  const d = dossier();
  const old = structuredClone(initialState()) as unknown as { reglages: Record<string, unknown> };
  delete old.reglages.profilAgent;
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  const e = await chargerSession(d);
  expect(e.reglages.profilAgent).toBe("claude");
  expect(mis_de_cote(d, ".corrompu")).toEqual([]);
});

test("a session saved without agent panel width loads with 420", async () => {
  const d = dossier();
  const old = structuredClone(initialState()) as unknown as { reglages: Record<string, unknown> };
  delete old.reglages.largeurPanneauAgent;
  writeFileSync(join(d, "session.json"), JSON.stringify(old));
  const e = await chargerSession(d);
  expect(e.reglages.largeurPanneauAgent).toBe(420);
  expect(mis_de_cote(d, ".corrompu")).toEqual([]);
});

test("session v2 where a space uses an unlisted sign-in profile: the profile is added to the list", async () => {
  const d = dossier();
  const state = richState();
  state.espaces[1]!.profil = "orphelin";
  writeFileSync(join(d, "session.json"), JSON.stringify(state));
  const reviewed = await chargerSession(d);
  expect(reviewed.profils).toEqual([{ id: "defaut" }, { id: "orphelin" }]);
  expect(reviewed.espaces[1]!.profil).toBe("orphelin");
});
