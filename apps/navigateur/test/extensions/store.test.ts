import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { activer as activerRegistre, empreintePortee, preparerStore, type EtatExtensions, type IdProfil } from "@webaios/noyau";
import type { CarteExtension, ReponseAccord } from "../../src/commun/extensions";
import type { Espace, EtatNavigateur } from "../../src/commun/modele";
import { construireCrx } from "../../e2e/extensions/crx";

// La bibliothèque du Store importe `electron` à son chargement (voir telechargement.test.ts) ; `webContents.fromFrame`
// rend la vue posée par le test pour un cadre.
const { cadres } = vi.hoisted(() => ({ cadres: new Map<unknown, unknown>() }));
vi.mock("electron", () => ({
  app: {},
  net: {},
  session: {},
  BrowserWindow: vi.fn(),
  ipcMain: {},
  nativeImage: {},
  powerMonitor: {},
  webContents: { fromFrame: (f: unknown) => cadres.get(f) },
}));

const { avantInstallation, desinstallerStore, idDepuisSaisie, installerStore, INSTALLATION_REFUSEE, SAISIE_INVALIDE, TOUTES_COUPEES } = await import(
  "../../src/main/extensions/store"
);
const { CRX_INVALIDE, ERREUR_STORE } = await import("../../src/main/extensions/telechargement");
const { DESACTIVEE_PLANTAGES, DESACTIVEE_PORTEE } = await import("../../src/commun/extensions");

const ID = "ddkjiahejlhfcafbddmgiahcphecmpfh";

test("idDepuisSaisie : id seul, adresse du Store, ancienne adresse ; refuse une adresse d'un autre site", () => {
  expect(idDepuisSaisie(ID)).toBe(ID);
  expect(idDepuisSaisie(`  ${ID}\n`)).toBe(ID);
  expect(idDepuisSaisie(`https://chromewebstore.google.com/detail/ublock-origin-lite/${ID}`)).toBe(ID);
  expect(idDepuisSaisie(`https://chromewebstore.google.com/detail/ublock-origin-lite/${ID}?hl=fr&pli=1`)).toBe(ID);
  expect(idDepuisSaisie(`https://chromewebstore.google.com/detail/${ID}/`)).toBe(ID);
  expect(idDepuisSaisie(`https://chromewebstore.google.com/detail/ublock-origin-lite/${ID}#avis`)).toBe(ID);
  expect(idDepuisSaisie(`https://chrome.google.com/webstore/detail/ublock-origin-lite/${ID}`)).toBe(ID);
  expect(idDepuisSaisie(`https://chrome.google.com/webstore/detail/${ID}?hl=en`)).toBe(ID);

  for (const refusee of [
    `https://exemple.com/detail/ublock/${ID}`,
    `https://chromewebstore.google.com.exemple.com/detail/x/${ID}`,
    `https://exemple.com/?u=https://chromewebstore.google.com/detail/x/${ID}`,
    `http://chromewebstore.google.com/detail/x/${ID}`,
    `https://chromewebstore.google.com/category/extensions/${ID}`,
    `https://chrome.google.com/detail/x/${ID}`,
    `https://user@chromewebstore.google.com/detail/x/${ID}`,
    `https://chromewebstore.google.com:8443/detail/x/${ID}`,
    `https://chromewebstore.google.com/detail/x/${ID}/autre`,
    ID.toUpperCase(),
    ID.slice(1),
    `${ID}q`,
    "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
    "",
    "n'importe quoi",
  ])
    expect(idDepuisSaisie(refusee), refusee).toBeNull();
});

// ——— beforeInstall de la bibliothèque ———

const vue = { id: 1 };
const cadre = { nom: "cadre de la page du Store" };
const espace = { id: "e1", nom: "Perso", icone: "🏠", epingles: [], prive: false, profil: "defaut" } as unknown as Espace;

function sessionAvec(chargees: string[]) {
  return { extensions: { getExtension: (id: string) => (chargees.includes(id) ? { id } : null) } };
}

test("beforeInstall d'un onglet inconnu : deny", async () => {
  cadres.set(cadre, vue);
  const installer = vi.fn(async () => ({ ok: true as const }));
  const avant = avantInstallation({ profil: "defaut", session: sessionAvec([ID]) as never, contexteDe: () => null, installer });
  expect(await avant({ id: ID, frame: cadre } as never)).toEqual({ action: "deny" });
  // Un cadre sans vue (détruit) : deny aussi.
  expect(await avant({ id: ID, frame: { autre: true } } as never)).toEqual({ action: "deny" });
  expect(installer).not.toHaveBeenCalled();
});

