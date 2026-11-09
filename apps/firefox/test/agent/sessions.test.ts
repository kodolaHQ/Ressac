import { expect, test, vi } from "vitest";
import { WorkshopError } from "@webaios/kernel";
import { GROUPING_MS, SessionsAgent, TAMPON_MAX, Tampon, type SessionLike } from "../../core/agent/sessions";

class FakeSession implements SessionLike {
  active = true;
  ecrit: string[] = [];
  arretee = false;
  private donnees: ((d: string) => void)[] = [];
  private fins: ((c: number) => void)[] = [];
  ecrire(d: string) {
    this.ecrit.push(d);
  }
  redimensionner() {}
  surDonnees(r: (d: string) => void) {
    this.donnees.push(r);
    return () => {};
  }
  surFin(r: (c: number) => void) {
    this.fins.push(r);
    return () => {};
  }
  arreter() {
    this.arretee = true;
  }
  emettre(d: string) {
    for (const r of this.donnees) r(d);
  }
  finir(code: number) {
    this.active = false;
    for (const r of this.fins) r(code);
  }
}

function preparer(open?: () => Promise<SessionLike>) {
  const sessions: FakeSession[] = [];
  const sends: { f: string; canal: string; v: unknown }[] = [];
  const messages: string[] = [];
  const gestion = new SessionsAgent({
    ouvrir:
      open ??
      (async () => {
        const s = new FakeSession();
        sessions.push(s);
        return s;
      }),
    envoyer: (f, canal, v) => sends.push({ f, canal, v }),
    surEnvoi: (f) => messages.push(f),
  });
  const states = (f = "F") => sends.filter((e) => e.f === f && e.canal === "etat").map((e) => e.v);
  return { gestion, sessions, envois: sends, etats: states, messages };
}
const taille = { cols: 80, rows: 24 };

test("starting twice opens only one session; the second call returns the buffer", async () => {
  const { gestion, sessions, envois: sends, etats: states } = preparer();
  await gestion.demarrer("F", taille);
  sessions[0]!.emettre("bonjour");
  sends.length = 0;
  await gestion.demarrer("F", taille);
  expect(sessions).toHaveLength(1);
  expect(states()).toEqual([{ etat: "actif" }]);
  expect(sends.filter((e) => e.canal === "donnees").map((e) => e.v)).toEqual(["bonjour"]);
  // Output waiting to be sent is already in the returned buffer: no duplicate afterwards.
  await new Promise((r) => setTimeout(r, GROUPING_MS * 3));
  expect(sends.filter((e) => e.canal === "donnees")).toHaveLength(1);
});

test("the agent's output goes out in batches: several close chunks, a single send", async () => {
  vi.useFakeTimers();
  try {
    const { gestion, sessions, envois: sends } = preparer();
    await gestion.demarrer("F", taille);
    for (const d of ["a", "b", "c"]) sessions[0]!.emettre(d);
    expect(sends.filter((e) => e.canal === "donnees")).toEqual([]);
    vi.advanceTimersByTime(GROUPING_MS);
    expect(sends.filter((e) => e.canal === "donnees").map((e) => e.v)).toEqual(["abc"]);
  } finally {
    vi.useRealTimers();
  }
});

