import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { analyserManifeste, type EntreeExtension, type EtatExtensions, type IdProfil } from "@webaios/noyau";
import { construireCrx } from "../../e2e/extensions/crx";

// La bibliothèque du Store importe `electron` à son chargement (voir telechargement.test.ts).
vi.mock("electron", () => ({ app: {}, net: {}, session: {}, BrowserWindow: vi.fn(), ipcMain: {}, nativeImage: {}, powerMonitor: {}, webContents: {} }));

const { accepterMiseAJour, appliquerMiseAJour, chercherMisesAJour, comparerVersions, INTERVALLE_MAJ_MS, URL_MISES_A_JOUR } = await import("../../src/main/extensions/mises-a-jour");
const { CRX_INVALIDE, ERREUR_STORE } = await import("../../src/main/extensions/telechargement");

const temporaires: string[] = [];
const temporaire = (prefixe: string) => {
  const d = mkdtempSync(join(tmpdir(), prefixe));
  temporaires.push(d);
  return d;
};

// ——— Faux Store local pour les CRX ———

const servis = new Map<string, Buffer>();
let serveur: Server;
let base: string;
let requetes = 0;
beforeAll(async () => {
  serveur = createServer((req, res) => {
    requetes++;
    const corps = servis.get(req.url ?? "");
    if (!corps) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/x-chrome-extension" }).end(corps);
  });
  await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const d of temporaires) rmSync(d, { recursive: true, force: true });
  await new Promise<void>((ok) => serveur.close(() => ok()));
});

const MANIFESTE = { manifest_version: 3, name: "Bloqueur", version: "1.0.0", permissions: ["storage"], host_permissions: ["https://a.exemple/*"] };

/** Publie une version d'une extension (même clé : même id) ; rend son id et l'adresse de son CRX. */
function publier(cle: KeyObject, manifeste: Record<string, unknown>, o: { signatureFausse?: boolean } = {}): { id: string; url: string } {
  const source = temporaire("webaios-maj-src-");
  writeFileSync(join(source, "manifest.json"), JSON.stringify({ ...MANIFESTE, ...manifeste }));
  const { crx, id } = construireCrx(source, { cle, ...o });
  const chemin = `/${id}-${String(manifeste.version)}.crx`;
  servis.set(chemin, crx);
  return { id, url: `${base}${chemin}` };
}

// ——— Faux Omaha ———

const PREFIXE = ")]}'\n";
type Appel = { url: string; init: RequestInit };
let appels: Appel[];

function fauxFetch(reponse: (corps: { request: { app: { appid: string }[] } }) => { statut?: number; texte: string }) {
  return (async (url: string | URL, init?: RequestInit) => {
    appels.push({ url: String(url), init: init ?? {} });
    const r = reponse(JSON.parse(String(init?.body)));
    return new Response(r.texte, { status: r.statut ?? 200 });
  }) as typeof fetch;
}

const omaha = (apps: { appid: string; status?: string; version?: string; codebase?: string }[]) =>
  PREFIXE +
  JSON.stringify({
    response: {
      protocol: "3.1",
      app: apps.map((a) => ({
        appid: a.appid,
        status: "ok",
        updatecheck:
          (a.status ?? "ok") === "ok"
            ? {
                status: "ok",
                urls: { url: [{ codebase: a.codebase ?? `https://exemple.invalid/${a.appid}.crx` }] },
                manifest: { version: a.version, packages: { package: [{ name: `${a.appid}.crx` }] } },
              }
            : { status: a.status },
      })),
    },
  });

afterEach(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  appels = [];
  requetes = 0;
});

test("comparerVersions : nombres par nombres, morceaux manquants à zéro", () => {
  expect(comparerVersions("1.0.0", "1.0.1")).toBeLessThan(0);
  expect(comparerVersions("1.10", "1.9")).toBeGreaterThan(0);
  expect(comparerVersions("2", "2.0.0.0")).toBe(0);
  expect(comparerVersions("1.2.3.4", "1.2.3")).toBeGreaterThan(0);
});