test("beforeInstall : allow seulement si notre installation a réussi ET l'extension est chargée dans cette session", async () => {
  cadres.set(cadre, vue);
  const contexte = { profil: "defaut", espace, fenetre: "f1" };
  const contexteDe = (wc: unknown) => (wc === vue ? contexte : null);

  // Installée et chargée : la bibliothèque la trouve chargée et n'installe rien d'elle-même.
  const installer = vi.fn(async () => ({ ok: true as const }));
  expect(await avantInstallation({ profil: "defaut", session: sessionAvec([ID]) as never, contexteDe, installer })({ id: ID, frame: cadre } as never)).toEqual({
    action: "allow",
  });
  expect(installer).toHaveBeenCalledWith(ID, contexte);

  // Coupure générale : installée et accordée, mais rien n'est chargé → deny (sinon la bibliothèque la chargerait
  // elle-même depuis store/ ou la téléchargerait, hors de notre programme).
  const coupee = avantInstallation({ profil: "defaut", session: sessionAvec([]) as never, contexteDe, installer: async () => ({ ok: true }) });
  expect(await coupee({ id: ID, frame: cadre } as never)).toEqual({ action: "deny" });

  // Notre installation a échoué (carte refusée, CRX invalide) : deny, même si une autre est chargée.
  const echec = avantInstallation({ profil: "defaut", session: sessionAvec([ID]) as never, contexteDe, installer: async () => ({ ok: false, erreur: "non" }) });
  expect(await echec({ id: ID, frame: cadre } as never)).toEqual({ action: "deny" });

  // L'onglet est dans un espace d'un autre profil que la session : deny, sans installer.
  const autre = vi.fn(async () => ({ ok: true as const }));
  const ailleurs = avantInstallation({ profil: "autre", session: sessionAvec([ID]) as never, contexteDe, installer: autre });
  expect(await ailleurs({ id: ID, frame: cadre } as never)).toEqual({ action: "deny" });
  expect(autre).not.toHaveBeenCalled();

  // Une installation qui lève : deny, jamais d'exception vers la bibliothèque.
  const leve = avantInstallation({
    profil: "defaut",
    session: sessionAvec([ID]) as never,
    contexteDe,
    installer: async () => {
      throw new Error("boum");
    },
  });
  const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await leve({ id: ID, frame: cadre } as never)).toEqual({ action: "deny" });
  erreur.mockRestore();
});

// ——— installerStore : faux Store local, vrai téléchargement vérifié ———

const servis = new Map<string, Buffer>();
let serveur: Server;
let base: string;
let requetes = 0;
const temporaires: string[] = [];
const temporaire = (prefixe: string) => {
  const d = mkdtempSync(join(tmpdir(), prefixe));
  temporaires.push(d);
  return d;
};
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

/** Une extension du Store servie par le faux Store ; son id. */
function publier(manifeste: Record<string, unknown> = {}, o: { signatureFausse?: boolean } = {}): string {
  const source = temporaire("webaios-store-src-");
  writeFileSync(
    join(source, "manifest.json"),
    JSON.stringify({ manifest_version: 3, name: "Bloqueur", version: "1.0.0", permissions: ["declarativeNetRequest"], ...manifeste }),
  );
  const { crx, id } = construireCrx(source, o);
  servis.set(`/${id}.crx`, crx);
  return id;
}

const nav = {
  espaces: [espace, { ...espace, id: "e2", nom: "Travail", profil: "travail" }],
  profils: [{ id: "defaut" }, { id: "travail" }],
  fenetres: [],
  onglets: {},
} as unknown as EtatNavigateur;

let dossier: string;
let gardes: string;
let etat: EtatExtensions;
let cartes: CarteExtension[];
let reponse: (c: CarteExtension) => ReponseAccord;
let preparees: string[];

beforeEach(() => {
  dossier = temporaire("webaios-store-dossier-");
  gardes = temporaire("webaios-store-gardes-");
  writeFileSync(join(gardes, "webaios-correctifs-page.js"), "// correctifs\n");
  etat = { version: 1, toutesCoupees: false, extensions: {} };
  cartes = [];
  preparees = [];
  reponse = (c) => ({ accepte: true, empreinte: c.empreinte });
  requetes = 0;
});

