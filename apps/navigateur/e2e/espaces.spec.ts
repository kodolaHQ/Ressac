import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dansLaVue, lancer, nouveauProfil, ouvrirOnglet, serveurTest } from "./aide";

let serveur: Awaited<ReturnType<typeof serveurTest>>;
test.beforeAll(async () => (serveur = await serveurTest()));
test.afterAll(() => serveur.fermer());

const onglets = '[data-testid^="onglet-"]';
type Espace = { id: string; nom: string; icone: string; prive: boolean; profil: string };
type Api = { webaios: { fenetreId: string; agir(a: unknown): void; surEtat(r: (e: { espaces: Espace[] }) => void): () => void } };

/** L'état tel que l'interface le reçoit. */
const espaces = (fenetre: Page) =>
  fenetre.evaluate(
    () =>
      new Promise<Espace[]>((ok) => {
        const fin = (window as unknown as Api).webaios.surEtat((e) => {
          ok(e.espaces);
          setTimeout(() => fin());
        });
      }),
  );

const agir = (fenetre: Page, action: Record<string, unknown>) =>
  fenetre.evaluate((a) => {
    const w = window as unknown as Api;
    w.webaios.agir({ fenetreId: w.webaios.fenetreId, ...a });
  }, action);

/** Les vues dont l'URL contient `morceau`, avec leur partition. */
const vuesDe = (app: ElectronApplication, morceau: string) =>
  app.evaluate(
    ({ webContents, session }, morceau) =>
      webContents
        .getAllWebContents()
        .filter((w) => !w.isDestroyed() && w.getURL().includes(morceau))
        .map((w) => (w.session === session.fromPartition("persist:webaios") ? "persist:webaios" : "autre")),
    morceau,
  );

test("chaque profil de connexion a ses cookies ; changer le profil d'un espace recharge ses onglets dans le nouveau", async () => {
  const { app, fenetre, profil, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/cookie`);
  await expect.poll(() => dansLaVue(app, "/cookie", "document.title")).toBe("cookie");

  await agir(fenetre, { type: "creerEspace", nom: "Travail", icone: "💼", prive: false, profil: "nouveau" });
  await expect(fenetre.locator(onglets)).toHaveCount(0);
  await ouvrirOnglet(fenetre, `${serveur.url}/lire-cookie`);
  await expect.poll(() => dansLaVue(app, "/lire-cookie", "document.title")).toBe("aucun");
  expect(await dansLaVue(app, "/lire-cookie", "document.cookie")).toBe("");
  expect(await vuesDe(app, "/lire-cookie")).toEqual(["autre"]);

  const travail = (await espaces(fenetre)).find((e) => e.nom === "Travail")!;
  expect(travail.profil).not.toBe("defaut");
  const ancienne = `persist:webaios-${travail.profil}`;
  const cookies = () => app.evaluate(({ session }, p) => session.fromPartition(p).cookies.get({}), ancienne);
  await app.evaluate(({ session }, [p, url]) => session.fromPartition(p).cookies.set({ url, name: "ancien", value: "1", expirationDate: 2e9 }), [
    ancienne,
    serveur.url,
  ] as const);
  expect(await cookies()).toHaveLength(1);
  // La partition est rangée sous ce nom : celui que l'effacement au démarrage cherche.
  expect(existsSync(join(profil, "Partitions", `webaios-${travail.profil}`))).toBe(true);
  await agir(fenetre, { type: "reglerEspace", id: travail.id, nom: travail.nom, icone: travail.icone, prive: false, profil: "defaut" });
  await expect.poll(() => dansLaVue(app, "/lire-cookie", "document.title")).toBe("essai=1");
  expect(await dansLaVue(app, "/lire-cookie", "document.cookie")).toBe("essai=1");
  // Aucune vue de l'ancienne session ne reste.
  expect(await vuesDe(app, "/lire-cookie")).toEqual(["persist:webaios"]);
  // Plus aucun espace n'utilise l'ancien profil : il est effacé.
  await expect.poll(cookies).toEqual([]);
  await fermer();
});

test("une session d'avant les espaces configurables (v1) retrouve ses onglets et est réécrite en v2", async () => {
  const profil = nouveauProfil();
  const v1 = {
    version: 1,
    espaces: [{ id: "e1", nom: "Perso", icone: "🏠", epingles: [] }],
    essentiels: [],
    onglets: Object.fromEntries(
      ["a", "b"].map((n) => [
        `o-${n}`,
        { id: `o-${n}`, fenetreId: "f1", espaceId: "e1", url: `${serveur.url}/${n}.html`, titre: n, favicon: null, lien: null, ouvertParAgent: false, zoom: 1 },
      ]),
    ),
    fenetres: [
      {
        id: "f1",
        espaceActif: "e1",
        ordre: { e1: ["o-a", "o-b"] },
        actif: { e1: "o-b" },
        compact: false,
        panneauAgentOuvert: false,
        fermesRecemment: [],
        cadre: null,
      },
    ],
    reglages: { moteur: "google", profilAgent: "claude", largeurPanneauAgent: 420 },
  };
  writeFileSync(join(profil, "session.json"), JSON.stringify(v1));
  const { app, fenetre, fermer } = await lancer({ profil });
  await expect(fenetre.locator(onglets)).toHaveCount(2);
  await expect.poll(() => dansLaVue(app, "/b.html", "document.title")).toBe("Page B");
  await expect.poll(() => JSON.parse(readFileSync(join(profil, "session.json"), "utf8")).version).toBe(2);
  const ecrit = JSON.parse(readFileSync(join(profil, "session.json"), "utf8"));
  expect(ecrit.profils).toEqual([{ id: "defaut" }]);
  expect(Object.keys(ecrit.onglets).sort()).toEqual(["o-a", "o-b"]);
  await fermer();
});
