import { expect, test } from "vitest";
import { SessionAgent } from "../../src/pty/session.js";

test("SessionAgent : écho via /bin/cat et fin", async () => {
  const s = SessionAgent.demarrer(["/bin/cat"], { cols: 80, rows: 24 });
  expect(s.active).toBe(true);
  let recu = "";
  const vu = new Promise<void>((ok) => s.surDonnees((d) => { recu += d; if (recu.includes("bonjour")) ok(); }));
  s.ecrire("bonjour\r");
  await vu;
  const fin = new Promise<number>((ok) => s.surFin(ok));
  s.arreter();
  await fin;
  expect(s.active).toBe(false);
});

test("se désabonner coupe les rappels", async () => {
  const s = SessionAgent.demarrer(["/bin/cat"], { cols: 80, rows: 24 });
  let appels = 0;
  const desabonner = s.surDonnees(() => appels++);
  desabonner();
  s.ecrire("x\r");
  await new Promise((r) => setTimeout(r, 200));
  s.arreter();
  expect(appels).toBe(0);
});

test("arreter prévient aussi le conteneur (arreterDistant), une seule fois", async () => {
  let distants = 0;
  const s = SessionAgent.demarrer(["/bin/cat"], { cols: 80, rows: 24, arreterDistant: () => void distants++ });
  const fin = new Promise<number>((ok) => s.surFin(ok));
  s.arreter();
  await fin;
  s.arreter();
  expect(distants).toBe(1);
});

test("arreter rend la main une fois l'agent arrêté dans le conteneur (⌘Q n'en laisse pas tourner)", async () => {
  let finir!: () => void;
  const s = SessionAgent.demarrer(["/bin/cat"], { cols: 80, rows: 24, arreterDistant: () => new Promise<void>((ok) => (finir = ok)) });
  let rendu = false;
  const arret = Promise.resolve(s.arreter()).then(() => (rendu = true));
  await new Promise((r) => setTimeout(r, 20));
  expect(rendu).toBe(false);
  finir();
  await arret;
  expect(rendu).toBe(true);
});