test("chercherMisesAJour : la requête JSON Omaha, et seulement les versions plus récentes", async () => {
  const a = "a".repeat(32);
  const b = "b".repeat(32);
  const c = "c".repeat(32);
  const f = fauxFetch(() => ({
    texte: omaha([
      { appid: a, version: "1.0.1", codebase: "https://x.invalid/a.crx" },
      { appid: b, version: "2.0.0" },
      { appid: c, status: "noupdate" },
    ]),
  }));
  const r = await chercherMisesAJour(
    [
      { id: a, version: "1.0.0" },
      { id: b, version: "2.0.0" },
      { id: c, version: "1.0.0" },
    ],
    { fetch: f },
  );
  expect(r).toEqual([{ id: a, version: "1.0.1", url: "https://x.invalid/a.crx" }]);
  expect(appels).toHaveLength(1);
  expect(appels[0]!.url).toBe(URL_MISES_A_JOUR);
  expect(appels[0]!.init.method).toBe("POST");
  const corps = JSON.parse(String(appels[0]!.init.body));
  expect(corps.request.app.map((x: { appid: string }) => x.appid)).toEqual([a, b, c]);
  expect(corps.request.acceptformat).toBe("crx3");
  expect(corps.request.protocol).toBe("3.1");
});

test("chercherMisesAJour : version égale ou plus ancienne : ignorée", async () => {
  const a = "a".repeat(32);
  const f = fauxFetch(() => ({ texte: omaha([{ appid: a, version: "0.9.0" }]) }));
  expect(await chercherMisesAJour([{ id: a, version: "1.0.0" }], { fetch: f })).toEqual([]);
  const egale = fauxFetch(() => ({ texte: omaha([{ appid: a, version: "1.0.0" }]) }));
  expect(await chercherMisesAJour([{ id: a, version: "1.0.0" }], { fetch: egale })).toEqual([]);
});

test("chercherMisesAJour : réponse sans préfixe )]}' : aucune mise à jour", async () => {
  const a = "a".repeat(32);
  const journal = vi.spyOn(console, "error").mockImplementation(() => {});
  const f = fauxFetch(() => ({ texte: omaha([{ appid: a, version: "9.0.0" }]).slice(PREFIXE.length) }));
  expect(await chercherMisesAJour([{ id: a, version: "1.0.0" }], { fetch: f })).toEqual([]);
  expect(journal).toHaveBeenCalled();
  journal.mockRestore();
});

test("chercherMisesAJour : toute erreur (HTTP, réseau, JSON, forme, id inconnu) → [] journalisé ; aucune entrée → aucune requête", async () => {
  const a = "a".repeat(32);
  const journal = vi.spyOn(console, "error").mockImplementation(() => {});
  const entrees = [{ id: a, version: "1.0.0" }];
  expect(await chercherMisesAJour(entrees, { fetch: fauxFetch(() => ({ statut: 500, texte: omaha([{ appid: a, version: "2.0.0" }]) })) })).toEqual([]);
  expect(
    await chercherMisesAJour(entrees, {
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    }),
  ).toEqual([]);
  expect(await chercherMisesAJour(entrees, { fetch: fauxFetch(() => ({ texte: `${PREFIXE}{pas du json` })) })).toEqual([]);
  expect(await chercherMisesAJour(entrees, { fetch: fauxFetch(() => ({ texte: `${PREFIXE}{"response":{"app":[{"appid":"${a}","updatecheck":{"status":"ok"}}]}}` })) })).toEqual([]);
  // Un id qu'on n'a pas demandé n'est jamais rendu.
  expect(await chercherMisesAJour(entrees, { fetch: fauxFetch(() => ({ texte: omaha([{ appid: "b".repeat(32), version: "2.0.0" }]) })) })).toEqual([]);
  expect(journal).toHaveBeenCalled();
  journal.mockRestore();
  appels = [];
  expect(await chercherMisesAJour([], { fetch: fauxFetch(() => ({ texte: omaha([]) })) })).toEqual([]);
  expect(appels).toEqual([]);
});

test("chercherMisesAJour : WEBAIOS_TEST_STORE_MAJ_URL remplace l'adresse, en mode invisible seulement", async () => {
  const a = "a".repeat(32);
  const f = fauxFetch(() => ({ texte: omaha([]) }));
  vi.stubEnv("WEBAIOS_TEST_STORE_MAJ_URL", "http://127.0.0.1:9/maj");
  vi.stubEnv("WEBAIOS_INVISIBLE", "");
  await chercherMisesAJour([{ id: a, version: "1.0.0" }], { fetch: f });
  vi.stubEnv("WEBAIOS_INVISIBLE", "1");
  await chercherMisesAJour([{ id: a, version: "1.0.0" }], { fetch: f });
  expect(appels.map((x) => x.url)).toEqual([URL_MISES_A_JOUR, "http://127.0.0.1:9/maj"]);
  expect(INTERVALLE_MAJ_MS).toBe(5 * 3600_000);
});

