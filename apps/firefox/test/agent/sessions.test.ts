import { expect, test, vi } from "vitest";
import { WorkshopError } from "@webaios/kernel";
import { GROUPING_MS, SessionsAgent, BUFFER_MAX, SessionBuffer, type SessionLike } from "../../core/agent/sessions";

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

function prepare(open?: () => Promise<SessionLike>) {
  const sessions: FakeSession[] = [];
  const sends: { f: string; canal: string; v: unknown }[] = [];
  const messages: string[] = [];
  const manager = new SessionsAgent({
    ouvrir:
      open ??
      (async () => {
        const s = new FakeSession();
        sessions.push(s);
        return s;
      }),
    envoyer: (f, channel, v) => sends.push({ f, canal: channel, v }),
    surEnvoi: (f) => messages.push(f),
  });
  const states = (f = "F") => sends.filter((e) => e.f === f && e.canal === "etat").map((e) => e.v);
  return { gestion: manager, sessions, envois: sends, etats: states, messages };
}
const size = { cols: 80, rows: 24 };

test("starting twice opens only one session; the second call returns the buffer", async () => {
  const { gestion: manager, sessions, envois: sends, etats: states } = prepare();
  await manager.demarrer("F", size);
  sessions[0]!.emettre("bonjour");
  sends.length = 0;
  await manager.demarrer("F", size);
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
    const { gestion: manager, sessions, envois: sends } = prepare();
    await manager.demarrer("F", size);
    for (const d of ["a", "b", "c"]) sessions[0]!.emettre(d);
    expect(sends.filter((e) => e.canal === "donnees")).toEqual([]);
    vi.advanceTimersByTime(GROUPING_MS);
    expect(sends.filter((e) => e.canal === "donnees").map((e) => e.v)).toEqual(["abc"]);
  } finally {
    vi.useRealTimers();
  }
});

