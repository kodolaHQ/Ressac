import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { construireCrx } from "../../e2e/extensions/crx";
import type { EtatExtensions } from "@webaios/noyau";
import type { EtatNavigateur } from "../../src/commun/modele";

vi.mock("electron", () => ({ app: { on: () => {} }, session: {} }));
vi.mock("electron-chrome-extensions", () => ({ ElectronChromeExtensions: class {} }));

const { ServiceExtensions } = await import("../../src/main/extensions/service");

const temporaires: string[] = [];
afterAll(() => {
  for (const d of temporaires) rmSync(d, { recursive: true, force: true });
});

const ID = "c".repeat(32);
const accord = { permissions: [], hotes: [], reseau: [], tousLesSites: false, scriptsTousLesSites: false };
const entree = (source: "store" | "agent", profils: string[]) => ({
  source,
  idChrome: null,
  nom: "essai",
  version: "1.0.0",
  accord,
  profils,
  epinglee: false,
  modifieeLe: null,
  desactivee: null,
  majEnAttente: null,
  vues: {},
});

let dossier: string;
let gardes: string;
let synchronisees: EtatExtensions[];
let branchees: string[];
let retraitsPrives: EtatNavigateur[];
let abonnes: ((e: EtatNavigateur) => void)[];
let nav: EtatNavigateur;
/** Appels à `profils.effacerStockage` : le dossier, ce qu'il contenait alors, les sessions. */
let effacements: { chemin: string; manifeste: unknown; sessions: unknown[]; registre: EtatExtensions }[];
let effacementEchoue: boolean;
/** Plan 16 : ce que le service fait aux applis de site (`brancherSite`, les synchronisations, l'attente du démarrage). */
let journal: string[];
let chargeesSite: Map<string, { cle: string; id: string }[]>;
let attentes: [string, string, number][];
let nomsSites: Record<string, string>;
/** Tenue (non nulle) : chaque synchronisation l'attend (M1 : le démarrage du service reste ouvert). */
let synchroTenue: Promise<void> | null;
/** Ce que rend le faux `attendreDemarrage` (par défaut : vrai tout de suite). */
let reponseDemarrage: () => Promise<boolean>;

const etatNav = (prive: boolean) =>
  ({ espaces: [{ id: "e1", profil: "defaut", prive }], profils: [{ id: "defaut" }], fenetres: [], onglets: {} }) as unknown as EtatNavigateur;

function demarrer(avecAgent = false, avant?: (s: InstanceType<typeof ServiceExtensions>) => void) {
  const service = new ServiceExtensions();
  avant?.(service);
  const magasin = { get etat() { return nav; }, abonner: (f: (e: EtatNavigateur) => void) => void abonnes.push(f) };
  const profils = {
    synchroniser: async (e: EtatExtensions) => {
      if (synchroTenue) await synchroTenue;
      synchronisees.push(e);
      journal.push("synchro");
    },
    brancherSite: (id: string, s: unknown) => void journal.push(`brancher:${id}:${(s as { session: string }).session}`),
    chargeesProfil: (p: string) => chargeesSite.get(p) ?? [],
    attendreDemarrage: (portee: string, cle: string, ms: number) => {
      attentes.push([portee, cle, ms]);
      return reponseDemarrage();
    },
    erreursChargement: () => new Map<string, string>(),
    retirerAgentsPrives: (e: EtatNavigateur) => void retraitsPrives.push(e),
    effacerStockage: async (chemin: string, sessions: unknown[]) => {
      effacements.push({
        chemin,
        manifeste: JSON.parse(readFileSync(join(chemin, "manifest.json"), "utf8")),
        sessions,
        registre: JSON.parse(readFileSync(join(dossier, "etat.json"), "utf8")),
      });
      if (effacementEchoue) throw new Error("échec simulé");
    },
  };
  const sessions = {
    session: (id: string) => {
      branchees.push(id);
      return { session: id };
    },
  };
  return {
    service,
    pret: service.demarrer({
      dossier,
      dossierGardes: gardes,
      ...(avecAgent ? { dossierAgent: join(dossier, "agent") } : {}),
      magasin,
      profils,
      sessions,
      vues: {},
      sessionSite: (id: string) => ({ session: `persist:site-${id}` }),
      nomsSites: async () => nomsSites,
    } as never),
  };
}

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "webaios-ext-service-"));
  temporaires.push(dossier);
  gardes = join(dossier, "gardes");
  mkdirSync(gardes);
  writeFileSync(join(gardes, "webaios-correctifs-page.js"), "// correctifs\n");
  writeFileSync(join(gardes, "webaios-garde-page.js"), "// garde\n");
  writeFileSync(join(gardes, "webaios-garde-fond.js"), "// garde\n");
  synchronisees = [];
  branchees = [];
  retraitsPrives = [];
  abonnes = [];
  nav = etatNav(false);
  effacements = [];
  effacementEchoue = false;
  journal = [];
  chargeesSite = new Map();
  attentes = [];
  nomsSites = {};
  synchroTenue = null;
  reponseDemarrage = async () => true;
});

test("registre illisible : aucune extension chargée, et le démarrage ne lève pas", async () => {
  mkdirSync(join(dossier, "etat.json")); // un dossier à la place du fichier : EISDIR, pas ENOENT
  const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(demarrer().pret).resolves.toBeUndefined();
  expect(synchronisees).toEqual([]);
  expect(branchees).toEqual([]);
  expect(erreur).toHaveBeenCalled();
  erreur.mockRestore();
});

test("démarrage : le Store préparé est chargé, celui dont la préparation échoue ne l'est pas et garde son erreur", async () => {
  const version = join(dossier, "store", ID, "1.0.0_0");
  mkdirSync(version, { recursive: true });
  writeFileSync(join(version, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "x", version: "1.0.0", content_scripts: [{ matches: ["<all_urls>"], js: ["a.js"] }] }));
  writeFileSync(
    join(dossier, "etat.json"),
    JSON.stringify({ version: 1, toutesCoupees: false, extensions: { [`store:${ID}`]: entree("store", ["defaut"]), [`store:${"d".repeat(32)}`]: entree("store", ["defaut"]), "agent:essai": entree("agent", ["defaut"]) } }),
  );
  const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
  const { service, pret } = demarrer();
  await pret;
  erreur.mockRestore();
  expect(Object.keys(synchronisees.at(-1)!.extensions).sort()).toEqual(["agent:essai", `store:${ID}`]);
  expect(service.erreurs().get(`store:${"d".repeat(32)}`)).toMatch(/ENOENT/);
  // La session du profil où une extension est active est branchée tout de suite.
  expect(branchees).toContain("defaut");
});

test("un espace qui devient privé relance la synchronisation ; un changement sans effet sur les profils, non", async () => {
  writeFileSync(join(dossier, "etat.json"), JSON.stringify({ version: 1, toutesCoupees: false, extensions: { "agent:essai": entree("agent", ["defaut"]) } }));
  await demarrer().pret;
  expect(synchronisees).toHaveLength(1);
  for (const f of abonnes) f(nav);
  expect(synchronisees).toHaveLength(1);
  nav = etatNav(true);
  for (const f of abonnes) f(nav);
  // Le retrait des extensions de l'agent est fait tout de suite, dans l'abonné, avant la synchronisation en file.
  expect(retraitsPrives).toEqual([nav]);
  await vi.waitFor(() => expect(synchronisees).toHaveLength(2));
});

test("registre illisible : l'abonnement aux profils privés est quand même posé", async () => {
  mkdirSync(join(dossier, "etat.json"));
  const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
  await demarrer().pret;
  erreur.mockRestore();
  expect(abonnes).toHaveLength(1);
  nav = etatNav(true);
  for (const f of abonnes) f(nav);
  expect(retraitsPrives).toEqual([nav]);
});

test("noterVue : la première fois d'une version dans un profil, elle est écrite au registre ; ensuite, rien de nouveau", async () => {
  writeFileSync(join(dossier, "etat.json"), JSON.stringify({ version: 1, toutesCoupees: false, extensions: { "agent:essai": entree("agent", ["defaut"]) } }));
  nav = { ...etatNav(false), profils: [{ id: "defaut" }, { id: "autre" }] } as unknown as EtatNavigateur;
  const { service, pret } = demarrer();
  await pret;
  const syncAvant = synchronisees.length;
  expect(await service.noterVue("agent:essai", "defaut", "1.0.0")).toEqual({ nouvelle: true });
  expect(await service.noterVue("agent:essai", "defaut", "1.0.0")).toEqual({ nouvelle: false });
  expect(await service.noterVue("agent:essai", "defaut", "1.1.0")).toEqual({ nouvelle: true, precedente: "1.0.0" });
  // Chaque profil a sa propre vue.
  expect(await service.noterVue("agent:essai", "autre", "1.1.0")).toEqual({ nouvelle: true });
  const lu = JSON.parse(readFileSync(join(dossier, "etat.json"), "utf8"));
  expect(lu.extensions["agent:essai"].vues).toEqual({ defaut: "1.1.0", autre: "1.1.0" });
  expect(service.etatExtensions().extensions["agent:essai"]!.vues).toEqual({ defaut: "1.1.0", autre: "1.1.0" });
  // Rien à recharger : les vues ne changent pas ce qui est chargé.
  expect(synchronisees).toHaveLength(syncAvant);
  // Une clé inconnue n'est jamais « nouvelle » (et rien n'est écrit pour elle).
  expect(await service.noterVue("agent:inconnue", "defaut", "1.0.0")).toEqual({ nouvelle: false });
});

test("noterVue : une version déjà vue n'écrit pas etat.json", async () => {
  writeFileSync(join(dossier, "etat.json"), JSON.stringify({ version: 1, toutesCoupees: false, extensions: { "agent:essai": entree("agent", ["defaut"]) } }));
  const { service, pret } = demarrer();
  await pret;
  expect(await service.noterVue("agent:essai", "defaut", "1.0.0")).toEqual({ nouvelle: true });
  // Le fichier retiré : une écriture le recréerait.
  rmSync(join(dossier, "etat.json"));
  expect(await service.noterVue("agent:essai", "defaut", "1.0.0")).toEqual({ nouvelle: false });
  expect(existsSync(join(dossier, "etat.json"))).toBe(false);
});