const dependances = () => ({
  dossier,
  dossierGardes: gardes,
  urlCrx: (id: string) => `${base}/${id}.crx`,
  etatNavigateur: () => nav,
  etatExtensions: () => etat,
  modifier: async (changer: (e: EtatExtensions, p: ReadonlySet<IdProfil>) => EtatExtensions) => (etat = changer(etat, new Set())),
  demanderAccord: async (c: CarteExtension) => {
    cartes.push(c);
    return reponse(c);
  },
  preparer: async (cle: string, chemin: string) => void preparees.push(`${cle}:${chemin}`),
});

const contexte = (profil: IdProfil = "defaut", e: Espace = espace) => ({ profil, espace: e, fenetre: "f1" });
const contenu = (d: string) => (existsSync(d) ? readdirSync(d) : []);

test("installerStore, carte acceptée : déplacée sous store/<id>/<version>_0, préparée, accord = portée montrée, active dans ce profil", async () => {
  const id = publier();
  expect(await installerStore(id, contexte(), dependances())).toEqual({ ok: true });
  const version = join(dossier, "store", id, "1.0.0_0");
  expect(existsSync(join(version, "manifest.json"))).toBe(true);
  expect(contenu(join(dossier, "store-attente"))).toEqual([]);
  expect(preparees).toEqual([`store:${id}:${version}`]);
  expect(cartes).toHaveLength(1);
  expect(cartes[0]).toMatchObject({ cle: `store:${id}`, source: "store", nom: "Bloqueur", version: "1.0.0", espaceId: "e1", maj: null });
  const x = etat.extensions[`store:${id}`]!;
  expect(x).toMatchObject({ source: "store", idChrome: id, nom: "Bloqueur", version: "1.0.0", profils: ["defaut"], desactivee: null, majEnAttente: null });
  expect(empreintePortee(x.accord!)).toBe(cartes[0]!.empreinte);
  expect(x.accord!.permissions).toEqual(["declarativeNetRequest"]);
});

test("installerStore, carte refusée : rien dans store/, rien dans store-attente/, rien au registre", async () => {
  const id = publier();
  reponse = (c) => ({ accepte: false, empreinte: c.empreinte });
  expect(await installerStore(id, contexte(), dependances())).toEqual({ ok: false, erreur: INSTALLATION_REFUSEE });
  expect(contenu(join(dossier, "store"))).toEqual([]);
  expect(contenu(join(dossier, "store-attente"))).toEqual([]);
  expect(etat.extensions).toEqual({});
  expect(preparees).toEqual([]);
});

test("installerStore : une acceptation pour une autre portée (empreinte différente) n'écrit rien", async () => {
  const id = publier();
  reponse = () => ({ accepte: true, empreinte: "0".repeat(64) });
  expect(await installerStore(id, contexte(), dependances())).toEqual({ ok: false, erreur: INSTALLATION_REFUSEE });
  expect(contenu(join(dossier, "store"))).toEqual([]);
  expect(etat.extensions).toEqual({});
});

test("installerStore : CRX mal signé → CRX_INVALIDE ; Store injoignable → ERREUR_STORE ; aucune carte, rien laissé", async () => {
  const mal = publier({ name: "Mal signée" }, { signatureFausse: true });
  expect(await installerStore(mal, contexte(), dependances())).toEqual({ ok: false, erreur: CRX_INVALIDE });
  const absent = "a".repeat(32);
  const d = { ...dependances(), urlCrx: () => "http://127.0.0.1:1/x.crx" };
  expect(await installerStore(absent, contexte(), d)).toEqual({ ok: false, erreur: ERREUR_STORE });
  expect(cartes).toEqual([]);
  expect(contenu(join(dossier, "store"))).toEqual([]);
  expect(contenu(join(dossier, "store-attente"))).toEqual([]);
  expect(etat.extensions).toEqual({});
});

test("installerStore : un manifeste refusé (MV2) n'est jamais montré ni installé", async () => {
  const id = publier({ manifest_version: 2, name: "Ancienne" });
  const r = await installerStore(id, contexte(), dependances());
  expect(r.ok).toBe(false);
  expect((r as { erreur: string }).erreur).toContain("Manifest V3");
  expect(cartes).toEqual([]);
  expect(contenu(join(dossier, "store-attente"))).toEqual([]);
  expect(contenu(join(dossier, "store"))).toEqual([]);
});