test("the buffer keeps the end of a huge output, starting at the beginning of a line", () => {
  const t = new Tampon(1000);
  for (let i = 0; i < 100; i++) t.ajouter(`${String(i).padStart(3, "0")}\x1b[31mrouge\x1b[0m\r\n`);
  const s = t.texte();
  expect(s.length).toBeLessThanOrEqual(1000);
  expect(s.length).toBeGreaterThan(900);
  expect(s.endsWith("099\x1b[31mrouge\x1b[0m\r\n")).toBe(true);
  expect(s).toMatch(/^\d{3}\x1b\[31m/);
});

test("the buffer cuts a newline-free output exactly at the character", () => {
  const t = new Tampon(TAMPON_MAX);
  for (let i = 0; i < 1000; i++) t.ajouter(`${String(i).padStart(4, "0")}${"x".repeat(996)}`);
  expect(t.texte().length).toBe(TAMPON_MAX);
  expect(t.texte().endsWith(`0999${"x".repeat(996)}`)).toBe(true);
});

test("Docker absent → docker-absent; other error → error with message", async () => {
  const absent = preparer(() => Promise.reject(new WorkshopError("docker-absent")));
  await absent.gestion.demarrer("F", taille);
  expect(absent.etats()).toEqual([{ etat: "preparation" }, { etat: "docker-absent" }]);
  const casse = preparer(() => Promise.reject(new Error("x")));
  await casse.gestion.demarrer("F", taille);
  expect(casse.etats().at(-1)).toEqual({ etat: "erreur", message: "x" });
});

test("agent end → termine; demarrer starts a new session", async () => {
  const { gestion, sessions, etats: states } = preparer();
  await gestion.demarrer("F", taille);
  sessions[0]!.finir(3);
  expect(states().at(-1)).toEqual({ etat: "termine", code: 3 });
  expect(gestion.active("F")).toBe(false);
  await gestion.demarrer("F", taille);
  expect(sessions).toHaveLength(2);
  expect(gestion.active("F")).toBe(true);
});

test("fermerFenetre stops the session; a session that finishes opening after the close is stopped", async () => {
  const { gestion, sessions } = preparer();
  await gestion.demarrer("F", taille);
  gestion.fermerFenetre("F");
  expect(sessions[0]!.arretee).toBe(true);
  let release!: (s: SessionLike) => void;
  const tardive = new FakeSession();
  const lent = preparer(() => new Promise((ok) => (release = ok)));
  const startup = lent.gestion.demarrer("G", taille);
  lent.gestion.fermerFenetre("G");
  release(tardive);
  await startup;
  expect(tardive.arretee).toBe(true);
});

test("ecrire goes to the window's session", async () => {
  const { gestion, sessions } = preparer();
  await gestion.demarrer("F", taille);
  gestion.ecrire("F", "ls\r");
  gestion.ecrire("G", "rien");
  expect(sessions[0]!.ecrit).toEqual(["ls\r"]);
});

test("Enter in the terminal = the user sends a message (surEnvoi); an ordinary keystroke does not", async () => {
  const { gestion, messages } = preparer();
  await gestion.demarrer("F", taille);
  gestion.ecrire("F", "abc");
  expect(messages).toEqual([]);
  gestion.ecrire("F", "abc\r");
  expect(messages).toEqual(["F"]);
});

test("relancerTout stops every session and reopens one at the same size, without announcing « terminé »", async () => {
  const tailles: { cols: number; rows: number }[] = [];
  const sessions: FakeSession[] = [];
  const sends: { f: string; canal: string; v: unknown }[] = [];
  const gestion = new SessionsAgent({
    ouvrir: async (_f, t) => {
      tailles.push(t);
      const s = new FakeSession();
      sessions.push(s);
      return s;
    },
    envoyer: (f, canal, v) => sends.push({ f, canal, v }),
  });
  await gestion.demarrer("F", taille);
  gestion.redimensionner("F", { cols: 100, rows: 30 });
  const old = sessions[0]!;
  old.arreter = () => old.finir(143); // a real pty announces its end when stopped
  sends.length = 0;
  await gestion.relancerTout();
  expect(old.active).toBe(false);
  expect(sessions).toHaveLength(2);
  expect(tailles[1]).toEqual({ cols: 100, rows: 30 });
  expect(sends.filter((e) => e.canal === "etat").map((e) => e.v)).toEqual([{ etat: "preparation" }, { etat: "actif" }]);
  expect(gestion.active("F")).toBe(true);
});

test("relancerTout during a start: the failure of the old start does not overwrite the new session", async () => {
  const sessions: FakeSession[] = [];
  const sends: { f: string; canal: string; v: unknown }[] = [];
  let fail!: (e: Error) => void;
  let calls = 0;
  const gestion = new SessionsAgent({
    ouvrir: () => {
      if (calls++ === 0) return new Promise((_ok, ko) => (fail = ko));
      const s = new FakeSession();
      sessions.push(s);
      return Promise.resolve(s);
    },
    envoyer: (f, canal, v) => sends.push({ f, canal, v }),
  });
  const old = gestion.demarrer("F", taille);
  await gestion.relancerTout();
  fail(new Error("noyau arrêté"));
  await old;
  expect(sends.filter((e) => e.canal === "etat").at(-1)?.v).toEqual({ etat: "actif" });
  expect(gestion.active("F")).toBe(true);
});

test("toutArreter waits for each session to stop", async () => {
  let finish!: () => void;
  const s = new FakeSession();
  s.arreter = () => new Promise<void>((ok) => (finish = ok));
  const gestion = new SessionsAgent({ ouvrir: async () => s, envoyer: () => {} });
  await gestion.demarrer("F", taille);
  let rendered = false;
  const stop = gestion.toutArreter().then(() => (rendered = true));
  await new Promise((r) => setTimeout(r, 20));
  expect(rendered).toBe(false);
  finish();
  await stop;
});

test("preRemplir before the start writes as soon as the session is active", async () => {
  let open!: (s: SessionLike) => void;
  const session = new FakeSession();
  const { gestion, messages } = preparer(() => new Promise((r) => (open = r)));
  const written: string[] = [];
  gestion.preRemplir("F", "[premier] ");
  gestion.preRemplir("F", "[contexte] ", () => written.push(`accès avant : ${session.ecrit.length}`));
  const startup = gestion.demarrer("F", taille);
  expect(session.ecrit).toEqual([]);
  open(session);
  await startup;
  // The last text wins; access is given at write time, session open; nothing is sent.
  expect(session.ecrit).toEqual(["[contexte] "]);
  expect(written).toEqual(["accès avant : 0"]);
  expect(messages).toEqual([]);
});

test("preRemplir on an active session writes right away", async () => {
  const { gestion, sessions, messages } = preparer();
  await gestion.demarrer("F", taille);
  let called = 0;
  gestion.preRemplir("F", "[application : Essai] ", () => called++);
  expect(sessions[0]!.ecrit).toEqual(["[application : Essai] "]);
  expect(called).toBe(1);
  expect(messages).toEqual([]);
});

test("ouvrir receives the session's window", async () => {
  const received: { f: string; t: { cols: number; rows: number } }[] = [];
  const gestion = new SessionsAgent({
    ouvrir: async (f, t) => {
      received.push({ f, t });
      return new FakeSession();
    },
    envoyer: () => {},
  });
  await gestion.demarrer("F7", taille);
  expect(received).toEqual([{ f: "F7", t: taille }]);
});