/** Une extension du Store installée (dossier, registre) active dans `profils`, plus une extension de l'agent. */
async function storeInstalle(profils: string[]) {
  const version = join(dossier, "store", ID, "1.0.0_0");
  mkdirSync(version, { recursive: true });
  writeFileSync(join(version, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "x", version: "1.0.0" }));
  writeFileSync(
    join(dossier, "etat.json"),
    JSON.stringify({ version: 1, toutesCoupees: false, extensions: { [`store:${ID}`]: entree("store", profils), "agent:essai": entree("agent", ["defaut"]) } }),
  );
  const { service, pret } = demarrer();
  await pret;
  const registre = () => JSON.parse(readFileSync(join(dossier, "etat.json"), "utf8")).extensions as Record<string, { profils: string[] }>;
  return { service, version, registre };
}

test("« Retirer de Chrome » sur la page du Store d'un profil : un autre profil la garde → retirée de ce profil seulement, fichiers gardés, toujours chargée ailleurs", async () => {
  nav = { ...nav, espaces: [...nav.espaces, { id: "e2", profil: "travail", prive: false }], profils: [{ id: "defaut" }, { id: "travail" }] } as unknown as EtatNavigateur;
  const { service, version, registre } = await storeInstalle(["defaut", "travail"]);
  await service.desinstallerDepuisStore(ID, "defaut");
  expect(registre()[`store:${ID}`]!.profils).toEqual(["travail"]);
  expect(existsSync(version)).toBe(true);
  expect(synchronisees.at(-1)!.extensions[`store:${ID}`]!.profils).toEqual(["travail"]);
});

test("« Retirer de Chrome » depuis le dernier profil qui la garde : désinstallation complète (registre et dossier)", async () => {
  const { service, registre } = await storeInstalle(["defaut"]);
  await service.desinstallerDepuisStore(ID, "defaut");
  expect(Object.keys(registre())).toEqual(["agent:essai"]);
  expect(Object.keys(synchronisees.at(-1)!.extensions)).toEqual(["agent:essai"]);
  expect(existsSync(join(dossier, "store", ID))).toBe(false);
});

test("« Retirer de Chrome » dans un profil où elle n'est pas active, ou pour une extension inconnue ou de l'agent : refusé, rien ne change", async () => {
  const { service, version } = await storeInstalle(["travail"]);
  const avant = readFileSync(join(dossier, "etat.json"), "utf8");
  await expect(service.desinstallerDepuisStore(ID, "defaut")).rejects.toThrow(/pas active/);
  await expect(service.desinstallerDepuisStore("d".repeat(32), "defaut")).rejects.toThrow(/inconnue/);
  await expect(service.desinstallerDepuisStore("essai", "defaut")).rejects.toThrow(/inconnue/);
  expect(readFileSync(join(dossier, "etat.json"), "utf8")).toBe(avant);
  expect(existsSync(version)).toBe(true);
});

// ——— Mises à jour du Store ———

/** Une extension du Store en 1.0.0 (un hôte), avec une 2.0.0 en attente qui demande un hôte de plus. */
async function majEnAttente(o: { questions?: (repondre: (d: "autoriser" | "refuser") => void, champs: unknown) => void } = {}) {
  const manifeste = (version: string, hotes: string[]) => ({ manifest_version: 3, name: "x", version, host_permissions: hotes });
  const ancienne = join(dossier, "store", ID, "1.0.0_0");
  const attente = join(dossier, "store", ID, "2.0.0_0");
  for (const [d, v, h] of [
    [ancienne, "1.0.0", ["https://a.exemple/*"]],
    [attente, "2.0.0", ["https://a.exemple/*", "https://b.exemple/*"]],
  ] as const) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "manifest.json"), JSON.stringify(manifeste(v, [...h])));
  }
  const portee = (hotes: string[]) => ({ permissions: [], hotes, reseau: [], tousLesSites: false, scriptsTousLesSites: false, scripts: false });
  writeFileSync(
    join(dossier, "etat.json"),
    JSON.stringify({
      version: 1,
      toutesCoupees: false,
      extensions: {
        [`store:${ID}`]: {
          ...entree("store", ["defaut"]),
          idChrome: ID,
          accord: portee(["https://a.exemple/*"]),
          majEnAttente: { version: "2.0.0", portee: portee(["https://a.exemple/*", "https://b.exemple/*"]), chemin: attente },
        },
      },
    }),
  );
  nav = { ...nav, fenetres: [{ id: "f1", espaceActif: "e1" }] } as unknown as EtatNavigateur;
  const { service, pret } = demarrer();
  await pret;
  const cartes: unknown[] = [];
  service.brancherQuestions((champs, repondre) => {
    cartes.push(champs);
    o.questions?.(repondre, champs);
    return () => {};
  });
  const registre = () => JSON.parse(readFileSync(join(dossier, "etat.json"), "utf8")).extensions[`store:${ID}`];
  return { service, ancienne, attente, cartes, registre };
}

test("revoirMiseAJour : la carte montre la mise à jour (de 1.0.0) ; acceptée, elle est appliquée et l'ancienne version effacée", async () => {
  const { service, ancienne, attente, cartes, registre } = await majEnAttente({ questions: (repondre) => repondre("autoriser") });
  expect(await service.revoirMiseAJour(`store:${ID}`, "f1")).toBe("appliquee");
  expect(cartes).toHaveLength(1);
  expect(cartes[0]).toMatchObject({ fenetreId: "f1", extension: { cle: `store:${ID}`, version: "2.0.0", maj: { de: "1.0.0" }, espaceId: "e1" } });
  expect(registre()).toMatchObject({ version: "2.0.0", majEnAttente: null, profils: ["defaut"] });
  expect(registre().accord.hotes).toEqual(["https://a.exemple/*", "https://b.exemple/*"]);
  expect(existsSync(ancienne)).toBe(false);
  expect(existsSync(join(attente, "manifest.json"))).toBe(true);
  // Les sessions reçoivent la nouvelle version.
  expect(synchronisees.at(-1)!.extensions[`store:${ID}`]!.version).toBe("2.0.0");
});

test("revoirMiseAJour : refusée, elle reste en attente et l'ancienne version reste chargée", async () => {
  const { service, ancienne, attente, registre } = await majEnAttente({ questions: (repondre) => repondre("refuser") });
  const avant = readFileSync(join(dossier, "etat.json"), "utf8");
  expect(await service.revoirMiseAJour(`store:${ID}`, "f1")).toBe("en-attente");
  expect(readFileSync(join(dossier, "etat.json"), "utf8")).toBe(avant);
  expect(registre()).toMatchObject({ version: "1.0.0", majEnAttente: { version: "2.0.0" } });
  expect(existsSync(ancienne)).toBe(true);
  expect(existsSync(attente)).toBe(true);
});

test("revoirMiseAJour : sans mise à jour en attente, rien n'est montré", async () => {
  const { service, cartes } = await majEnAttente();
  expect(await service.revoirMiseAJour("agent:essai", "f1")).toBe("echec");
  expect(await service.revoirMiseAJour(`store:${"d".repeat(32)}`, "f1")).toBe("echec");
  expect(cartes).toEqual([]);
});

test("verifierMisesAJour : un téléchargement en échec garde son erreur dans la table du service, rien ne change", async () => {
  const { service, registre } = await storeInstalle(["defaut"]);
  const avant = registre();
  const fauxFetch = (async () =>
    new Response(
      `)]}'\n${JSON.stringify({ response: { app: [{ appid: ID, updatecheck: { status: "ok", urls: { url: [{ codebase: "http://127.0.0.1:1/x.crx" }] }, manifest: { version: "1.1.0" } } }] } })}`,
    )) as typeof fetch;
  const journal = vi.spyOn(console, "error").mockImplementation(() => {});
  await service.verifierMisesAJour({ fetch: fauxFetch });
  journal.mockRestore();
  expect(service.erreurs().get(`store:${ID}`)).toMatch(/Chrome Web Store/);
  expect(registre()).toEqual(avant);
  expect(existsSync(join(dossier, "store-attente", ID))).toBe(false);
});

test("revoirMiseAJour : une attente qui ne correspond plus au disque est abandonnée (dossier et majEnAttente), pour être téléchargée de nouveau", async () => {
  const { service, attente, cartes, registre } = await majEnAttente({ questions: (repondre) => repondre("autoriser") });
  // Le manifeste en attente ne demande plus la même portée que celle inscrite.
  writeFileSync(join(attente, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "x", version: "2.0.0", host_permissions: ["https://c.exemple/*"] }));
  expect(await service.revoirMiseAJour(`store:${ID}`, "f1")).toBe("echec");
  expect(cartes).toEqual([]);
  expect(registre()).toMatchObject({ version: "1.0.0", majEnAttente: null });
  expect(existsSync(attente)).toBe(false);
  expect(existsSync(join(dossier, "store", ID, "1.0.0_0", "manifest.json"))).toBe(true);
  expect(service.erreurs().get(`store:${ID}`)).toMatch(/téléchargée de nouveau/);
});

test("désinstallée : son erreur de mise à jour disparaît", async () => {
  const { service } = await storeInstalle(["defaut"]);
  const fauxFetch = (async () =>
    new Response(
      `)]}'\n${JSON.stringify({ response: { app: [{ appid: ID, updatecheck: { status: "ok", urls: { url: [{ codebase: "http://127.0.0.1:1/x.crx" }] }, manifest: { version: "1.1.0" } } }] } })}`,
    )) as typeof fetch;
  const journal = vi.spyOn(console, "error").mockImplementation(() => {});
  await service.verifierMisesAJour({ fetch: fauxFetch });
  journal.mockRestore();
  expect(service.erreurs().has(`store:${ID}`)).toBe(true);
  await service.desinstaller(`store:${ID}`);
  expect(service.erreurs().has(`store:${ID}`)).toBe(false);
});

test("planifierMisesAJour : registre pas prêt à la première vérification → nouvel essai 60 s plus tard, puis toutes les 5 h", async () => {
  vi.useFakeTimers();
  vi.stubEnv("WEBAIOS_INVISIBLE", "");
  try {
    const service = new ServiceExtensions();
    const verifier = vi.spyOn(service, "verifierMisesAJour").mockResolvedValue();
    const arreter = service.planifierMisesAJour();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(verifier).not.toHaveBeenCalled();
    (service as unknown as { pret: boolean }).pret = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(verifier).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 3600_000);
    expect(verifier).toHaveBeenCalledTimes(2);
    arreter();
    await vi.advanceTimersByTimeAsync(5 * 3600_000);
    expect(verifier).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
});