test("installerStore : identifiant mal formé → SAISIE_INVALIDE, aucune requête", async () => {
  expect(await installerStore("../../etc", contexte(), dependances())).toEqual({ ok: false, erreur: SAISIE_INVALIDE });
  expect(requetes).toBe(0);
});

test("installerStore : des restes d'un essai interrompu (store-attente/, store/ sans entrée) ne font pas échouer le nouveau téléchargement", async () => {
  const id = publier();
  // Même version déjà décompressée dans l'attente et dans store/ (sans entrée au registre) : le `rename` de la
  // bibliothèque, puis le nôtre, échoueraient en ENOTEMPTY.
  for (const d of [join(dossier, "store-attente", id, "1.0.0_0"), join(dossier, "store", id, "1.0.0_0")]) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "reste.txt"), "reste");
  }
  expect(await installerStore(id, contexte(), dependances())).toEqual({ ok: true });
  expect(existsSync(join(dossier, "store", id, "1.0.0_0", "reste.txt"))).toBe(false);
  expect(existsSync(join(dossier, "store", id, "1.0.0_0", "manifest.json"))).toBe(true);
  expect(contenu(join(dossier, "store-attente"))).toEqual([]);
});

test("installerStore déjà installée : pas de téléchargement, la carte (même portée), puis active aussi dans l'autre profil", async () => {
  const id = publier();
  expect(await installerStore(id, contexte(), dependances())).toEqual({ ok: true });
  expect(requetes).toBe(1);
  const travail = { ...espace, id: "e2", nom: "Travail", profil: "travail" } as Espace;
  expect(await installerStore(id, contexte("travail", travail), dependances())).toEqual({ ok: true });
  expect(requetes).toBe(1);
  expect(cartes).toHaveLength(2);
  expect(cartes[1]).toMatchObject({ cle: `store:${id}`, espaceId: "e2", empreinte: cartes[0]!.empreinte });
  expect(etat.extensions[`store:${id}`]!.profils).toEqual(["defaut", "travail"]);

  // Refusée dans un troisième temps : rien ne change.
  reponse = (c) => ({ accepte: false, empreinte: c.empreinte });
  const avant = etat;
  const autre = { ...espace, id: "e3", profil: "troisieme" } as Espace;
  expect(await installerStore(id, contexte("troisieme", autre), dependances())).toEqual({ ok: false, erreur: INSTALLATION_REFUSEE });
  expect(etat).toBe(avant);
});

test("installerStore déjà active dans ce profil : rien à faire, ni carte ni téléchargement", async () => {
  const id = publier();
  await installerStore(id, contexte(), dependances());
  cartes = [];
  expect(await installerStore(id, contexte(), dependances())).toEqual({ ok: true });
  expect(cartes).toEqual([]);
  expect(requetes).toBe(1);
});

test("installerStore : deux demandes simultanées du même id ne téléchargent qu'une fois (une à la fois par id)", async () => {
  const id = publier();
  const travail = { ...espace, id: "e2", nom: "Travail", profil: "travail" } as Espace;
  const [a, b] = await Promise.all([installerStore(id, contexte(), dependances()), installerStore(id, contexte("travail", travail), dependances())]);
  expect(a).toEqual({ ok: true });
  expect(b).toEqual({ ok: true });
  expect(requetes).toBe(1);
  expect(etat.extensions[`store:${id}`]!.profils.sort()).toEqual(["defaut", "travail"]);
});

test("installerStore pendant la coupure générale, depuis l'interface de WebAiOs : la carte est demandée malgré la coupure, l'extension installée et accordée", async () => {
  const id = publier();
  etat = { ...etat, toutesCoupees: true };
  const d = dependances();
  const demander = vi.fn(d.demanderAccord);
  expect(await installerStore(id, { ...contexte(), depuisInterface: true }, { ...d, demanderAccord: demander })).toEqual({ ok: true });
  expect(demander).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ pendantCoupure: true, fenetre: "f1" }));
  expect(etat.toutesCoupees).toBe(true);
  expect(etat.extensions[`store:${id}`]!.profils).toEqual(["defaut"]);
});