test("the buffer keeps the end of a huge output, starting at the beginning of a line", () => {
  const t = new SessionBuffer(1000);
  for (let i = 0; i < 100; i++) t.ajouter(`${String(i).padStart(3, "0")}\x1b[31mrouge\x1b[0m\r\n`);
  const s = t.texte();
  expect(s.length).toBeLessThanOrEqual(1000);
  expect(s.length).toBeGreaterThan(900);
  expect(s.endsWith("099\x1b[31mrouge\x1b[0m\r\n")).toBe(true);
  expect(s).toMatch(/^\d{3}\x1b\[31m/);
});

test("the buffer cuts a newline-free output exactly at the character", () => {
  const t = new SessionBuffer(BUFFER_MAX);
  for (let i = 0; i < 1000; i++) t.ajouter(`${String(i).padStart(4, "0")}${"x".repeat(996)}`);
  expect(t.texte().length).toBe(BUFFER_MAX);
  expect(t.texte().endsWith(`0999${"x".repeat(996)}`)).toBe(true);
});

test("Docker absent → docker-absent; other error → error with message", async () => {
  const absent = prepare(() => Promise.reject(new WorkshopError("docker-absent")));
  await absent.gestion.demarrer("F", size);
  expect(absent.etats()).toEqual([{ etat: "preparation" }, { etat: "docker-absent" }]);
  const broken = prepare(() => Promise.reject(new Error("x")));
  await broken.gestion.demarrer("F", size);
  expect(broken.etats().at(-1)).toEqual({ etat: "erreur", message: "x" });
});

test("agent end → termine; demarrer starts a new session", async () => {
  const { gestion: manager, sessions, etats: states } = prepare();
  await manager.demarrer("F", size);
  sessions[0]!.finir(3);
  expect(states().at(-1)).toEqual({ etat: "termine", code: 3 });
  expect(manager.active("F")).toBe(false);
  await manager.demarrer("F", size);
  expect(sessions).toHaveLength(2);
  expect(manager.active("F")).toBe(true);
});

test("fermerFenetre stops the session; a session that finishes opening after the close is stopped", async () => {
  const { gestion: manager, sessions } = prepare();
  await manager.demarrer("F", size);
  manager.fermerFenetre("F");
  expect(sessions[0]!.arretee).toBe(true);
  let release!: (s: SessionLike) => void;
  const late = new FakeSession();
  const slow = prepare(() => new Promise((ok) => (release = ok)));
  const startup = slow.gestion.demarrer("G", size);
  slow.gestion.fermerFenetre("G");
  release(late);
  await startup;
  expect(late.arretee).toBe(true);
});

test("ecrire goes to the window's session", async () => {
  const { gestion: manager, sessions } = prepare();
  await manager.demarrer("F", size);
  manager.ecrire("F", "ls\r");
  manager.ecrire("G", "rien");
  expect(sessions[0]!.ecrit).toEqual(["ls\r"]);
});

test("Enter in the terminal = the user sends a message (surEnvoi); an ordinary keystroke does not", async () => {
  const { gestion: manager, messages } = prepare();
  await manager.demarrer("F", size);
  manager.ecrire("F", "abc");
  expect(messages).toEqual([]);
  manager.ecrire("F", "abc\r");
  expect(messages).toEqual(["F"]);
});

test("relancerTout stops every session and reopens one at the same size, without announcing « terminé »", async () => {
  const sizes: { cols: number; rows: number }[] = [];
  const sessions: FakeSession[] = [];
  const sends: { f: string; canal: string; v: unknown }[] = [];
  const manager = new SessionsAgent({
    ouvrir: async (_f, t) => {
      sizes.push(t);
      const s = new FakeSession();
      sessions.push(s);
      return s;
    },
    envoyer: (f, channel, v) => sends.push({ f, canal: channel, v }),
  });
  await manager.demarrer("F", size);
  manager.redimensionner("F", { cols: 100, rows: 30 });
  const old = sessions[0]!;
  old.arreter = () => old.finir(143); // a real pty announces its end when stopped
  sends.length = 0;
  await manager.relancerTout();
  expect(old.active).toBe(false);
  expect(sessions).toHaveLength(2);
  expect(sizes[1]).toEqual({ cols: 100, rows: 30 });
  expect(sends.filter((e) => e.canal === "etat").map((e) => e.v)).toEqual([{ etat: "preparation" }, { etat: "actif" }]);
  expect(manager.active("F")).toBe(true);
});

test("relancerTout during a start: the failure of the old start does not overwrite the new session", async () => {
  const sessions: FakeSession[] = [];
  const sends: { f: string; canal: string; v: unknown }[] = [];
  let fail!: (e: Error) => void;
  let calls = 0;
  const manager = new SessionsAgent({
    ouvrir: () => {
      if (calls++ === 0) return new Promise((_ok, ko) => (fail = ko));
      const s = new FakeSession();
      sessions.push(s);
      return Promise.resolve(s);
    },
    envoyer: (f, channel, v) => sends.push({ f, canal: channel, v }),
  });
  const old = manager.demarrer("F", size);
  await manager.relancerTout();
  fail(new Error("noyau arrêté"));
  await old;
  expect(sends.filter((e) => e.canal === "etat").at(-1)?.v).toEqual({ etat: "actif" });
  expect(manager.active("F")).toBe(true);
});

test("toutArreter waits for each session to stop", async () => {
  let finish!: () => void;
  const s = new FakeSession();
  s.arreter = () => new Promise<void>((ok) => (finish = ok));
  const manager = new SessionsAgent({ ouvrir: async () => s, envoyer: () => {} });
  await manager.demarrer("F", size);
  let rendered = false;
  const stop = manager.toutArreter().then(() => (rendered = true));
  await new Promise((r) => setTimeout(r, 20));
  expect(rendered).toBe(false);
  finish();
  await stop;
});

test("preRemplir before the start writes as soon as the session is active", async () => {
  let open!: (s: SessionLike) => void;
  const session = new FakeSession();
  const { gestion: manager, messages } = prepare(() => new Promise((r) => (open = r)));
  const written: string[] = [];
  manager.preRemplir("F", "[premier] ");
  manager.preRemplir("F", "[contexte] ", () => written.push(`accès avant : ${session.ecrit.length}`));
  const startup = manager.demarrer("F", size);
  expect(session.ecrit).toEqual([]);
  open(session);
  await startup;
  // The last text wins; access is given at write time, session open; nothing is sent.
  expect(session.ecrit).toEqual(["[contexte] "]);
  expect(written).toEqual(["accès avant : 0"]);
  expect(messages).toEqual([]);
});

test("preRemplir on an active session writes right away", async () => {
  const { gestion: manager, sessions, messages } = prepare();
  await manager.demarrer("F", size);
  let called = 0;
  manager.preRemplir("F", "[application : Essai] ", () => called++);
  expect(sessions[0]!.ecrit).toEqual(["[application : Essai] "]);
  expect(called).toBe(1);
  expect(messages).toEqual([]);
});

test("ouvrir receives the session's window", async () => {
  const received: { f: string; t: { cols: number; rows: number } }[] = [];
  const manager = new SessionsAgent({
    ouvrir: async (f, t) => {
      received.push({ f, t });
      return new FakeSession();
    },
    envoyer: () => {},
  });
  await manager.demarrer("F7", size);
  expect(received).toEqual([{ f: "F7", t: size }]);
});