// ——— Une vraie mise à jour (CRX servi en local) quand la version installée n'a pas pu être préparée ———

const servis = new Map<string, Buffer>();
let serveur: Server;
let base: string;
beforeAll(async () => {
  serveur = createServer((req, res) => {
    const corps = servis.get(req.url ?? "");
    if (!corps) return void res.writeHead(404).end();
    res.writeHead(200).end(corps);
  });
  await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((ok) => serveur.close(() => ok()));
});
afterEach(() => {
  vi.useRealTimers();
});

/** Store en 1.0.0 dont la préparation a échoué au démarrage (manifeste absent) ; la mise à jour `version` publiée. */
async function preparationRatee(version: string, hotes: string[]) {
  const cle = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const source = mkdtempSync(join(tmpdir(), "webaios-ext-service-src-"));
  temporaires.push(source);
  writeFileSync(join(source, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "x", version, host_permissions: hotes }));
  const { crx, id } = construireCrx(source, { cle });
  servis.set(`/${id}.crx`, crx);
  mkdirSync(join(dossier, "store", id, "1.0.0_0"), { recursive: true }); // sans manifeste : préparation en échec
  const portee = { permissions: [], hotes: ["https://a.exemple/*"], reseau: [], tousLesSites: false, scriptsTousLesSites: false, scripts: false };
  writeFileSync(
    join(dossier, "etat.json"),
    JSON.stringify({ version: 1, toutesCoupees: false, extensions: { [`store:${id}`]: { ...entree("store", ["defaut"]), idChrome: id, accord: portee } } }),
  );
  const journal = vi.spyOn(console, "error").mockImplementation(() => {});
  const { service, pret } = demarrer();
  await pret;
  const fauxFetch = (async () =>
    new Response(
      `)]}'\n${JSON.stringify({ response: { app: [{ appid: id, updatecheck: { status: "ok", urls: { url: [{ codebase: `${base}/${id}.crx` }] }, manifest: { version } } }] } })}`,
    )) as typeof fetch;
  await service.verifierMisesAJour({ fetch: fauxFetch });
  journal.mockRestore();
  return { service, cle: `store:${id}` };
}

test("une mise à jour élargie, préparée, ne lève pas l'erreur de préparation de la version installée (qui reste non chargée)", async () => {
  const { service, cle } = await preparationRatee("2.0.0", ["https://a.exemple/*", "https://b.exemple/*"]);
  expect(service.etatExtensions().extensions[cle]!.majEnAttente?.version).toBe("2.0.0");
  expect(service.erreurs().get(cle)).toMatch(/ENOENT/);
  expect(synchronisees.at(-1)!.extensions[cle]).toBeUndefined();
});

test("une mise à jour appliquée, préparée, remplace la version qui n'avait pas pu l'être : chargée", async () => {
  const { service, cle } = await preparationRatee("1.1.0", ["https://a.exemple/*"]);
  expect(service.etatExtensions().extensions[cle]!.version).toBe("1.1.0");
  expect(service.erreurs().has(cle)).toBe(false);
  expect(synchronisees.at(-1)!.extensions[cle]!.version).toBe("1.1.0");
});

// ——— Tâche 15 : page Extensions, coupure générale, plantages ———

test("liste : une ligne par extension, avec droits, espaces, désactivation et « Non pris en charge »", async () => {
  const { service } = await storeInstalle(["defaut"]);
  writeFileSync(join(dossier, "store", ID, "1.0.0_0", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "x", version: "1.0.0", permissions: ["activeTab", "storage"] }));
  nav = { ...nav, espaces: [{ id: "e1", nom: "Perso", profil: "defaut", prive: false }] } as unknown as EtatNavigateur;
  const lignes = await service.liste();
  const store = lignes.find((l) => l.cle === `store:${ID}`)!;
  expect(store).toMatchObject({ source: "store", version: "1.0.0", espaces: [{ nom: "Perso", profil: "defaut" }], desactivee: null, majEnAttente: null, nonPrisEnCharge: ["activeTab"] });
  expect(lignes.map((l) => l.cle).sort()).toEqual(["agent:essai", `store:${ID}`]);
});

test("toutCouper : toutesCoupees écrit, plus rien de synchronisé ; puis rallumé", async () => {
  const { service } = await storeInstalle(["defaut"]);
  expect(await service.toutCouper(true)).toEqual({ ok: true });
  expect(JSON.parse(readFileSync(join(dossier, "etat.json"), "utf8")).toutesCoupees).toBe(true);
  expect(synchronisees.at(-1)!.toutesCoupees).toBe(true);
  expect(await service.toutCouper(false)).toEqual({ ok: true });
  expect(synchronisees.at(-1)!.toutesCoupees).toBe(false);
});

test("revoir pendant la coupure : aucune carte, la mise à jour reste en attente ; après, la carte est montrée", async () => {
  const { service, cartes, registre } = await majEnAttente({ questions: (repondre) => repondre("autoriser") });
  await service.toutCouper(true);
  const { REVOIR_PENDANT_COUPURE } = await import("../../src/main/extensions/service");
  expect(await service.revoir(`store:${ID}`, "f1")).toEqual({ ok: false, erreur: REVOIR_PENDANT_COUPURE });
  expect(cartes).toEqual([]);
  expect(registre()).toMatchObject({ version: "1.0.0", majEnAttente: { version: "2.0.0" } });
  await service.toutCouper(false);
  expect(await service.revoir(`store:${ID}`, "f1")).toEqual({ ok: true });
  expect(cartes).toHaveLength(1);
  expect(registre()).toMatchObject({ version: "2.0.0", majEnAttente: null });
});

test("revoir sans rien à revoir : refusé sans carte", async () => {
  const { service } = await storeInstalle(["defaut"]);
  const { RIEN_A_REVOIR } = await import("../../src/main/extensions/service");
  expect(await service.revoir(`store:${ID}`)).toEqual({ ok: false, erreur: RIEN_A_REVOIR });
});

test("épingler, désactiver partout : écrits au registre", async () => {
  const { service, registre } = await storeInstalle(["defaut"]);
  expect(await service.epingler(`store:${ID}`, true)).toEqual({ ok: true });
  expect((registre()[`store:${ID}`] as unknown as { epinglee: boolean }).epinglee).toBe(true);
  expect(await service.desactiverPartout(`store:${ID}`)).toEqual({ ok: true });
  expect(registre()[`store:${ID}`]!.profils).toEqual([]);
  expect(await service.epingler("store:" + "e".repeat(32), true)).toMatchObject({ ok: false });
});

test("3 plantages en une minute : désactivée partout (plantages), plus synchronisée ; « Réactiver » la relance", async () => {
  const { service, registre } = await storeInstalle(["defaut"]);
  const avertir = vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const t of [0, 1000, 2000]) service.consoles.plantage(ID, t);
  await vi.waitFor(() => expect((registre()[`store:${ID}`] as unknown as { desactivee: { raison: string } | null }).desactivee?.raison).toBe("plantages"));
  avertir.mockRestore();
  expect(synchronisees.at(-1)!.extensions[`store:${ID}`]!.desactivee?.raison).toBe("plantages");
  const ligne = (await service.liste()).find((l) => l.cle === `store:${ID}`)!;
  expect(ligne.desactivee).toBe("Désactivée : elle a planté 3 fois en une minute");
  expect(await service.reactiver(`store:${ID}`)).toEqual({ ok: true });
  expect((registre()[`store:${ID}`] as unknown as { desactivee: unknown }).desactivee).toBe(null);
});

test("supprimer une extension du Store : registre et store/<id> effacés", async () => {
  const { service, registre } = await storeInstalle(["defaut"]);
  expect(await service.supprimer(`store:${ID}`)).toEqual({ ok: true });
  expect(registre()[`store:${ID}`]).toBeUndefined();
  expect(existsSync(join(dossier, "store", ID))).toBe(false);
});

test("supprimer une extension de l'agent : entrée et copie effacées, le dossier de l'agent reste", async () => {
  const agent = join(dossier, "agent");
  mkdirSync(join(agent, "essai"), { recursive: true });
  writeFileSync(join(agent, "essai", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "essai", version: "1.0.0" }));
  mkdirSync(join(dossier, "copies", "essai"), { recursive: true });
  writeFileSync(join(dossier, "etat.json"), JSON.stringify({ version: 1, toutesCoupees: false, extensions: { "agent:essai": entree("agent", ["defaut"]) } }));
  const service = new ServiceExtensions();
  const magasin = { get etat() { return nav; }, abonner: (f: (e: EtatNavigateur) => void) => void abonnes.push(f) };
  const profils = { synchroniser: async (e: EtatExtensions) => void synchronisees.push(e), erreursChargement: () => new Map(), retirerAgentsPrives: () => {} };
  const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
  await service.demarrer({ dossier, dossierGardes: gardes, dossierAgent: agent, magasin, profils, sessions: { session: () => {} }, vues: {} } as never);
  erreur.mockRestore();
  expect(await service.supprimer("agent:essai")).toEqual({ ok: true });
  expect(JSON.parse(readFileSync(join(dossier, "etat.json"), "utf8")).extensions["agent:essai"]).toBeUndefined();
  expect(existsSync(join(dossier, "copies", "essai"))).toBe(false);
  expect(existsSync(join(agent, "essai", "manifest.json"))).toBe(true);
});

// ——— Tâche 17 : outils de l'agent, console filtrée, déblocage ———

const AGENT_ID = "e".repeat(32);

