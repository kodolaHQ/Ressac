import { expect, test } from "vitest";
import { SessionAgent } from "../../src/pty/session.js";

test("SessionAgent: echo via /bin/cat and end", async () => {
  const s = SessionAgent.demarrer(["/bin/cat"], { cols: 80, rows: 24 });
  expect(s.active).toBe(true);
  let received = "";
  const vu = new Promise<void>((ok) => s.surDonnees((d) => { received += d; if (received.includes("bonjour")) ok(); }));
  s.ecrire("bonjour\r");
  await vu;
  const fin = new Promise<number>((ok) => s.surFin(ok));
  s.arreter();
  await fin;
  expect(s.active).toBe(false);
});

test("unsubscribing cuts the callbacks", async () => {
  const s = SessionAgent.demarrer(["/bin/cat"], { cols: 80, rows: 24 });
  let calls = 0;
  const unsubscribe = s.surDonnees(() => calls++);
  unsubscribe();
  s.ecrire("x\r");
  await new Promise((r) => setTimeout(r, 200));
  s.arreter();
  expect(calls).toBe(0);
});

test("arreter also notifies the container (arreterDistant), only once", async () => {
  let distants = 0;
  const s = SessionAgent.demarrer(["/bin/cat"], { cols: 80, rows: 24, arreterDistant: () => void distants++ });
  const fin = new Promise<number>((ok) => s.surFin(ok));
  s.arreter();
  await fin;
  s.arreter();
  expect(distants).toBe(1);
});

test("arreter hands back control once the agent is stopped in the container (⌘Q leaves none running)", async () => {
  let finish!: () => void;
  const s = SessionAgent.demarrer(["/bin/cat"], { cols: 80, rows: 24, arreterDistant: () => new Promise<void>((ok) => (finish = ok)) });
  let rendered = false;
  const stop = Promise.resolve(s.arreter()).then(() => (rendered = true));
  await new Promise((r) => setTimeout(r, 20));
  expect(rendered).toBe(false);
  finish();
  await stop;
  expect(rendered).toBe(true);
});
