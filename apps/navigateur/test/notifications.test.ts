import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { creerNotifieur, type NotificationLike } from "../src/main/notifications";

/** Une fausse notification : jamais celle de macOS. */
function fausses() {
  const creees: { opts: { title: string; body: string }; montree: number; clic?: () => void }[] = [];
  const creer = vi.fn((opts: { title: string; body: string }): NotificationLike => {
    const n: (typeof creees)[number] = { opts, montree: 0 };
    creees.push(n);
    return {
      on: (_e, f) => void (n.clic = f),
      show: () => void n.montree++,
    };
  });
  return { creees, creer };
}

const N = { widget: "veille", titre: "Vélos d'occasion", texte: "3 nouveaux éléments" };

test("crée la notification avec titre et texte et la montre", () => {
  const { creees, creer } = fausses();
  creerNotifieur({ creer, auClic: () => {} })(N);
  expect(creees).toHaveLength(1);
  expect(creees[0]!.opts).toEqual({ title: "Vélos d'occasion", body: "3 nouveaux éléments" });
  expect(creees[0]!.montree).toBe(1);
});

test("un clic appelle auClic", () => {
  const { creees, creer } = fausses();
  const auClic = vi.fn();
  const notifier = creerNotifieur({ creer, auClic });
  notifier(N);
  notifier({ ...N, texte: "1 nouvel élément" });
  expect(auClic).not.toHaveBeenCalled();
  creees[1]!.clic!();
  expect(auClic).toHaveBeenCalledTimes(1);
  creees[0]!.clic!();
  expect(auClic).toHaveBeenCalledTimes(2);
});

test("avec fichierTest : une ligne JSON écrite, rien de montré", () => {
  const { creer } = fausses();
  const fichierTest = join(mkdtempSync(join(tmpdir(), "webaios-notif-")), "notifications.jsonl");
  expect(existsSync(fichierTest)).toBe(false);
  const notifier = creerNotifieur({ creer, auClic: () => {}, fichierTest });
  notifier(N);
  notifier({ ...N, texte: "1 nouvel élément" });
  expect(creer).not.toHaveBeenCalled();
  const lignes = readFileSync(fichierTest, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lignes).toEqual([
    { titre: "Vélos d'occasion", texte: "3 nouveaux éléments" },
    { titre: "Vélos d'occasion", texte: "1 nouvel élément" },
  ]);
});

test("invisible sans fichierTest : rien de montré ni d'écrit", () => {
  const { creer } = fausses();
  creerNotifieur({ creer, auClic: () => {}, invisible: true })(N);
  expect(creer).not.toHaveBeenCalled();
});
