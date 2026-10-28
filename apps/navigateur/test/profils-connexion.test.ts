import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import type { EtatNavigateur } from "../src/commun/modele";

/** Une fausse session par partition : on compte les effacements. */
const effacees: string[] = [];
const sessions = new Map<string, { partition: string; clearStorageData(): Promise<void>; clearCache(): Promise<void> }>();
vi.mock("electron", () => ({
  session: {
    fromPartition(partition: string) {
      let s = sessions.get(partition);
      if (!s) {
        s = {
          partition,
          clearStorageData: async () => void effacees.push(partition),
          clearCache: async () => {},
        };
        sessions.set(partition, s);
      }
      return s;
    },
  },
}));

const { partitionDe, SessionsProfils } = await import("../src/main/profils-connexion");

let dossier: string;
let branchees: string[];
const creer = () => new SessionsProfils({ dossier, brancher: (_s, id) => void branchees.push(id) });
const etat = (...ids: string[]) => ({ profils: ids.map((id) => ({ id })) }) as unknown as EtatNavigateur;

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "webaios-profils-"));
  branchees = [];
  effacees.length = 0;
  sessions.clear();
});

test("partition : celle de toujours pour le profil par défaut, une par profil sinon", () => {
  expect(partitionDe("defaut")).toBe("persist:webaios");
  expect(partitionDe("abc")).toBe("persist:webaios-abc");
});

test("une session par profil, branchée une seule fois", () => {
  const p = creer();
  const a = p.session("abc");
  expect(p.session("abc")).toBe(a);
  expect(p.session("defaut")).not.toBe(a);
  expect(branchees).toEqual(["abc", "defaut"]);
});

test("un profil disparu de l'état est effacé, avec ses autorisations ; jamais le profil par défaut tant qu'il est listé", async () => {
  writeFileSync(join(dossier, "permissions.json"), "{}");
  writeFileSync(join(dossier, "permissions-abc.json"), "{}");
  const oublies: string[] = [];
  const p = new SessionsProfils({ dossier, brancher: () => {}, oublier: (id) => void oublies.push(id) });
  await p.synchroniser(etat("defaut", "abc"));
  expect(effacees).toEqual([]);
  await p.synchroniser(etat("defaut"));
  expect(effacees).toEqual(["persist:webaios-abc"]);
  expect(oublies).toEqual(["abc"]);
  expect(existsSync(join(dossier, "permissions-abc.json"))).toBe(false);
  expect(existsSync(join(dossier, "permissions.json"))).toBe(true);
  await p.synchroniser(etat("defaut"));
  expect(effacees).toEqual(["persist:webaios-abc"]);
});

test("le profil par défaut n'est jamais effacé, même quand plus aucun espace ne l'utilise", async () => {
  writeFileSync(join(dossier, "permissions.json"), "{}");
  const oublies: string[] = [];
  const p = new SessionsProfils({ dossier, brancher: () => {}, oublier: (id) => void oublies.push(id) });
  await p.synchroniser(etat("defaut"));
  await p.synchroniser(etat("abc"));
  expect(effacees).toEqual([]);
  expect(oublies).toEqual([]);
  expect(existsSync(join(dossier, "permissions.json"))).toBe(true);
});

test("au démarrage, un profil resté sur le disque sans espace (effacement interrompu) est effacé", async () => {
  mkdirSync(join(dossier, "Partitions", "webaios-vieux"), { recursive: true });
  mkdirSync(join(dossier, "Partitions", "webaios-abc"), { recursive: true });
  mkdirSync(join(dossier, "Partitions", "webaios"), { recursive: true });
  mkdirSync(join(dossier, "Partitions", "autre"), { recursive: true });
  const p = creer();
  await p.synchroniser(etat("defaut", "abc"));
  expect(effacees).toEqual(["persist:webaios-vieux"]);
});