test("installerStore pendant la coupure générale, depuis la page du Store : refus, ni carte ni téléchargement", async () => {
  const id = publier();
  etat = { ...etat, toutesCoupees: true };
  expect(await installerStore(id, contexte(), dependances())).toEqual({ ok: false, erreur: TOUTES_COUPEES });
  expect(cartes).toEqual([]);
  expect(requetes).toBe(0);
  expect(etat.extensions).toEqual({});
  // Hors coupure, la page du Store ne demande jamais `pendantCoupure`.
  etat = { ...etat, toutesCoupees: false };
  const d = dependances();
  const demander = vi.fn(d.demanderAccord);
  await installerStore(id, contexte(), { ...d, demanderAccord: demander });
  expect(demander).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ pendantCoupure: false }));
});

test("installerStore : si l'inscription au registre échoue, la version déplacée et préparée est retirée", async () => {
  const id = publier();
  const d = dependances();
  const r = await installerStore(id, contexte(), {
    ...d,
    modifier: async () => {
      throw new Error("disque plein");
    },
  });
  expect(r).toEqual({ ok: false, erreur: "disque plein" });
  expect(existsSync(join(dossier, "store", id, "1.0.0_0"))).toBe(false);
  expect(contenu(join(dossier, "store-attente"))).toEqual([]);
});

test("installerStore d'une extension inscrite dont les fichiers manquent : téléchargée de nouveau, sa désactivation et ses profils gardés, statut explicite", async () => {
  const id = publier();
  await installerStore(id, contexte(), dependances());
  const cle = `store:${id}`;
  const desactivee = { raison: "plantages" as const, le: "2026-10-30T00:00:00.000Z" };
  etat = { ...etat, extensions: { ...etat.extensions, [cle]: { ...etat.extensions[cle]!, profils: ["defaut", "ailleurs"], desactivee } } };
  rmSync(join(dossier, "store", id), { recursive: true, force: true });
  const travail = { ...espace, id: "e2", nom: "Travail", profil: "travail" } as Espace;
  expect(await installerStore(id, contexte("travail", travail), dependances())).toEqual({ ok: false, erreur: DESACTIVEE_PLANTAGES });
  expect(existsSync(join(dossier, "store", id, "1.0.0_0", "manifest.json"))).toBe(true);
  expect(etat.extensions[cle]!.desactivee).toEqual(desactivee);
  expect(etat.extensions[cle]!.profils).toEqual(["defaut", "ailleurs", "travail"]);
});

test("installerStore déjà installée mais désactivée : statut explicite, ni carte ni changement", async () => {
  const id = publier();
  await installerStore(id, contexte(), dependances());
  const cle = `store:${id}`;
  etat = { ...etat, extensions: { ...etat.extensions, [cle]: { ...etat.extensions[cle]!, desactivee: { raison: "portee-elargie", le: "2026-10-30T00:00:00.000Z" } } } };
  const avant = etat;
  cartes = [];
  expect(await installerStore(id, contexte(), dependances())).toEqual({ ok: false, erreur: DESACTIVEE_PORTEE });
  const travail = { ...espace, id: "e2", nom: "Travail", profil: "travail" } as Espace;
  expect(await installerStore(id, contexte("travail", travail), dependances())).toEqual({ ok: false, erreur: DESACTIVEE_PORTEE });
  expect(cartes).toEqual([]);
  expect(etat).toBe(avant);
});

test("avec la vraie préparation : le manifeste préparé redonne l'empreinte de la première carte", async () => {
  // Scripts de contenu et pas de fond : la préparation réécrit le manifeste (correctifs en tête, fond minimal).
  const id = publier({ name: "Cacheur", content_scripts: [{ matches: ["https://exemple.com/*"], js: ["c.js"] }], permissions: ["storage"] });
  const d = { ...dependances(), preparer: (_cle: string, chemin: string) => preparerStore(chemin, gardes) };
  await installerStore(id, contexte(), d);
  const prepare = JSON.parse(readFileSync(join(dossier, "store", id, "1.0.0_0", "manifest.json"), "utf8"));
  expect(prepare.background).toEqual({ service_worker: "webaios-fond.js" });
  expect(prepare.content_scripts[0].js[0]).toBe("webaios-correctifs-page.js");
  const travail = { ...espace, id: "e2", nom: "Travail", profil: "travail" } as Espace;
  expect(await installerStore(id, contexte("travail", travail), d)).toEqual({ ok: true });
  expect(cartes).toHaveLength(2);
  expect(cartes[1]!.empreinte).toBe(cartes[0]!.empreinte);
  expect(empreintePortee(etat.extensions[`store:${id}`]!.accord!)).toBe(cartes[0]!.empreinte);
  expect(requetes).toBe(1);
});

