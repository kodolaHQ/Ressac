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
