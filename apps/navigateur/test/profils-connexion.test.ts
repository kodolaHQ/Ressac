import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import type { EtatNavigateur } from "../src/commun/modele";

/** Une fausse session par partition : on compte les effacements. */
const effacees: string[] = [];
/** Partitions dont l'effacement échoue. */
const echecs = new Set<string>();
const sessions = new Map<string, { partition: string; storagePath: string; clearStorageData(): Promise<void>; clearCache(): Promise<void> }>();
/** Dossier racine des fausses sessions (posé par beforeEach) : le `storagePath` de chacune est `<racine>/Partitions/<nom>`. */
let racineSessions = "";
vi.mock("electron", () => ({
  session: {
    fromPartition(partition: string) {
      let s = sessions.get(partition);
      if (!s) {
        s = {
          partition,
          storagePath: join(racineSessions, partition.replace("persist:", "")),
          clearStorageData: async () => {
            if (echecs.has(partition)) throw new Error("effacement impossible");
            effacees.push(partition);
          },
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
const etat = (...ids: string[]) => ({ profils: ids.map((id) => ({ id })), espaces: [] }) as unknown as EtatNavigateur;

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "webaios-profils-"));
  racineSessions = join(dossier, "Partitions");
  branchees = [];
  effacees.length = 0;
  echecs.clear();
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

const liste = () => JSON.parse(readFileSync(join(dossier, "profils-a-effacer.json"), "utf8")) as string[];

test("un profil retiré de l'état passe par la liste des profils à effacer et la quitte une fois effacé", async () => {
  const p = creer();
  await p.synchroniser(etat("defaut", "abc"));
  expect(liste()).toEqual([]);
  await p.synchroniser(etat("defaut"));
  expect(effacees).toEqual(["persist:webaios-abc"]);
  expect(liste()).toEqual([]);
});

test("une partition qui n'est pas sur la liste n'est jamais effacée : session de secours puis lancement normal", async () => {
  // Les partitions de profils d'une session perdue (corrompue, effacée) restent sur le disque.
  for (const n of ["webaios-banque", "webaios-boulot", "webaios"]) mkdirSync(join(dossier, "Partitions", n), { recursive: true });
  // Lancement sur l'état de secours, puis lancement suivant sur la session réécrite : aucun des deux n'efface rien.
  await creer().synchroniser(etat("defaut"));
  const suivant = creer();
  await suivant.synchroniser(etat("defaut"));
  await suivant.synchroniser(etat("defaut"));
  expect(effacees).toEqual([]);
  expect(liste()).toEqual([]);
});

test("un effacement raté reste sur la liste et est repris au démarrage suivant ; un profil revenu dans l'état est gardé", async () => {
  const p = creer();
  await p.synchroniser(etat("defaut", "abc", "xyz"));
  echecs.add("persist:webaios-abc");
  await p.synchroniser(etat("defaut", "xyz"));
  expect(effacees).toEqual([]);
  expect(liste()).toEqual(["abc"]);
  echecs.clear();
  await creer().synchroniser(etat("defaut", "xyz"));
  expect(effacees).toEqual(["persist:webaios-abc"]);
  expect(liste()).toEqual([]);
  // Sur la liste mais de nouveau utilisé (liste écrite à la main) : retiré de la liste, pas effacé.
  writeFileSync(join(dossier, "profils-a-effacer.json"), JSON.stringify(["xyz", "defaut"]));
  await creer().synchroniser(etat("defaut", "xyz"));
  expect(effacees).toEqual(["persist:webaios-abc"]);
  expect(liste()).toEqual([]);
});

test("une liste illisible vaut une liste vide : rien n'est effacé", async () => {
  writeFileSync(join(dossier, "profils-a-effacer.json"), "{ pas du json");
  await creer().synchroniser(etat("defaut"));
  expect(effacees).toEqual([]);
});

test("un profil qu'un espace utilise n'est jamais effacé, même absent de la liste des profils", async () => {
  const p = creer();
  const avecEspace = { profils: [{ id: "defaut" }], espaces: [{ id: "e", profil: "abc" }] } as unknown as EtatNavigateur;
  await p.synchroniser(avecEspace);
  await p.synchroniser(avecEspace);
  expect(effacees).toEqual([]);
  await p.synchroniser(etat("defaut"));
  expect(effacees).toEqual(["persist:webaios-abc"]);
});

test("effacer un profil efface ses données d'extensions et appelle oublier", async () => {
  const oublies: string[] = [];
  const p = new SessionsProfils({ dossier, brancher: () => {}, oublier: (id) => void oublies.push(id) });
  const stockage = join(racineSessions, "webaios-abc");
  const extensions = ["Local Extension Settings", "Sync Extension Settings", "Managed Extension Settings", "Extension State", "Extension Rules", "Extension Scripts"];
  for (const d of [...extensions, "Local Storage", "Autre profil"]) mkdirSync(join(stockage, d), { recursive: true });
  // Le dossier d'un autre profil n'est jamais touché.
  mkdirSync(join(racineSessions, "webaios-xyz", "Local Extension Settings"), { recursive: true });
  await p.synchroniser(etat("defaut", "abc", "xyz"));
  await p.synchroniser(etat("defaut", "xyz"));
  for (const d of extensions) expect(existsSync(join(stockage, d)), d).toBe(false);
  // Ce que `clearStorageData` (ici simulé) efface lui-même n'est pas l'affaire de ce ménage.
  expect(existsSync(join(stockage, "Local Storage"))).toBe(true);
  expect(existsSync(join(racineSessions, "webaios-xyz", "Local Extension Settings"))).toBe(true);
  expect(oublies).toEqual(["abc"]);
  expect(effacees).toEqual(["persist:webaios-abc"]);
});