/** Une extension de l'agent `agent:essai` (id Chromium AGENT_ID) active dans « Perso », et ses outils pour l'agent. */
async function agentPourOutils(o: { reponse?: "autoriser" | "refuser"; espaces?: { id: string; nom: string; profil: string; prive: boolean }[] } = {}) {
  const version = join(dossier, "store", ID, "1.0.0_0");
  mkdirSync(version, { recursive: true });
  writeFileSync(join(version, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Bloqueur", version: "1.0.0" }));
  writeFileSync(
    join(dossier, "etat.json"),
    JSON.stringify({
      version: 1,
      toutesCoupees: false,
      extensions: {
        "agent:essai": { ...entree("agent", ["defaut"]), idChrome: AGENT_ID },
        [`store:${ID}`]: { ...entree("store", ["defaut", "secret"]), nom: "Bloqueur" },
      },
    }),
  );
  nav = {
    espaces: o.espaces ?? [
      { id: "e1", nom: "Perso", profil: "defaut", prive: false },
      { id: "e2", nom: "Banque", profil: "secret", prive: true },
    ],
    profils: [{ id: "defaut" }, { id: "secret" }],
    fenetres: [{ id: "f1", espaceActif: "e1" }],
    onglets: {},
  } as unknown as EtatNavigateur;
  mkdirSync(join(dossier, "agent", "essai"), { recursive: true });
  writeFileSync(join(dossier, "agent", "essai", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "essai", version: "1.0.0" }));
  const { service, pret } = demarrer(true);
  await pret;
  const cartes: Record<string, unknown>[] = [];
  service.brancherQuestions((champs, repondre) => {
    cartes.push(champs as Record<string, unknown>);
    setTimeout(() => repondre(o.reponse ?? "autoriser"));
    return () => {};
  });
  const outils = service.outilsAgent({ fenetreAgent: () => "f1" });
  const registre = () => JSON.parse(readFileSync(join(dossier, "etat.json"), "utf8")) as EtatExtensions;
  return { service, outils, cartes, registre };
}

test("lister pour l'agent : espaces non privés nommés, privés comptés ; erreurs de console filtrées pour l'agent, jamais celles du Store", async () => {
  const { service, outils } = await agentPourOutils();
  service.consoles.noter(AGENT_ID, { horodatage: 1, niveau: "error", texte: "visible" }, { lisible: true });
  service.consoles.noter(AGENT_ID, { horodatage: 2, niveau: "error", texte: "secret d'onglet" }, { lisible: false });
  service.consoles.noter(ID, { horodatage: 3, niveau: "error", texte: "console du Store" });
  const liste = await outils.lister();
  expect(liste.find((x) => x.cle === "agent:essai")).toEqual({ cle: "agent:essai", source: "agent", nom: "essai", version: "1.0.0", espaces: ["Perso"], espacesPrives: 0, erreurs: ["visible"] });
  expect(liste.find((x) => x.cle === `store:${ID}`)).toEqual({ cle: `store:${ID}`, source: "store", nom: "Bloqueur", version: "1.0.0", espaces: ["Perso"], espacesPrives: 1, erreurs: [] });
  expect(JSON.stringify(liste)).not.toContain("Banque");
});

test("console pour l'agent : filtrée ; deuxième barrière pour le Store ; inconnue → null", async () => {
  const { service, outils } = await agentPourOutils();
  service.consoles.noter(AGENT_ID, { horodatage: 1, niveau: "log", texte: "caché" }, { lisible: false });
  service.consoles.noter(AGENT_ID, { horodatage: 2, niveau: "log", texte: "fond" });
  expect(await outils.console("essai")).toEqual({ messages: [{ horodatage: 2, niveau: "log", texte: "fond" }], masques: 1, fondMasque: false, fondObserve: false, debloquee: false });
  expect(await outils.console("agent:essai", 2)).toMatchObject({ masques: 0 });
  await expect(outils.console(`store:${ID}`)).rejects.toThrow("Réservé aux extensions que tu as écrites.");
  expect(await outils.console("absente")).toBeNull();
});

test("a tourné dans un onglet non lisible : noté au registre par profil, durable (relance), jamais remis à zéro ; effacé avec l'extension", async () => {
  const { service, outils, registre } = await agentPourOutils();
  await service.aTourneDansOnglet(AGENT_ID, "defaut", true);
  expect(registre().extensions["agent:essai"]!.consoleMasquee ?? []).toEqual([]);
  expect((await outils.console("essai"))!.fondMasque).toBe(false);
  await service.aTourneDansOnglet(AGENT_ID, "defaut", false);
  await service.aTourneDansOnglet(AGENT_ID, "defaut", false);
  expect(registre().extensions["agent:essai"]!.consoleMasquee).toEqual(["defaut"]);
  expect((await outils.console("essai"))!.fondMasque).toBe(true);
  // Une extension du Store : rien n'est écrit.
  await service.aTourneDansOnglet(ID, "defaut", false);
  expect(registre().extensions[`store:${ID}`]!.consoleMasquee ?? []).toEqual([]);
  // recharger ne remet rien à zéro.
  await outils.recharger("essai");
  expect((await outils.console("essai"))!.fondMasque).toBe(true);
  // Relancé : toujours là (registre).
  const { service: relance, pret } = demarrer();
  await pret;
  const o2 = relance.outilsAgent({ fenetreAgent: () => "f1" });
  expect((await o2.console("essai"))!.fondMasque).toBe(true);
  expect(await relance.supprimer("agent:essai")).toEqual({ ok: true });
  expect(registre().extensions["agent:essai"]).toBeUndefined();
});

test("un droit qui observe les onglets ou la navigation : service worker et pages toujours masqués, décidé à la lecture ; sans ce droit, rien", async () => {
  const { service, outils, registre } = await agentPourOutils();
  const avec = (accord: unknown) =>
    service.modifier((e) => ({ ...e, extensions: { ...e.extensions, "agent:essai": { ...e.extensions["agent:essai"]!, accord: accord as never } } }));
  const vide = { permissions: [], hotes: [], reseau: [], tousLesSites: false, scriptsTousLesSites: false };
  service.consoles.noter(AGENT_ID, { horodatage: 1, niveau: "log", texte: "fond" });
  service.consoles.noter(AGENT_ID, { horodatage: 2, niveau: "log", texte: "partagé" }, { lisible: true });
  for (const accord of [vide, { ...vide, permissions: ["storage", "alarms", "notifications"] }]) {
    await avec(accord);
    expect(await outils.console("essai")).toMatchObject({ fondObserve: false, messages: [{ texte: "fond" }, { texte: "partagé" }] });
  }
  const observateurs = [
    ...["tabs", "webNavigation", "cookies", "history", "topSites", "sessions", "bookmarks", "activeTab", "clipboardRead"].map((p) => ({ ...vide, permissions: [p] })),
    { ...vide, hotes: ["https://x.test/*"] },
    { ...vide, tousLesSites: true },
    { ...vide, scriptsTousLesSites: true },
    null,
  ];
  for (const accord of observateurs) {
    await avec(accord);
    // Aucun onglet n'est ouvert, et les messages ont été écrits avant le droit : masqués quand même.
    const r = (await outils.console("essai"))!;
    expect(r.messages.map((m) => m.texte), JSON.stringify(accord)).toEqual(["partagé"]);
    expect(r.fondObserve).toBe(true);
    expect((await outils.lister()).find((x) => x.cle === "agent:essai")!.erreurs).toEqual([]);
  }
  expect(registre().extensions["agent:essai"]!.consoleMasquee ?? []).toEqual([]);
});

test("a tourné dans un onglet non lisible : son id Chromium est gardé au registre après sa suppression ; recréée au même endroit, sa console reste masquée", async () => {
  const { service, outils, registre } = await agentPourOutils();
  mkdirSync(join(dossier, "copies", "essai"), { recursive: true });
  await service.aTourneDansOnglet(AGENT_ID, "defaut", false);
  expect(registre().consolesMasquees).toEqual([AGENT_ID]);
  expect(await service.supprimer("agent:essai")).toEqual({ ok: true });
  expect(registre().extensions["agent:essai"]).toBeUndefined();
  expect(registre().consolesMasquees).toEqual([AGENT_ID]);
  // Recréée (nouvelle entrée, même copie, même id Chromium) : rien au drapeau de l'entrée, masquée quand même.
  await service.modifier((e) => ({ ...e, extensions: { ...e.extensions, "agent:essai": { ...entree("agent", ["defaut"]), idChrome: AGENT_ID } as never } }));
  service.consoles.noter(AGENT_ID, { horodatage: 5, niveau: "log", texte: "lu dans l'ancien stockage" });
  const r = (await outils.console("essai"))!;
  expect(r.fondMasque).toBe(true);
  expect(r.messages).toEqual([]);
  // Avant que Chromium ne lui ait redonné son id : calculé depuis la copie.
  const { idChromeDeDossier } = await import("../../src/main/extensions/reseau");
  const idCopie = idChromeDeDossier(join(dossier, "copies", "essai"));
  await service.modifier((e) => ({ ...e, consolesMasquees: [idCopie], extensions: { ...e.extensions, "agent:essai": { ...e.extensions["agent:essai"]!, idChrome: null } } }));
  expect((await outils.console("essai"))!.fondMasque).toBe(true);
});

test("supprimer une extension de l'agent efface son stockage dans chaque profil : un manifeste neutre à la place de la copie, après le retrait du registre, puis la copie effacée", async () => {
  const { service, registre } = await agentPourOutils();
  mkdirSync(join(dossier, "copies", "essai"), { recursive: true });
  writeFileSync(join(dossier, "copies", "essai", "fond.js"), "secret");
  expect(await service.supprimer("agent:essai")).toEqual({ ok: true });
  expect(effacements).toHaveLength(1);
  const e = effacements[0]!;
  expect(e.chemin).toBe(join(dossier, "copies", "essai"));
  // Un manifeste sans code : rien de l'agent ne tourne pendant l'effacement.
  expect(e.manifeste).toEqual({ manifest_version: 3, name: "WebAiOs — effacement", version: "1.0.0", permissions: ["storage"] });
  expect(e.registre.extensions["agent:essai"]).toBeUndefined();
  // Chaque profil connu, privé compris.
  expect(e.sessions).toEqual([{ session: "defaut" }, { session: "secret" }]);
  expect(existsSync(join(dossier, "copies", "essai"))).toBe(false);
  expect(registre().consolesMasquees ?? []).toEqual([]);
});

test("l'effacement du stockage échoue : la suppression aboutit, et sa console est masquée pour de bon (id gardé au registre)", async () => {
  const { service, registre } = await agentPourOutils();
  mkdirSync(join(dossier, "copies", "essai"), { recursive: true });
  effacementEchoue = true;
  const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await service.supprimer("agent:essai")).toEqual({ ok: true });
  erreur.mockRestore();
  expect(registre().extensions["agent:essai"]).toBeUndefined();
  // L'id qu'aura une copie recréée au même endroit (calculé depuis le dossier, même effacé).
  const { idChromeDeDossier } = await import("../../src/main/extensions/reseau");
  const id = idChromeDeDossier(join(dossier, "copies", "essai"));
  expect(registre().consolesMasquees).toEqual([id]);
  expect(existsSync(join(dossier, "copies", "essai"))).toBe(false);
  // Recréée : masquée (avant même que Chromium ne lui redonne son id).
  await service.modifier((e) => ({ ...e, extensions: { ...e.extensions, "agent:essai": entree("agent", ["defaut"]) as never } }));
  const { outils } = { outils: service.outilsAgent({ fenetreAgent: () => "f1" }) };
  expect((await outils.console("essai"))!.fondMasque).toBe(true);
});

