import { expect, test } from "vitest";
import { ErreurAtelier } from "@webaios/noyau";
import { SessionsAgent, TAMPON_MAX, type SessionLike } from "../../src/main/agent/sessions";

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
});

test("le tampon garde les derniers caractères après une sortie énorme", async () => {
  const { gestion, sessions, envois } = preparer();
  await gestion.demarrer("F", taille);
  for (let i = 0; i < 1000; i++) sessions[0]!.emettre(`${String(i).padStart(4, "0")}${"x".repeat(996)}`);
  envois.length = 0;
  await gestion.demarrer("F", taille);
  const tampon = envois.find((e) => e.canal === "donnees")!.v as string;
  expect(tampon.length).toBe(TAMPON_MAX);
  expect(tampon.endsWith(`0999${"x".repeat(996)}`)).toBe(true);
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
    ouvrir: async (t) => {
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