// ——— appliquerMiseAJour ———

let dossier: string;
let etat: EtatExtensions;
let modifications: number;
let preparees: string[];
let erreurs: Map<string, string>;
/** Ce que rendent les sessions après la dernière écriture : l'erreur d'un chargement raté, ou null. */
let rate: (cle: string) => string | null;
let essais: string[];

beforeEach(() => {
  dossier = temporaire("webaios-maj-dossier-");
  etat = { version: 1, toutesCoupees: false, extensions: {} };
  modifications = 0;
  preparees = [];
  erreurs = new Map();
  rate = () => null;
  essais = [];
});

const dependances = () => ({
  dossier,
  etatExtensions: () => etat,
  modifier: async (changer: (e: EtatExtensions, p: ReadonlySet<IdProfil>) => EtatExtensions) => {
    modifications++;
    return (etat = changer(etat, new Set()));
  },
  preparer: async (cle: string, chemin: string) => void preparees.push(`${cle}:${chemin}`),
  noterErreur: (cle: string, erreur: string | null) => void (erreur === null ? erreurs.delete(cle) : erreurs.set(cle, erreur)),
  chargementRate: (cle: string) => rate(cle),
  sansPlantage: async <T>(cle: string, f: () => Promise<T>) => {
    essais.push(cle);
    return f();
  },
});

/** Version 1.0.0 installée (dossier sous store/, registre), accord = sa portée, active dans « defaut ». */
function installer(cle: KeyObject, manifeste: Record<string, unknown> = {}): { id: string; ancienne: string } {
  const { id } = publier(cle, { version: "1.0.0", ...manifeste });
  // Les fichiers d'une version installée : le manifeste suffit ici.
  const ancienne = join(dossier, "store", id, "1.0.0_0");
  mkdirSync(ancienne, { recursive: true });
  writeFileSync(join(ancienne, "manifest.json"), JSON.stringify({ ...MANIFESTE, ...manifeste, version: "1.0.0" }));
  const analyse = analyserManifeste({ ...MANIFESTE, ...manifeste, version: "1.0.0" }, { source: "store" });
  const entree: EntreeExtension = {
    source: "store",
    idChrome: id,
    nom: analyse.nom,
    version: "1.0.0",
    accord: analyse.portee,
    profils: ["defaut"],
    epinglee: true,
    modifieeLe: null,
    desactivee: null,
    majEnAttente: null,
    vues: { defaut: "1.0.0" },
  };
  etat = { ...etat, extensions: { ...etat.extensions, [`store:${id}`]: entree } };
  return { id, ancienne };
}

const contenu = (d: string) => (existsSync(d) ? readdirSync(d) : []);
const nouvelleCle = () => generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;

test("même portée : appliquée, ancienne version effacée", async () => {
  const cle = nouvelleCle();
  const { id, ancienne } = installer(cle);
  const { url } = publier(cle, { version: "1.1.0" });
  erreurs.set(`store:${id}`, "une erreur d'avant");
  expect(await appliquerMiseAJour({ id, version: "1.1.0", url }, dependances())).toBe("appliquee");
  const nouvelle = join(dossier, "store", id, "1.1.0_0");
  expect(existsSync(join(nouvelle, "manifest.json"))).toBe(true);
  expect(existsSync(ancienne)).toBe(false);
  expect(contenu(join(dossier, "store", id))).toEqual(["1.1.0_0"]);
  expect(contenu(join(dossier, "store-attente"))).toEqual([]);
  expect(preparees).toEqual([`store:${id}:${nouvelle}`]);
  const x = etat.extensions[`store:${id}`]!;
  // Registre : la nouvelle version (les sessions la rechargent sur cette écriture), le reste gardé.
  expect(x).toMatchObject({ version: "1.1.0", profils: ["defaut"], epinglee: true, majEnAttente: null, desactivee: null });
  expect(modifications).toBe(1);
  expect(erreurs.has(`store:${id}`)).toBe(false);
});