test("une carte retirée avant la réponse de l'utilisateur : « retiree », pas « refusee »", async () => {
  const { service, outils } = await agentPourOutils();
  // Retirée par celui qui l'a posée (caduque, fenêtre fermée).
  service.brancherQuestions((_champs, repondre) => {
    setTimeout(() => repondre("retiree"));
    return () => {};
  });
  expect(await outils.debloquerConsole("essai", "r", { fenetre: null, agent: "Claude" })).toMatchObject({ ok: false, retiree: true });
  // Le signal (nouvelle conversation) tombe pendant la carte.
  service.brancherQuestions(() => () => {});
  const retrait = new AbortController();
  const r = outils.debloquerConsole("essai", "r", { fenetre: null, agent: "Claude", signal: retrait.signal });
  retrait.abort();
  expect(await r).toMatchObject({ ok: false, retiree: true });
  // demanderAccord : retirée par le délai.
  const { REVOIR_PENDANT_COUPURE: _ } = await import("../../src/main/extensions/service");
  const carte = { cle: "agent:essai", espaceId: "e1", maj: null, renforce: false, empreinte: "x" } as never;
  expect(await service.demanderAccord(carte, { delaiMs: 5 })).toMatchObject({ accepte: false, retiree: true });
});

test("debloquer_console : la carte (Refuser par défaut côté interface) dit ce que l'agent verra ; accordé, plus rien n'est masqué ; refermer le referme", async () => {
  const { service, outils, cartes } = await agentPourOutils();
  await service.aTourneDansOnglet(AGENT_ID, "defaut", false);
  service.consoles.noter(AGENT_ID, { horodatage: 1, niveau: "log", texte: "caché" }, { lisible: false });
  service.consoles.noter(AGENT_ID, { horodatage: 2, niveau: "log", texte: "fond" });
  expect(await outils.debloquerConsole("essai", "le bouton ne répond pas", { fenetre: null, agent: "Claude" })).toEqual({ ok: true });
  expect(cartes).toHaveLength(1);
  expect(cartes[0]).toMatchObject({ permissions: ["console-extension"], origine: "agent:essai", titre: "essai", raison: "le bouton ne répond pas", agent: "Claude", fenetreId: "f1" });
  expect(await outils.console("essai")).toMatchObject({ masques: 0, fondMasque: false, debloquee: true, messages: [{ texte: "caché" }, { texte: "fond" }] });
  expect((await service.liste()).find((l) => l.cle === "agent:essai")!.consoleDebloquee).toBe(true);
  // En mémoire seulement : rien au registre.
  expect(readFileSync(join(dossier, "etat.json"), "utf8")).not.toMatch(/debloqu/i);
  // Fin 1 : l'agent la referme.
  expect(await outils.refermerConsole("essai")).toEqual({ ok: true });
  expect(await outils.console("essai")).toMatchObject({ masques: 1, fondMasque: true, debloquee: false });
  // Déjà débloquée : pas de nouvelle carte.
  await outils.debloquerConsole("essai", "encore", { fenetre: null, agent: "Claude" });
  await outils.debloquerConsole("essai", "encore", { fenetre: null, agent: "Claude" });
  expect(cartes).toHaveLength(2);
});

test("le déblocage est lié à ce que l'utilisateur a vu : la carte nomme les espaces de ses profils ; activée dans un autre profil, rechargée (copie ou id changé), il prend fin", async () => {
  const espaces = [
    { id: "e1", nom: "Perso", profil: "defaut", prive: false },
    { id: "e3", nom: "Lecture", profil: "defaut", prive: false },
    { id: "e4", nom: "Travail", profil: "travail", prive: false },
  ];
  const { service, outils, cartes } = await agentPourOutils({ espaces });
  const debloquer = () => outils.debloquerConsole("essai", "r", { fenetre: null, agent: "Claude" });
  const debloquee = async () => (await outils.console("essai"))!.debloquee;
  const changer = (f: (x: Record<string, unknown>) => Record<string, unknown>) =>
    service.modifier((e) => ({ ...e, extensions: { ...e.extensions, "agent:essai": f(e.extensions["agent:essai"] as never) as never } }));
  expect(await debloquer()).toEqual({ ok: true });
  expect(cartes[0]).toMatchObject({ espaces: ["Perso", "Lecture"] });
  // Une écriture sans effet sur la portée (épinglée) : il reste.
  await service.epingler("agent:essai", true);
  expect(await debloquee()).toBe(true);
  // Activée dans un autre profil : fin.
  await changer((x) => ({ ...x, profils: ["defaut", "travail"] }));
  expect(await debloquee()).toBe(false);
  expect(await debloquer()).toEqual({ ok: true });
  expect(cartes[1]).toMatchObject({ espaces: ["Perso", "Lecture", "Travail"] });
  // Retirée d'un profil : il reste (rien de plus n'est montré).
  await changer((x) => ({ ...x, profils: ["defaut"] }));
  expect(await debloquee()).toBe(true);
  // Rechargée : nouvelle copie (modifieeLe) → fin.
  await changer((x) => ({ ...x, modifieeLe: "2026-10-30T10:00:00.000Z" }));
  expect(await debloquee()).toBe(false);
  // Nouvel id Chromium → fin.
  expect(await debloquer()).toEqual({ ok: true });
  await changer((x) => ({ ...x, idChrome: "f".repeat(32) }));
  expect(await debloquee()).toBe(false);
});

test("un déblocage accordé avant que Chromium n'ait donné son id : lié à l'id de la copie, il reste quand l'id arrive au registre", async () => {
  const { service, outils } = await agentPourOutils();
  const { idChromeDeDossier } = await import("../../src/main/extensions/reseau");
  const id = idChromeDeDossier(join(dossier, "copies", "essai"));
  const changer = (idChrome: string | null) =>
    service.modifier((e) => ({ ...e, extensions: { ...e.extensions, "agent:essai": { ...e.extensions["agent:essai"]!, idChrome } } }));
  await changer(null);
  expect(await outils.debloquerConsole("essai", "r", { fenetre: null, agent: "Claude" })).toEqual({ ok: true });
  await changer(id);
  expect((await outils.console("essai"))!.debloquee).toBe(true);
  await service.epingler("agent:essai", true);
  expect((await outils.console("essai"))!.debloquee).toBe(true);
  // Un autre id : fin.
  await changer("f".repeat(32));
  expect((await outils.console("essai"))!.debloquee).toBe(false);
});

test("pendant la carte de déblocage, l'extension activée ailleurs ou rechargée (recréée) : la carte est retirée, rien n'est débloqué", async () => {
  const { service, outils } = await agentPourOutils();
  for (const changement of [
    (x: Record<string, unknown>) => ({ ...x, profils: ["defaut", "travail"] }),
    (x: Record<string, unknown>) => ({ ...x, modifieeLe: "2026-10-30T11:00:00.000Z" }),
  ]) {
    let repondre: (d: "autoriser") => void = () => {};
    service.brancherQuestions((_c, r) => {
      repondre = r as never;
      return () => {};
    });
    const appel = outils.debloquerConsole("essai", "r", { fenetre: null, agent: "Claude" });
    await new Promise((r) => setTimeout(r, 0));
    await service.modifier((e) => ({ ...e, extensions: { ...e.extensions, "agent:essai": changement(e.extensions["agent:essai"] as never) as never } }));
    repondre("autoriser");
    // La carte est retirée dès le changement : le « oui » arrivé ensuite ne débloque rien.
    expect(await appel).toMatchObject({ ok: false, retiree: true });
    expect((await outils.console("essai"))!.debloquee).toBe(false);
  }
});

test("deux appels partagent la carte de déblocage : l'abandon de l'un ne la retire pas pour l'autre ; le dernier qui part la retire", async () => {
  const { service, outils } = await agentPourOutils();
  let repondre: (d: "autoriser") => void = () => {};
  let retiree = false;
  service.brancherQuestions((_c, r) => {
    repondre = r as never;
    return () => void (retiree = true);
  });
  const a = new AbortController();
  const b = new AbortController();
  const premier = outils.debloquerConsole("essai", "r", { fenetre: null, agent: "Claude", signal: a.signal });
  const second = outils.debloquerConsole("essai", "r", { fenetre: null, agent: "Claude", signal: b.signal });
  await new Promise((r) => setTimeout(r, 0));
  a.abort();
  expect(await premier).toMatchObject({ ok: false, retiree: true });
  expect(retiree).toBe(false);
  repondre("autoriser");
  expect(await second).toEqual({ ok: true });
  // Le dernier qui part retire la carte.
  await outils.refermerConsole("essai");
  const c = new AbortController();
  const troisieme = outils.debloquerConsole("essai", "r", { fenetre: null, agent: "Claude", signal: c.signal });
  await new Promise((r) => setTimeout(r, 0));
  c.abort();
  expect(await troisieme).toMatchObject({ ok: false, retiree: true });
  expect(retiree).toBe(true);
});

test("debloquer_console refusé : « refusee », rien ne change ; jamais pour le Store, ni une extension inactive", async () => {
  const { outils, cartes } = await agentPourOutils({ reponse: "refuser" });
  expect(await outils.debloquerConsole("essai", "r", { fenetre: null, agent: "Claude" })).toMatchObject({ ok: false, refusee: true });
  expect((await outils.console("essai"))!.debloquee).toBe(false);
  await expect(outils.debloquerConsole(`store:${ID}`, "r", { fenetre: null, agent: "Claude" })).rejects.toThrow("Réservé aux extensions que tu as écrites.");
  expect(cartes).toHaveLength(1);
});

