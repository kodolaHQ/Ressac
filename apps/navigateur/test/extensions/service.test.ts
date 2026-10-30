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

const etatNav = (prive: boolean) =>
  ({ espaces: [{ id: "e1", profil: "defaut", prive }], profils: [{ id: "defaut" }], fenetres: [], onglets: {} }) as unknown as EtatNavigateur;

function demarrer() {
  const service = new ServiceExtensions();
  const magasin = { get etat() { return nav; }, abonner: (f: (e: EtatNavigateur) => void) => void abonnes.push(f) };
  const profils = {
    synchroniser: async (e: EtatExtensions) => void synchronisees.push(e),
    erreursChargement: () => new Map<string, string>(),
    retirerAgentsPrives: (e: EtatNavigateur) => void retraitsPrives.push(e),
  };
  const sessions = { session: (id: string) => void branchees.push(id) };
  return {
    service,
    pret: service.demarrer({ dossier, dossierGardes: gardes, magasin, profils, sessions, vues: {} } as never),
  };
}

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "webaios-ext-service-"));
  temporaires.push(dossier);
  gardes = join(dossier, "gardes");
  mkdirSync(gardes);
  writeFileSync(join(gardes, "webaios-correctifs-page.js"), "// correctifs\n");
  synchronisees = [];
  branchees = [];
  retraitsPrives = [];
  abonnes = [];
  nav = etatNav(false);
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
  const { service, pret } = demarrer();
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
  expect(await outils.console("essai")).toEqual({ messages: [{ horodatage: 2, niveau: "log", texte: "fond" }], masques: 1, fondMasque: false, debloquee: false });
  expect(await outils.console("agent:essai", 2)).toMatchObject({ masques: 0 });
  await expect(outils.console(`store:${ID}`)).rejects.toThrow("Réservé aux extensions que tu as écrites.");
  expect(await outils.console("absente")).toBeNull();
});

test("recharger remet à zéro le drapeau du service worker (rechargée seulement)", async () => {
  const { service } = await agentPourOutils();
  service.consoles.aTourneDansOnglet(AGENT_ID, false);
  // Sans dossier de l'agent, le rechargement est refusé : le drapeau reste.
  const outils = service.outilsAgent({ fenetreAgent: () => "f1" });
  expect((await outils.recharger("essai")).etat).toBe("refusee");
  expect((await outils.console("essai"))!.fondMasque).toBe(true);
});

test("debloquer_console : la carte (Refuser par défaut côté interface) dit ce que l'agent verra ; accordé, plus rien n'est masqué ; refermer le referme", async () => {
  const { service, outils, cartes } = await agentPourOutils();
  service.consoles.aTourneDansOnglet(AGENT_ID, false);
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
