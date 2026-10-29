import { expect, test, vi } from "vitest";
import { ErreurAtelier } from "@webaios/noyau";
import { REGROUPEMENT_MS, SessionsAgent, TAMPON_MAX, Tampon, type SessionLike } from "../../src/main/agent/sessions";

class FausseSession implements SessionLike {
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

function preparer(ouvrir?: () => Promise<SessionLike>) {
  const sessions: FausseSession[] = [];
  const envois: { f: string; canal: string; v: unknown }[] = [];
  const messages: string[] = [];
  const gestion = new SessionsAgent({
    ouvrir:
      ouvrir ??
      (async () => {
        const s = new FausseSession();
        sessions.push(s);
        return s;
      }),
    envoyer: (f, canal, v) => envois.push({ f, canal, v }),
    surEnvoi: (f) => messages.push(f),
  });
  const etats = (f = "F") => envois.filter((e) => e.f === f && e.canal === "etat").map((e) => e.v);
  return { gestion, sessions, envois, etats, messages };
}
const taille = { cols: 80, rows: 24 };

test("demarrer deux fois n'ouvre qu'une session ; le second appel renvoie le tampon", async () => {
  const { gestion, sessions, envois, etats } = preparer();
  await gestion.demarrer("F", taille);
  sessions[0]!.emettre("bonjour");
  envois.length = 0;
  await gestion.demarrer("F", taille);
  expect(sessions).toHaveLength(1);
  expect(etats()).toEqual([{ etat: "actif" }]);
  expect(envois.filter((e) => e.canal === "donnees").map((e) => e.v)).toEqual(["bonjour"]);
  // La sortie en attente d'envoi est déjà dans le tampon renvoyé : pas de doublon ensuite.
  await new Promise((r) => setTimeout(r, REGROUPEMENT_MS * 3));
  expect(envois.filter((e) => e.canal === "donnees")).toHaveLength(1);
});

test("la sortie de l'agent part par paquets : plusieurs morceaux rapprochés, un seul envoi", async () => {
  vi.useFakeTimers();
  try {
    const { gestion, sessions, envois } = preparer();
    await gestion.demarrer("F", taille);
    for (const d of ["a", "b", "c"]) sessions[0]!.emettre(d);
    expect(envois.filter((e) => e.canal === "donnees")).toEqual([]);
    vi.advanceTimersByTime(REGROUPEMENT_MS);
    expect(envois.filter((e) => e.canal === "donnees").map((e) => e.v)).toEqual(["abc"]);
  } finally {
    vi.useRealTimers();
  }
});

test("le tampon garde la fin d'une sortie énorme, à partir d'un début de ligne", () => {
  const t = new Tampon(1000);
  for (let i = 0; i < 100; i++) t.ajouter(`${String(i).padStart(3, "0")}\x1b[31mrouge\x1b[0m\r\n`);
  const s = t.texte();
  expect(s.length).toBeLessThanOrEqual(1000);
  expect(s.length).toBeGreaterThan(900);
  expect(s.endsWith("099\x1b[31mrouge\x1b[0m\r\n")).toBe(true);
  expect(s).toMatch(/^\d{3}\x1b\[31m/);
});

test("le tampon coupe au caractère près une sortie sans retour à la ligne", () => {
  const t = new Tampon(TAMPON_MAX);
  for (let i = 0; i < 1000; i++) t.ajouter(`${String(i).padStart(4, "0")}${"x".repeat(996)}`);
  expect(t.texte().length).toBe(TAMPON_MAX);
  expect(t.texte().endsWith(`0999${"x".repeat(996)}`)).toBe(true);
});

test("Docker absent → docker-absent ; autre erreur → erreur avec message", async () => {
  const absent = preparer(() => Promise.reject(new ErreurAtelier("docker-absent")));
  await absent.gestion.demarrer("F", taille);
  expect(absent.etats()).toEqual([{ etat: "preparation" }, { etat: "docker-absent" }]);
  const casse = preparer(() => Promise.reject(new Error("x")));
  await casse.gestion.demarrer("F", taille);
  expect(casse.etats().at(-1)).toEqual({ etat: "erreur", message: "x" });
});

test("fin de l'agent → termine ; demarrer relance une nouvelle session", async () => {
  const { gestion, sessions, etats } = preparer();
  await gestion.demarrer("F", taille);
  sessions[0]!.finir(3);
  expect(etats().at(-1)).toEqual({ etat: "termine", code: 3 });
  expect(gestion.active("F")).toBe(false);
  await gestion.demarrer("F", taille);
  expect(sessions).toHaveLength(2);
  expect(gestion.active("F")).toBe(true);
});

test("fermerFenetre arrête la session ; une session qui finit de s'ouvrir après la fermeture est arrêtée", async () => {
  const { gestion, sessions } = preparer();
  await gestion.demarrer("F", taille);
  gestion.fermerFenetre("F");
  expect(sessions[0]!.arretee).toBe(true);
  let liberer!: (s: SessionLike) => void;
  const tardive = new FausseSession();
  const lent = preparer(() => new Promise((ok) => (liberer = ok)));
  const demarrage = lent.gestion.demarrer("G", taille);
  lent.gestion.fermerFenetre("G");
  liberer(tardive);
  await demarrage;
  expect(tardive.arretee).toBe(true);
});

test("ecrire va à la session de la fenêtre", async () => {
  const { gestion, sessions } = preparer();
  await gestion.demarrer("F", taille);
  gestion.ecrire("F", "ls\r");
  gestion.ecrire("G", "rien");
  expect(sessions[0]!.ecrit).toEqual(["ls\r"]);
});

test("Entrée dans le terminal = l'utilisateur envoie un message (surEnvoi) ; une frappe ordinaire, non", async () => {
  const { gestion, messages } = preparer();
  await gestion.demarrer("F", taille);
  gestion.ecrire("F", "abc");
  expect(messages).toEqual([]);
  gestion.ecrire("F", "abc\r");
  expect(messages).toEqual(["F"]);
});

test("relancerTout arrête chaque session et en rouvre une à la même taille, sans annoncer « terminé »", async () => {
  const tailles: { cols: number; rows: number }[] = [];
  const sessions: FausseSession[] = [];
  const envois: { f: string; canal: string; v: unknown }[] = [];
  const gestion = new SessionsAgent({
    ouvrir: async (_f, t) => {
      tailles.push(t);
      const s = new FausseSession();
      sessions.push(s);
      return s;
    },
    envoyer: (f, canal, v) => envois.push({ f, canal, v }),
  });
  await gestion.demarrer("F", taille);
  gestion.redimensionner("F", { cols: 100, rows: 30 });
  const ancienne = sessions[0]!;
  ancienne.arreter = () => ancienne.finir(143); // un vrai pty annonce sa fin quand on l'arrête
  envois.length = 0;
  await gestion.relancerTout();
  expect(ancienne.active).toBe(false);
  expect(sessions).toHaveLength(2);
  expect(tailles[1]).toEqual({ cols: 100, rows: 30 });
  expect(envois.filter((e) => e.canal === "etat").map((e) => e.v)).toEqual([{ etat: "preparation" }, { etat: "actif" }]);
  expect(gestion.active("F")).toBe(true);
});

test("relancerTout pendant un démarrage : l'échec de l'ancien démarrage n'écrase pas la nouvelle session", async () => {
  const sessions: FausseSession[] = [];
  const envois: { f: string; canal: string; v: unknown }[] = [];
  let echouer!: (e: Error) => void;
  let appels = 0;
  const gestion = new SessionsAgent({
    ouvrir: () => {
      if (appels++ === 0) return new Promise((_ok, ko) => (echouer = ko));
      const s = new FausseSession();
      sessions.push(s);
      return Promise.resolve(s);
    },
    envoyer: (f, canal, v) => envois.push({ f, canal, v }),
  });
  const ancien = gestion.demarrer("F", taille);
  await gestion.relancerTout();
  echouer(new Error("noyau arrêté"));
  await ancien;
  expect(envois.filter((e) => e.canal === "etat").at(-1)?.v).toEqual({ etat: "actif" });
  expect(gestion.active("F")).toBe(true);
});

test("toutArreter attend l'arrêt de chaque session", async () => {
  let finir!: () => void;
  const s = new FausseSession();
  s.arreter = () => new Promise<void>((ok) => (finir = ok));
  const gestion = new SessionsAgent({ ouvrir: async () => s, envoyer: () => {} });
  await gestion.demarrer("F", taille);
  let rendu = false;
  const arret = gestion.toutArreter().then(() => (rendu = true));
  await new Promise((r) => setTimeout(r, 20));
  expect(rendu).toBe(false);
  finir();
  await arret;
});

test("preRemplir avant le démarrage écrit dès que la session est active", async () => {
  let ouvrir!: (s: SessionLike) => void;
  const session = new FausseSession();
  const { gestion, messages } = preparer(() => new Promise((r) => (ouvrir = r)));
  const ecrits: string[] = [];
  gestion.preRemplir("F", "[premier] ");
  gestion.preRemplir("F", "[contexte] ", () => ecrits.push(`accès avant : ${session.ecrit.length}`));
  const demarrage = gestion.demarrer("F", taille);
  expect(session.ecrit).toEqual([]);
  ouvrir(session);
  await demarrage;
  // Le dernier texte gagne ; l'accès est donné au moment de l'écriture, session ouverte ; rien n'est envoyé.
  expect(session.ecrit).toEqual(["[contexte] "]);
  expect(ecrits).toEqual(["accès avant : 0"]);
  expect(messages).toEqual([]);
});

test("preRemplir sur une session active écrit tout de suite", async () => {
  const { gestion, sessions, messages } = preparer();
  await gestion.demarrer("F", taille);
  let appele = 0;
  gestion.preRemplir("F", "[application : Essai] ", () => appele++);
  expect(sessions[0]!.ecrit).toEqual(["[application : Essai] "]);
  expect(appele).toBe(1);
  expect(messages).toEqual([]);
});

test("ouvrir reçoit la fenêtre de la session", async () => {
  const recues: { f: string; t: { cols: number; rows: number } }[] = [];
  const gestion = new SessionsAgent({
    ouvrir: async (f, t) => {
      recues.push({ f, t });
      return new FausseSession();
    },
    envoyer: () => {},
  });
  await gestion.demarrer("F7", taille);
  expect(recues).toEqual([{ f: "F7", t: taille }]);
});