test("fins du déblocage : L'utilisateur le coupe (page), l'extension est désactivée, supprimée ; un nouveau service (WebAiOs relancé) n'en a aucun", async () => {
  const { service, outils } = await agentPourOutils();
  const debloquer = () => outils.debloquerConsole("essai", "r", { fenetre: null, agent: "Claude" });
  const debloquee = async () => (await outils.console("essai"))?.debloquee;
  // Fin 2 : « Couper le déblocage » sur la page Extensions.
  await debloquer();
  expect(await service.couperDeblocage("agent:essai")).toEqual({ ok: true });
  expect(await debloquee()).toBe(false);
  // Fin 3 : désactivée partout.
  await debloquer();
  expect(await debloquee()).toBe(true);
  await service.desactiverPartout("agent:essai");
  expect(await debloquee()).toBe(false);
  // Réactivée par un registre réécrit, puis coupure générale : fin aussi.
  // Fin 4 : relance de WebAiOs (en mémoire seulement).
  const autre = await agentPourOutils();
  expect((await autre.outils.console("essai"))!.debloquee).toBe(false);
  await autre.outils.debloquerConsole("essai", "r", { fenetre: null, agent: "Claude" });
  // Fin 5 : supprimée.
  expect(await autre.service.supprimer("agent:essai")).toEqual({ ok: true });
  expect(await autre.outils.console("essai")).toBeNull();
  expect((await autre.service.liste()).find((l) => l.cle === "agent:essai")).toBeUndefined();
});

test("fin du déblocage par la coupure générale ; et jamais si l'extension est active dans le profil d'un espace privé", async () => {
  const { service, outils } = await agentPourOutils();
  await outils.debloquerConsole("essai", "r", { fenetre: null, agent: "Claude" });
  await service.toutCouper(true);
  expect((await outils.console("essai"))!.debloquee).toBe(false);
  await service.toutCouper(false);
  // Un registre (impossible par construction) où elle est active dans un profil privé : refusé sans carte.
  const prive = await agentPourOutils({ espaces: [{ id: "e1", nom: "Perso", profil: "defaut", prive: true }] });
  const r = await prive.outils.debloquerConsole("essai", "r", { fenetre: null, agent: "Claude" });
  expect(r.ok).toBe(false);
  expect(prive.cartes).toEqual([]);
});

test("demander pour l'agent : espace par nom ; un espace privé ou inconnu est refusé sans carte ; le refus de l'utilisateur est signalé", async () => {
  const { outils, cartes } = await agentPourOutils();
  expect(await outils.demander("essai", { espace: "Banque", fenetre: null, agent: "Claude" })).toEqual({ ok: false, erreur: "Espace inconnu : Banque" });
  expect(await outils.demander("essai", { espace: "Nulle part", fenetre: null, agent: "Claude" })).toEqual({ ok: false, erreur: "Espace inconnu : Nulle part" });
  expect(cartes).toEqual([]);
});

test("B T10-7 verifierMisesAJour : une extension dont la file est tenue (carte d'installation ouverte) est sautée, la vérification finit", async () => {
  const { enFileStore } = await import("../../src/main/extensions/store");
  const { service } = await storeInstalle(["defaut"]);
  const fauxFetch = (async () =>
    new Response(
      `)]}'\n${JSON.stringify({ response: { app: [{ appid: ID, updatecheck: { status: "ok", urls: { url: [{ codebase: "http://127.0.0.1:1/x.crx" }] }, manifest: { version: "1.1.0" } } }] } })}`,
    )) as typeof fetch;
  let liberer!: () => void;
  const tenue = enFileStore(dossier, ID, () => new Promise<void>((ok) => (liberer = ok)));
  const journal = vi.spyOn(console, "error").mockImplementation(() => {});
  const fini = await Promise.race([service.verifierMisesAJour({ fetch: fauxFetch }).then(() => true), new Promise((ok) => setTimeout(() => ok(false), 2000))]);
  expect(fini).toBe(true);
  expect(service.erreurs().has(`store:${ID}`)).toBe(false);
  liberer();
  await tenue;
  await service.verifierMisesAJour({ fetch: fauxFetch });
  journal.mockRestore();
  expect(service.erreurs().get(`store:${ID}`)).toMatch(/Chrome Web Store/);
});

test("B noterVue pour un profil retiré entre-temps (service worker qui démarre tard) : rien n'est écrit pour lui", async () => {
  writeFileSync(join(dossier, "etat.json"), JSON.stringify({ version: 1, toutesCoupees: false, extensions: { "agent:essai": entree("agent", ["defaut"]) } }));
  const { service, pret } = demarrer();
  await pret;
  expect(await service.noterVue("agent:essai", "efface", "1.0.0")).toEqual({ nouvelle: false });
  expect(service.etatExtensions().extensions["agent:essai"]!.vues).toEqual({});
});

test("C15 appliquer : un profil dont l'id contient « : » est ignoré (journalisé), sa session n'est pas créée", async () => {
  nav = {
    espaces: [
      { id: "e1", profil: "defaut", prive: false },
      { id: "e2", profil: "site:vidola", prive: false },
    ],
    profils: [{ id: "defaut" }, { id: "site:vidola" }],
    fenetres: [],
    onglets: {},
  } as unknown as EtatNavigateur;
  const version = join(dossier, "store", ID, "1.0.0_0");
  mkdirSync(version, { recursive: true });
  writeFileSync(join(version, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "x", version: "1.0.0" }));
  writeFileSync(join(dossier, "etat.json"), JSON.stringify({ version: 1, toutesCoupees: false, extensions: { [`store:${ID}`]: entree("store", ["defaut", "site:vidola"]) } }));
  const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await demarrer().pret;
    expect(branchees).toContain("defaut");
    expect(branchees).not.toContain("site:vidola");
    expect(erreur).toHaveBeenCalledWith(expect.stringMatching(/site:vidola ignoré/));
  } finally {
    erreur.mockRestore();
  }
});

// ——— Plan 16, tâche 3 : les applis de site ———

const ID2 = "d".repeat(32);
const CLE = `store:${ID}`;
const CLE2 = `store:${ID2}`;

/** Deux extensions du Store installées (« Zèbre » et « alpha »), une de l'agent ; `plus` complète leurs entrées. */
async function avecApplis(plus: Record<string, Record<string, unknown>> = {}) {
  for (const id of [ID, ID2]) {
    const version = join(dossier, "store", id, "1.0.0_0");
    mkdirSync(version, { recursive: true });
    writeFileSync(join(version, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "x", version: "1.0.0", key: `cle-${id}` }));
  }
  writeFileSync(
    join(dossier, "etat.json"),
    JSON.stringify({
      version: 1,
      toutesCoupees: false,
      extensions: {
        [CLE]: { ...entree("store", ["defaut"]), nom: "Zèbre", ...plus[CLE] },
        [CLE2]: { ...entree("store", []), nom: "alpha", ...plus[CLE2] },
        "agent:essai": { ...entree("agent", ["defaut"]), ...plus["agent:essai"] },
      },
    }),
  );
  const { service, pret } = demarrer();
  await pret;
  const registre = () => JSON.parse(readFileSync(join(dossier, "etat.json"), "utf8")) as EtatExtensions;
  return { service, registre };
}

test("basculerSite active une extension du Store pour l'appli ouverte avec l'empreinte de son ouverture ; profils inchangés ; désactiver la retire", async () => {
  const { service, registre } = await avecApplis();
  await service.ouvertureSite("vidola", "E1");
  expect(service.empreinteSite("vidola")).toBe("E1");
  expect(await service.basculerSite(CLE, "vidola", true)).toEqual({ ok: true });
  expect(registre().extensions[CLE]!.applis).toEqual({ vidola: "E1" });
  expect(registre().extensions[CLE]!.profils).toEqual(["defaut"]);
  // Synchronisée, la session de l'appli branchée, puis le démarrage de l'extension attendu dans la portée de l'appli (C5).
  expect(synchronisees.at(-1)!.extensions[CLE]!.applis).toEqual({ vidola: "E1" });
  expect(journal).toContain("brancher:vidola:persist:site-vidola");
  const { DELAI_DEMARRAGE_FOND_MS } = await import("../../src/main/extensions/sessions");
  expect(attentes).toEqual([["site:vidola", CLE, DELAI_DEMARRAGE_FOND_MS]]);
  expect(await service.basculerSite(CLE, "vidola", false)).toEqual({ ok: true });
  expect(registre().extensions[CLE]!.applis).toBeUndefined();
  expect(registre().extensions[CLE]!.profils).toEqual(["defaut"]);
  // Une désactivation n'attend aucun démarrage.
  expect(attentes).toHaveLength(1);
});

test("basculerSite : clé de l'agent → RESERVE_STORE_SITE ; appli fermée → APPLI_FERMEE ; coupure → TOUTES_COUPEES_AGENT ; désactivée pour plantages → DESACTIVEE_PLANTAGES", async () => {
  const { RESERVE_STORE_SITE } = await import("@webaios/noyau");
  const { APPLI_FERMEE } = await import("../../src/commun/extensions");
  const { TOUTES_COUPEES_AGENT } = await import("../../src/main/extensions/agent");
  const { service, registre } = await avecApplis({ [CLE2]: { desactivee: { raison: "plantages", le: "2026-11-02T00:00:00.000Z" } } });
  expect(await service.basculerSite("agent:essai", "vidola", true)).toEqual({ ok: false, erreur: RESERVE_STORE_SITE });
  expect(await service.basculerSite(CLE, "vidola", true)).toEqual({ ok: false, erreur: APPLI_FERMEE });
  await service.ouvertureSite("vidola", "E1");
  expect(await service.basculerSite(CLE2, "vidola", true)).toEqual({ ok: false, erreur: "Désactivée : elle a planté 3 fois en une minute" });
  await service.toutCouper(true);
  expect(await service.basculerSite(CLE, "vidola", true)).toEqual({ ok: false, erreur: TOUTES_COUPEES_AGENT });
  expect(registre().extensions[CLE]!.applis).toBeUndefined();
  expect(registre().extensions[CLE2]!.applis).toBeUndefined();
  // Désactiver est toujours permis (coupure, appli fermée).
  service.fermetureSite("vidola");
  expect(await service.basculerSite(CLE, "vidola", false)).toEqual({ ok: true });
});