test("un hôte de plus : en attente, l'ancienne reste dans le registre", async () => {
  const cle = nouvelleCle();
  const { id, ancienne } = installer(cle);
  const accordAvant = etat.extensions[`store:${id}`]!.accord;
  const { url } = publier(cle, { version: "2.0.0", host_permissions: ["https://a.exemple/*", "https://b.exemple/*"] });
  expect(await appliquerMiseAJour({ id, version: "2.0.0", url }, dependances())).toBe("en-attente");
  const x = etat.extensions[`store:${id}`]!;
  expect(x.version).toBe("1.0.0");
  expect(x.accord).toEqual(accordAvant);
  expect(x.profils).toEqual(["defaut"]);
  const attente = join(dossier, "store", id, "2.0.0_0");
  expect(x.majEnAttente).toMatchObject({ version: "2.0.0", chemin: attente });
  expect(x.majEnAttente!.portee.hotes).toEqual(["https://a.exemple/*", "https://b.exemple/*"]);
  // L'ancienne version reste sur le disque (chargée) ; la nouvelle attend, préparée.
  expect(existsSync(join(ancienne, "manifest.json"))).toBe(true);
  expect(existsSync(join(attente, "manifest.json"))).toBe(true);
  expect(preparees).toEqual([`store:${id}:${attente}`]);
  expect(contenu(join(dossier, "store-attente"))).toEqual([]);

  // La même version proposée de nouveau : rien n'est retéléchargé, elle reste en attente.
  const avant = requetes;
  expect(await appliquerMiseAJour({ id, version: "2.0.0", url }, dependances())).toBe("en-attente");
  expect(requetes).toBe(avant);

  // Une version suivante qui ne demande pas plus que l'accord : appliquée, l'attente abandonnée et effacée.
  const { url: url3 } = publier(cle, { version: "3.0.0" });
  expect(await appliquerMiseAJour({ id, version: "3.0.0", url: url3 }, dependances())).toBe("appliquee");
  expect(etat.extensions[`store:${id}`]).toMatchObject({ version: "3.0.0", majEnAttente: null });
  expect(contenu(join(dossier, "store", id))).toEqual(["3.0.0_0"]);
});

test("des scripts de contenu en plus (scripts faux → vrai) : en attente", async () => {
  const cle = nouvelleCle();
  const { id } = installer(cle);
  const { url } = publier(cle, { version: "1.2.0", content_scripts: [{ matches: ["https://a.exemple/*"], js: ["a.js"] }] });
  expect(await appliquerMiseAJour({ id, version: "1.2.0", url }, dependances())).toBe("en-attente");
  expect(etat.extensions[`store:${id}`]!.version).toBe("1.0.0");
});

test("téléchargement en échec : rien ne change, erreur gardée, aucun dossier laissé dans store-attente", async () => {
  const cle = nouvelleCle();
  const { id, ancienne } = installer(cle);
  const avant = JSON.stringify(etat);
  const journal = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await appliquerMiseAJour({ id, version: "1.1.0", url: "http://127.0.0.1:1/x.crx" }, dependances())).toBe("echec");
  expect(erreurs.get(`store:${id}`)).toContain(ERREUR_STORE);

  // CRX mal signé : refusé de même.
  const { url } = publier(cle, { version: "1.1.0" }, { signatureFausse: true });
  expect(await appliquerMiseAJour({ id, version: "1.1.0", url }, dependances())).toBe("echec");
  expect(erreurs.get(`store:${id}`)).toContain(CRX_INVALIDE);
  journal.mockRestore();

  expect(JSON.stringify(etat)).toBe(avant);
  expect(modifications).toBe(0);
  expect(contenu(join(dossier, "store-attente"))).toEqual([]);
  expect(contenu(join(dossier, "store", id))).toEqual(["1.0.0_0"]);
  expect(readFileSync(join(ancienne, "manifest.json"), "utf8")).toContain("1.0.0");
});