test("desinstallerStore : entrée retirée du registre (les sessions suivent), puis dossier store/<id> effacé", async () => {
  const id = publier();
  await installerStore(id, contexte(), dependances());
  // Une autre extension reste.
  etat = activerRegistre(
    {
      ...etat,
      extensions: {
        ...etat.extensions,
        [`store:${"b".repeat(32)}`]: { ...etat.extensions[`store:${id}`]!, idChrome: "b".repeat(32), profils: [] },
      },
    },
    `store:${"b".repeat(32)}`,
    "defaut",
    new Set(),
  );
  let dossierPresentPendantRetrait: boolean | undefined;
  const d = dependances();
  await desinstallerStore(`store:${id}`, {
    ...d,
    modifier: async (changer) => {
      dossierPresentPendantRetrait = existsSync(join(dossier, "store", id));
      return d.modifier(changer);
    },
  });
  expect(dossierPresentPendantRetrait).toBe(true);
  expect(Object.keys(etat.extensions)).toEqual([`store:${"b".repeat(32)}`]);
  expect(existsSync(join(dossier, "store", id))).toBe(false);
});

// ——— Plan 16, tâche 3 : les applis de site ———

test("retirerDuProfilStore depuis le dernier profil d'une extension active dans une appli : retirée du profil seulement, store/<id> reste, l'entrée garde applis", async () => {
  const { retirerDuProfilStore } = await import("../../src/main/extensions/store");
  const id = publier();
  await installerStore(id, contexte(), dependances());
  const cle = `store:${id}`;
  etat = { ...etat, extensions: { ...etat.extensions, [cle]: { ...etat.extensions[cle]!, applis: { vidola: "E1" } } } };
  await retirerDuProfilStore(cle, "defaut", dependances());
  expect(etat.extensions[cle]).toMatchObject({ profils: [], applis: { vidola: "E1" } });
  expect(existsSync(join(dossier, "store", id, "1.0.0_0", "manifest.json"))).toBe(true);
});

test("desinstallerStore : effacerDansSites reçoit les applis (activations et vues site:*) et le dossier de la version, qui existe encore à ce moment", async () => {
  const id = publier();
  await installerStore(id, contexte(), dependances());
  const cle = `store:${id}`;
  etat = {
    ...etat,
    extensions: { ...etat.extensions, [cle]: { ...etat.extensions[cle]!, applis: { vidola: "E1" }, vues: { defaut: "1.0.0", "site:autre": "1.0.0", "site:vidola": "1.0.0" } } },
  };
  const appels: { cle: string; chemin: string; sites: string[]; present: boolean; inscrite: boolean }[] = [];
  await desinstallerStore(cle, {
    ...dependances(),
    effacerDansSites: async (c, chemin, sites) =>
      void appels.push({ cle: c, chemin, sites: [...sites].sort(), present: existsSync(join(chemin, "manifest.json")), inscrite: c in etat.extensions }),
  });
  expect(appels).toEqual([{ cle, chemin: join(dossier, "store", id, "1.0.0_0"), sites: ["autre", "vidola"], present: true, inscrite: false }]);
  expect(existsSync(join(dossier, "store", id))).toBe(false);
});

test("installerStore d'une extension déjà inscrite garde ses applis", async () => {
  const id = publier();
  await installerStore(id, contexte(), dependances());
  const cle = `store:${id}`;
  etat = { ...etat, extensions: { ...etat.extensions, [cle]: { ...etat.extensions[cle]!, applis: { vidola: "E1" } } } };
  // Fichiers disparus : téléchargée de nouveau, l'entrée réécrite.
  rmSync(join(dossier, "store", id), { recursive: true, force: true });
  const travail = { ...espace, id: "e2", nom: "Travail", profil: "travail" } as Espace;
  expect(await installerStore(id, contexte("travail", travail), dependances())).toEqual({ ok: true });
  expect(etat.extensions[cle]).toMatchObject({ profils: ["defaut", "travail"], applis: { vidola: "E1" } });
  // Déjà installée : activée dans un autre profil, applis gardées.
  etat = { ...etat, extensions: { ...etat.extensions, [cle]: { ...etat.extensions[cle]!, profils: [] } } };
  expect(await installerStore(id, contexte(), dependances())).toEqual({ ok: true });
  expect(etat.extensions[cle]).toMatchObject({ profils: ["defaut"], applis: { vidola: "E1" } });
});