test("deux basculerSite lancés ensemble (vrai puis faux) : l'état final est le second", async () => {
  const { service, registre } = await avecApplis();
  await service.ouvertureSite("vidola", "E1");
  const [a, b] = await Promise.all([service.basculerSite(CLE, "vidola", true), service.basculerSite(CLE, "vidola", false)]);
  expect(a).toEqual({ ok: true });
  expect(b).toEqual({ ok: true });
  expect(registre().extensions[CLE]!.applis).toBeUndefined();
  // L'ordre inverse (faux puis vrai) : active à la fin.
  const [c, d] = await Promise.all([service.basculerSite(CLE, "vidola", false), service.basculerSite(CLE, "vidola", true)]);
  expect(c).toEqual({ ok: true });
  expect(d).toEqual({ ok: true });
  expect(registre().extensions[CLE]!.applis).toEqual({ vidola: "E1" });
});

test("M5 une activation qui attend le démarrage (C5) ne retient pas la désactivation qui la suit ; réveillée à faux, elle rend quand même ok", async () => {
  const { service, registre } = await avecApplis();
  await service.ouvertureSite("vidola", "E1");
  let reveiller: ((ok: boolean) => void) | undefined;
  reponseDemarrage = () => new Promise<boolean>((ok) => (reveiller = ok));
  let activationFinie = false;
  const activation = service.basculerSite(CLE, "vidola", true).then((r) => {
    activationFinie = true;
    return r;
  });
  await vi.waitFor(() => expect(reveiller).toBeDefined());
  expect(registre().extensions[CLE]!.applis).toEqual({ vidola: "E1" });
  // L'attente est hors de la file : la désactivation passe, pendant que l'activation attend toujours.
  expect(await service.basculerSite(CLE, "vidola", false)).toEqual({ ok: true });
  expect(activationFinie).toBe(false);
  expect(registre().extensions[CLE]!.applis).toBeUndefined();
  // Retirée : l'attente est réveillée à faux, et l'activation rend ok avec un avertissement.
  const avertir = vi.spyOn(console, "warn").mockImplementation(() => {});
  reveiller!(false);
  expect(await activation).toEqual({ ok: true });
  expect(avertir).toHaveBeenCalledWith(expect.stringContaining("non répondu"));
  avertir.mockRestore();
});

test("I1 domaines changés pendant que la file est tenue : l'activation est refusée DOMAINES_CHANGES_EXTENSION, rien n'est écrit", async () => {
  const { enFileStore } = await import("../../src/main/extensions/store");
  const { DOMAINES_CHANGES_EXTENSION } = await import("../../src/commun/extensions");
  const { service, registre } = await avecApplis();
  await service.ouvertureSite("vidola", "E1");
  // Une carte d'installation de cette extension tient sa file.
  let liberer: (() => void) | undefined;
  const tenue = enFileStore(dossier, ID, () => new Promise<void>((ok) => (liberer = ok)));
  const bascule = service.basculerSite(CLE, "vidola", true);
  await vi.waitFor(() => expect(liberer).toBeDefined());
  // L'agent ajoute un domaine : l'appli est relue avec une autre empreinte.
  await service.ouvertureSite("vidola", "E2");
  liberer!();
  await tenue;
  expect(await bascule).toEqual({ ok: false, erreur: DOMAINES_CHANGES_EXTENSION });
  expect(registre().extensions[CLE]!.applis).toBeUndefined();
  expect(attentes).toEqual([]);
});

test("fermetureSite pendant un basculerSite : l'activation écrite est refusée APPLI_FERMEE, rien n'est chargé", async () => {
  const { enFileStore } = await import("../../src/main/extensions/store");
  const { APPLI_FERMEE } = await import("../../src/commun/extensions");
  const { service, registre } = await avecApplis();
  await service.ouvertureSite("vidola", "E1");
  // La file de l'extension tenue : l'écriture de la bascule attend derrière.
  let liberer: (() => void) | undefined;
  const tenue = enFileStore(dossier, ID, () => new Promise<void>((ok) => (liberer = ok)));
  const bascule = service.basculerSite(CLE, "vidola", true);
  await vi.waitFor(() => expect(liberer).toBeDefined());
  service.fermetureSite("vidola");
  liberer!();
  await tenue;
  expect(await bascule).toEqual({ ok: false, erreur: APPLI_FERMEE });
  expect(registre().extensions[CLE]!.applis).toBeUndefined();
  expect(journal.filter((x) => x.startsWith("brancher:"))).toEqual([]);
  expect(attentes).toEqual([]);
});

test("pourSite : seulement les extensions du Store, triées ; active, domainesChanges (empreinte d'activation ≠ empreinte d'ouverture), indisponible (coupure, désactivée)", async () => {
  const { TOUTES_COUPEES_AGENT } = await import("../../src/main/extensions/agent");
  const { service } = await avecApplis({
    [CLE]: { applis: { vidola: "E0" } },
    [CLE2]: { applis: { vidola: "E1" }, desactivee: { raison: "portee-elargie", le: "2026-11-02T00:00:00.000Z" } },
  });
  await service.ouvertureSite("vidola", "E1");
  expect(service.pourSite("vidola")).toEqual([
    { cle: CLE2, nom: "alpha", active: true, domainesChanges: false, indisponible: "Désactivée : elle demande plus de droits qu'accordé" },
    { cle: CLE, nom: "Zèbre", active: false, domainesChanges: true, indisponible: null },
  ]);
  await service.toutCouper(true);
  expect(service.pourSite("vidola").map((l) => l.indisponible)).toEqual([TOUTES_COUPEES_AGENT, TOUTES_COUPEES_AGENT]);
  // Une autre appli : rien d'actif.
  await service.ouvertureSite("autre", "E1");
  expect(service.pourSite("autre").map((l) => [l.active, l.domainesChanges])).toEqual([
    [false, false],
    [false, false],
  ]);
});

test("ouvertureSite branche la session de l'appli seulement si une clé y est chargée pour cette empreinte, et rend après la synchronisation", async () => {
  const { service } = await avecApplis({ [CLE]: { applis: { vidola: "E1" } } });
  journal = [];
  // Une autre empreinte (domaines changés) : rien n'y est chargé, la session n'est pas branchée.
  await service.ouvertureSite("vidola", "E2");
  expect(journal).toEqual(["synchro"]);
  journal = [];
  await service.ouvertureSite("vidola", "E1");
  expect(journal).toEqual(["brancher:vidola:persist:site-vidola", "synchro"]);
});

test("sans extension active pour l'appli, ouvertureSite ne branche aucune session", async () => {
  const { service } = await avecApplis({ [CLE]: { applis: { autre: "E1" } } });
  journal = [];
  await service.ouvertureSite("vidola", "E1");
  expect(journal).toEqual(["synchro"]);
});

test("C1 ouvertureSite avant la fin du démarrage du service : elle l'attend, puis synchronise avec l'appli", async () => {
  const version = join(dossier, "store", ID, "1.0.0_0");
  mkdirSync(version, { recursive: true });
  writeFileSync(join(version, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "x", version: "1.0.0" }));
  writeFileSync(join(dossier, "etat.json"), JSON.stringify({ version: 1, toutesCoupees: false, extensions: { [CLE]: { ...entree("store", []), applis: { vidola: "E1" } } } }));
  // Le démarrage tenu ouvert (sa synchronisation attend) : l'ouverture de l'appli ne rend pas avant lui.
  let libererSynchro!: () => void;
  synchroTenue = new Promise<void>((ok) => (libererSynchro = ok));
  const { service, pret } = demarrer();
  const ouverture = service.ouvertureSite("vidola", "E1");
  let finie = false;
  void ouverture.then(() => (finie = true));
  await new Promise((ok) => setTimeout(ok, 50));
  expect(finie).toBe(false);
  synchroTenue = null;
  libererSynchro();
  await pret;
  await ouverture;
  expect(finie).toBe(true);
  expect(journal).toContain("brancher:vidola:persist:site-vidola");
  expect(journal.at(-1)).toBe("synchro");
});

test("I1 démarrage du service qui ne finit jamais : une appli sans aucune activation s'ouvre dès le registre lu ; une appli avec activation attend toujours", async () => {
  const version = join(dossier, "store", ID, "1.0.0_0");
  mkdirSync(version, { recursive: true });
  writeFileSync(join(version, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "x", version: "1.0.0" }));
  // Une activation pour « vidola » seulement (une autre empreinte compte quand même : c'est une activation pour elle).
  writeFileSync(join(dossier, "etat.json"), JSON.stringify({ version: 1, toutesCoupees: false, extensions: { [CLE]: { ...entree("store", []), applis: { vidola: "E0" } } } }));
  synchroTenue = new Promise<void>(() => {});
  const { service } = demarrer();
  let equipee = false;
  void service.ouvertureSite("vidola", "E1").then(() => (equipee = true));
  await expect(service.ouvertureSite("youtube", "E1")).resolves.toBeUndefined();
  await new Promise((ok) => setTimeout(ok, 50));
  expect(equipee).toBe(false);
  // Toujours retenue : la synchronisation de fin de démarrage la verra.
  expect(service.empreinteSite("youtube")).toBe("E1");
});

test("I1 registre illisible : une appli sans activation connue s'ouvre quand même", async () => {
  writeFileSync(join(dossier, "etat.json"), "{ pas du json");
  const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
  const { service, pret } = demarrer();
  await service.ouvertureSite("youtube", "E1");
  await pret;
  erreur.mockRestore();
});