test("préparation en échec : rien ne change, la version téléchargée ne reste pas", async () => {
  const cle = nouvelleCle();
  const { id } = installer(cle);
  const { url } = publier(cle, { version: "1.1.0" });
  const d = {
    ...dependances(),
    preparer: async () => {
      throw new Error("disque plein");
    },
  };
  const journal = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await appliquerMiseAJour({ id, version: "1.1.0", url }, d)).toBe("echec");
  journal.mockRestore();
  expect(erreurs.get(`store:${id}`)).toContain("disque plein");
  expect(etat.extensions[`store:${id}`]!.version).toBe("1.0.0");
  expect(contenu(join(dossier, "store", id))).toEqual(["1.0.0_0"]);
  expect(contenu(join(dossier, "store-attente"))).toEqual([]);
});

test("pendant la coupure générale : les fichiers sont remplacés, la coupure reste (rien n'est chargé)", async () => {
  const cle = nouvelleCle();
  const { id, ancienne } = installer(cle);
  etat = { ...etat, toutesCoupees: true };
  const { url } = publier(cle, { version: "1.1.0" });
  expect(await appliquerMiseAJour({ id, version: "1.1.0", url }, dependances())).toBe("appliquee");
  expect(etat.toutesCoupees).toBe(true);
  expect(etat.extensions[`store:${id}`]!.version).toBe("1.1.0");
  expect(existsSync(ancienne)).toBe(false);
});

test("une extension désinstallée entre-temps, ou déjà à jour : rien n'est téléchargé", async () => {
  const cle = nouvelleCle();
  const { id } = installer(cle);
  const { url } = publier(cle, { version: "1.0.0" });
  expect(await appliquerMiseAJour({ id, version: "1.0.0", url }, dependances())).toBe("echec");
  expect(await appliquerMiseAJour({ id: "d".repeat(32), version: "2.0.0", url }, dependances())).toBe("echec");
  expect(requetes).toBe(0);
  expect(erreurs.size).toBe(0);
});

test("le CRX n'a pas la version annoncée : refusée, rien ne change (ni plus haute, ni plus basse)", async () => {
  const cle = nouvelleCle();
  const { id } = installer(cle);
  const avant = JSON.stringify(etat);
  const journal = vi.spyOn(console, "error").mockImplementation(() => {});
  const { url } = publier(cle, { version: "1.2.0" });
  expect(await appliquerMiseAJour({ id, version: "1.1.0", url }, dependances())).toBe("echec");
  expect(erreurs.get(`store:${id}`)).toMatch(/1\.2\.0.*1\.1\.0|1\.1\.0.*1\.2\.0/);
  const { url: basse } = publier(cle, { version: "0.9.0" });
  expect(await appliquerMiseAJour({ id, version: "1.3.0", url: basse }, dependances())).toBe("echec");
  journal.mockRestore();
  expect(JSON.stringify(etat)).toBe(avant);
  expect(contenu(join(dossier, "store", id))).toEqual(["1.0.0_0"]);
  expect(contenu(join(dossier, "store-attente"))).toEqual([]);
});

test("une attente n'est jamais remplacée par une version égale ou plus basse", async () => {
  const cle = nouvelleCle();
  const { id } = installer(cle);
  const elargie = { host_permissions: ["https://a.exemple/*", "https://b.exemple/*"] };
  const { url } = publier(cle, { version: "2.0.0", ...elargie });
  expect(await appliquerMiseAJour({ id, version: "2.0.0", url }, dependances())).toBe("en-attente");
  const attente = join(dossier, "store", id, "2.0.0_0");
  const avant = requetes;
  // Plus basse que l'attente (même si plus haute que l'installée) : ni téléchargée, ni écrite.
  const { url: basse } = publier(cle, { version: "1.5.0", ...elargie });
  expect(await appliquerMiseAJour({ id, version: "1.5.0", url: basse }, dependances())).toBe("en-attente");
  expect(requetes).toBe(avant);
  expect(etat.extensions[`store:${id}`]!.majEnAttente!.version).toBe("2.0.0");
  expect(existsSync(join(attente, "manifest.json"))).toBe(true);
  expect(contenu(join(dossier, "store", id)).sort()).toEqual(["1.0.0_0", "2.0.0_0"]);
});