test("m2 retirerSite avant la fin du démarrage : noté, ses activations et ses vues sont retirées à la fin du démarrage", async () => {
  for (const id of [ID, ID2]) {
    const version = join(dossier, "store", id, "1.0.0_0");
    mkdirSync(version, { recursive: true });
    writeFileSync(join(version, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "x", version: "1.0.0" }));
  }
  writeFileSync(
    join(dossier, "etat.json"),
    JSON.stringify({
      version: 1,
      toutesCoupees: false,
      extensions: {
        [CLE]: { ...entree("store", []), applis: { vidola: "E1", autre: "E1", garde: "E1" }, vues: { "site:vidola": "1.0.0", "site:autre": "1.0.0", defaut: "1.0.0" } },
        [CLE2]: { ...entree("store", []), vues: { "site:vidola": "1.0.0" } },
      },
    }),
  );
  // Avant que `demarrer` soit appelé (le service n'a pas encore son dossier), puis appelé mais le registre pas encore lu.
  const { service, pret } = demarrer(false, (s) => void s.retirerSite("autre"));
  const retrait = service.retirerSite("vidola");
  await retrait;
  await pret;
  const r = (JSON.parse(readFileSync(join(dossier, "etat.json"), "utf8")) as EtatExtensions).extensions;
  expect(r[CLE]!.applis).toEqual({ garde: "E1" });
  expect(r[CLE]!.vues).toEqual({ defaut: "1.0.0" });
  expect(r[CLE2]!.vues).toEqual({});
  // La synchronisation de fin de démarrage ne veut plus rien dans l'appli retirée.
  expect(synchronisees.at(-1)!.extensions[CLE]!.applis).toEqual({ garde: "E1" });
});

test("fermetureSite : la synchronisation suivante ne veut plus rien dans la session de l'appli", async () => {
  const { chargeesDansSite } = await import("@webaios/noyau");
  const { service } = await avecApplis({ [CLE]: { applis: { vidola: "E1" } } });
  await service.ouvertureSite("vidola", "E1");
  expect(chargeesDansSite(synchronisees.at(-1)!, "vidola", service.empreinteSite("vidola"))).toEqual([CLE]);
  const avant = synchronisees.length;
  service.fermetureSite("vidola");
  expect(service.empreinteSite("vidola")).toBeNull();
  await vi.waitFor(() => expect(synchronisees.length).toBe(avant + 1));
  expect(chargeesDansSite(synchronisees.at(-1)!, "vidola", service.empreinteSite("vidola"))).toEqual([]);
});

test("noterVue pour « site:vidola » : notée appli ouverte ; appli fermée : rien", async () => {
  const { service } = await avecApplis({ [CLE]: { applis: { vidola: "E1" } } });
  expect(await service.noterVue(CLE, "site:vidola", "1.0.0")).toEqual({ nouvelle: false });
  await service.ouvertureSite("vidola", "E1");
  expect(await service.noterVue(CLE, "site:vidola", "1.0.0")).toEqual({ nouvelle: true });
  expect(service.etatExtensions().extensions[CLE]!.vues).toEqual({ "site:vidola": "1.0.0" });
  service.fermetureSite("vidola");
  expect(await service.noterVue(CLE, "site:vidola", "2.0.0")).toEqual({ nouvelle: false });
  // C15 : une portée qui contient « : » sans être celle d'une appli n'est jamais notée, même si un profil la porte.
  nav = { ...nav, profils: [{ id: "defaut" }, { id: "a:b" }], espaces: [...nav.espaces, { id: "e9", profil: "a:b", prive: false }] } as unknown as EtatNavigateur;
  const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await service.noterVue(CLE, "a:b", "1.0.0")).toEqual({ nouvelle: false });
  erreur.mockRestore();
  expect(service.etatExtensions().extensions[CLE]!.vues).toEqual({ "site:vidola": "1.0.0" });
});

test("retirerSite : l'appli quitte applis et vues ; effacerStockage reçoit le dossier de chaque extension du Store active ou démarrée dans l'appli, avec la seule session de l'appli ; un échec est journalisé et retirerSite rend quand même", async () => {
  const { service, registre } = await avecApplis({
    [CLE]: { applis: { vidola: "E1", autre: "E1" }, vues: { "site:vidola": "1.0.0", defaut: "1.0.0" } },
    [CLE2]: { vues: { "site:vidola": "1.0.0" } },
  });
  await service.retirerSite("vidola");
  const r = registre().extensions;
  expect(r[CLE]!.applis).toEqual({ autre: "E1" });
  expect(r[CLE]!.vues).toEqual({ defaut: "1.0.0" });
  expect(r[CLE2]!.vues).toEqual({});
  expect(effacements.map((x) => [x.chemin, x.sessions]).sort()).toEqual(
    [
      [join(dossier, "store", ID, "1.0.0_0"), [{ session: "persist:site-vidola" }]],
      [join(dossier, "store", ID2, "1.0.0_0"), [{ session: "persist:site-vidola" }]],
    ].sort(),
  );
  // Effacé après l'écriture (et sa synchronisation) : l'appli n'est plus dans le registre à ce moment.
  for (const x of effacements) expect(x.registre.extensions[CLE]!.applis).toEqual({ autre: "E1" });

  effacements = [];
  await service.ouvertureSite("bis", "E1");
  await service.basculerSite(CLE, "bis", true);
  effacementEchoue = true;
  const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(service.retirerSite("bis")).resolves.toBeUndefined();
  expect(erreur).toHaveBeenCalledWith(expect.stringContaining(`[extensions] stockage de ${CLE} non effacé dans l'appli bis`), expect.anything());
  erreur.mockRestore();
  expect(registre().extensions[CLE]!.applis).toEqual({ autre: "E1" });
});

test("desactiverPartout et toutCouper valent pour l'appli (plus rien de voulu dans sa session)", async () => {
  const { chargeesDansSite } = await import("@webaios/noyau");
  const { service } = await avecApplis({ [CLE]: { applis: { vidola: "E1" } } });
  await service.ouvertureSite("vidola", "E1");
  const voulues = () => chargeesDansSite(synchronisees.at(-1)!, "vidola", service.empreinteSite("vidola"));
  expect(voulues()).toEqual([CLE]);
  await service.toutCouper(true);
  expect(voulues()).toEqual([]);
  await service.toutCouper(false);
  expect(voulues()).toEqual([CLE]);
  expect(await service.desactiverPartout(CLE)).toEqual({ ok: true });
  expect(voulues()).toEqual([]);
});

test("liste : applis = noms des applis où elle est active ; un id sans nom est montré tel quel", async () => {
  const { service } = await avecApplis({ [CLE]: { applis: { vidola: "E1", perdue: "E1" } } });
  nomsSites = { vidola: "Vidola" };
  const lignes = await service.liste();
  expect(lignes.find((l) => l.cle === CLE)!.applis).toEqual(["Vidola", "perdue"]);
  expect(lignes.find((l) => l.cle === CLE2)!.applis).toEqual([]);
  expect(lignes.find((l) => l.cle === "agent:essai")!.applis).toEqual([]);
});

test("barreSite : partition persist:site-vidola, l'onglet donné, les clés chargées dans la portée de l'appli", async () => {
  const { service } = await avecApplis({ [CLE]: { applis: { vidola: "E1" }, epinglee: true }, [CLE2]: { applis: { vidola: "E1" } } });
  chargeesSite.set("site:vidola", [
    { cle: CLE, id: ID },
    { cle: CLE2, id: ID2 },
  ]);
  chargeesSite.set("defaut", [{ cle: "agent:essai", id: "z".repeat(32) }]);
  expect(service.barreSite("vidola", 42)).toEqual({
    partition: "persist:site-vidola",
    onglet: 42,
    actions: [
      { cle: CLE2, idChrome: ID2, nom: "alpha", epinglee: false },
      { cle: CLE, idChrome: ID, nom: "Zèbre", epinglee: true },
    ],
  });
  expect(service.barreSite("autre", null)).toEqual({ partition: "persist:site-autre", onglet: null, actions: [] });
});

test("« Retirer de Chrome » depuis le dernier profil d'une extension active dans une appli : retirée du profil seulement, store/<id> reste", async () => {
  const { service, registre } = await avecApplis({ [CLE]: { applis: { vidola: "E1" } } });
  await service.desinstallerDepuisStore(ID, "defaut");
  expect(registre().extensions[CLE]).toMatchObject({ profils: [], applis: { vidola: "E1" } });
  expect(existsSync(join(dossier, "store", ID, "1.0.0_0"))).toBe(true);
});

test("désinstaller une extension active dans une appli : son stockage est effacé dans la session de l'appli, avant que store/<id> ne parte", async () => {
  const { service, registre } = await avecApplis({ [CLE]: { applis: { vidola: "E1" }, vues: { "site:autre": "1.0.0", defaut: "1.0.0" } } });
  expect(await service.supprimer(CLE)).toEqual({ ok: true });
  expect(registre().extensions[CLE]).toBeUndefined();
  expect(existsSync(join(dossier, "store", ID))).toBe(false);
  expect(effacements.map((x) => x.sessions)).toEqual([[{ session: "persist:site-vidola" }], [{ session: "persist:site-autre" }]]);
  for (const x of effacements) {
    expect(x.chemin).toBe(join(dossier, "store", ID, "1.0.0_0"));
    expect(x.registre.extensions[CLE]).toBeUndefined();
  }
});

test("M3 retirerSite : le dossier effacé est relu dans la file de l'extension (une mise à jour passée entre-temps)", async () => {
  const { enFileStore } = await import("../../src/main/extensions/store");
  const { service, registre } = await avecApplis({ [CLE]: { applis: { vidola: "E1" } } });
  const v2 = join(dossier, "store", ID, "2.0.0_0");
  mkdirSync(v2, { recursive: true });
  writeFileSync(join(v2, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "x", version: "2.0.0", key: `cle-${ID}` }));
  let liberer: (() => void) | undefined;
  const tenue = enFileStore(dossier, ID, () => new Promise<void>((ok) => (liberer = ok)));
  await vi.waitFor(() => expect(liberer).toBeDefined());
  const retrait = service.retirerSite("vidola");
  await vi.waitFor(() => expect(registre().extensions[CLE]!.applis).toBeUndefined());
  // Une mise à jour appliquée pendant que la file est tenue : la version installée devient 2.0.0.
  await service.modifier((e) => ({ ...e, extensions: { ...e.extensions, [CLE]: { ...e.extensions[CLE]!, version: "2.0.0" } } }));
  liberer!();
  await tenue;
  await retrait;
  expect(effacements.map((x) => x.chemin)).toEqual([v2]);
});