test("modifier lève APRÈS l'écriture du registre : la version inscrite reste sur le disque", async () => {
  const cle = nouvelleCle();
  const { id, ancienne } = installer(cle);
  const { url } = publier(cle, { version: "1.1.0" });
  const d = {
    ...dependances(),
    modifier: async (changer: (e: EtatExtensions, p: ReadonlySet<IdProfil>) => EtatExtensions) => {
      etat = changer(etat, new Set());
      throw new Error("sessions en panne");
    },
  };
  const journal = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await appliquerMiseAJour({ id, version: "1.1.0", url }, d)).toBe("appliquee");
  journal.mockRestore();
  expect(etat.extensions[`store:${id}`]!.version).toBe("1.1.0");
  expect(existsSync(join(dossier, "store", id, "1.1.0_0", "manifest.json"))).toBe(true);
  // L'ancienne peut être encore chargée (sessions non synchronisées) : elle n'est pas effacée.
  expect(existsSync(ancienne)).toBe(true);
  expect(contenu(join(dossier, "store-attente"))).toEqual([]);
});

test("l'écriture du registre elle-même échoue : rien ne reste, rien ne change", async () => {
  const cle = nouvelleCle();
  const { id } = installer(cle);
  const { url } = publier(cle, { version: "1.1.0" });
  const avant = JSON.stringify(etat);
  const d = {
    ...dependances(),
    modifier: async () => {
      throw new Error("disque plein");
    },
  };
  const journal = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await appliquerMiseAJour({ id, version: "1.1.0", url }, d)).toBe("echec");
  journal.mockRestore();
  expect(JSON.stringify(etat)).toBe(avant);
  expect(erreurs.get(`store:${id}`)).toContain("disque plein");
  expect(contenu(join(dossier, "store", id))).toEqual(["1.0.0_0"]);
});

test("I6 la nouvelle version ne se charge pas : l'ancienne est rechargée et gardée, la mise à jour reste en attente avec l'erreur, sans plantage compté", async () => {
  const cle = nouvelleCle();
  const { id, ancienne } = installer(cle);
  const { url } = publier(cle, { version: "1.1.0" });
  const k = `store:${id}`;
  // Les sessions ratent la 1.1.0 (et chargent la 1.0.0).
  rate = (c) => (c === k && etat.extensions[k]?.version === "1.1.0" ? "Manifest invalide" : null);
  expect(await appliquerMiseAJour({ id, version: "1.1.0", url }, dependances())).toBe("en-attente");
  const x = etat.extensions[k]!;
  expect(x.version).toBe("1.0.0");
  expect(x.majEnAttente?.version).toBe("1.1.0");
  expect(existsSync(join(ancienne, "manifest.json"))).toBe(true);
  expect(existsSync(join(dossier, "store", id, "1.1.0_0", "manifest.json"))).toBe(true);
  expect(erreurs.get(k)).toBe("Mise à jour 1.1.0 non chargée (la version 1.0.0 reste) : Manifest invalide");
  expect(essais).toEqual([k]);
  expect(modifications).toBe(2);
  // La vérification suivante ne la retélécharge pas et ne réécrit rien.
  expect(await appliquerMiseAJour({ id, version: "1.1.0", url }, dependances())).toBe("en-attente");
  expect(modifications).toBe(2);
});

test("I6 acceptée depuis l'attente, elle ne se charge pas : l'ancienne version et son accord reviennent", async () => {
  const cle = nouvelleCle();
  const { id, ancienne } = installer(cle);
  const { url } = publier(cle, { version: "1.1.0", host_permissions: ["https://exemple.com/*"] });
  const k = `store:${id}`;
  expect(await appliquerMiseAJour({ id, version: "1.1.0", url }, dependances())).toBe("en-attente");
  const accordAvant = etat.extensions[k]!.accord;
  const m = etat.extensions[k]!.majEnAttente!;
  rate = (c) => (c === k && etat.extensions[k]?.version === "1.1.0" ? "Manifest invalide" : null);
  expect(await accepterMiseAJour(k, { version: "1.1.0", nom: etat.extensions[k]!.nom, portee: m.portee }, dependances())).toBe("en-attente");
  const x = etat.extensions[k]!;
  expect(x.version).toBe("1.0.0");
  expect(x.accord).toEqual(accordAvant);
  expect(x.majEnAttente?.version).toBe("1.1.0");
  expect(existsSync(join(ancienne, "manifest.json"))).toBe(true);
  expect(erreurs.get(k)).toContain("non chargée");
});
