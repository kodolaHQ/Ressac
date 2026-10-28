import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dansLaVue, lancer, ouvrirOnglet, serveurTest } from "./aide";

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

test("une session d'avant les espaces configurables (v1) retrouve ses onglets, son essentiel et ses cookies, et est réécrite en v2", async () => {
  // Un premier lancement pose un cookie dans la partition de toujours, comme l'aurait fait le navigateur d'avant.
  const avant = await lancer();
  const profil = avant.profil;
  await ouvrirOnglet(avant.fenetre, `${serveur.url}/cookie`);
  await expect.poll(() => dansLaVue(avant.app, "/cookie", "document.title")).toBe("cookie");
  await avant.app.evaluate(({ session }) => session.fromPartition("persist:webaios").cookies.flushStore());
  await avant.fermer();
  const onglet = (id: string, url: string, lien: unknown = null) => ({
    id,
    fenetreId: "f1",
    espaceId: "e1",
    url,
    titre: id,
    favicon: null,
    lien,
    ouvertParAgent: false,
    zoom: 1,
  });
  const v1 = {
    version: 1,
    espaces: [{ id: "e1", nom: "Perso", icone: "🏠", epingles: [] }],
    essentiels: [{ id: "fav-c", url: `${serveur.url}/texte.html`, titre: "Texte", favicon: null }],
    onglets: {
      "o-a": onglet("o-a", `${serveur.url}/a.html`),
      "o-b": onglet("o-b", `${serveur.url}/b.html`),
      "o-c": onglet("o-c", `${serveur.url}/texte.html`, { type: "essentiel", id: "fav-c" }),
    },
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
  expect(Object.keys(ecrit.onglets).sort()).toEqual(["o-a", "o-b", "o-c"]);
  expect(ecrit.essentiels).toEqual(v1.essentiels);
  expect(ecrit.onglets["o-c"].lien).toEqual({ type: "essentiel", id: "fav-c" });
  // L'essentiel s'ouvre sur son onglet d'avant, dans la partition de toujours.
  await fenetre.getByTestId("favori-fav-c").click();
  await expect.poll(() => dansLaVue(app, "/texte.html", "document.title")).toBe("Texte");
  expect(await vuesDe(app, "/texte.html")).toEqual(["persist:webaios"]);
  expect(Object.keys(JSON.parse(readFileSync(join(profil, "session.json"), "utf8")).onglets)).toHaveLength(3);
  // Le cookie d'avant est toujours là.
  await ouvrirOnglet(fenetre, `${serveur.url}/lire-cookie`);
  await expect.poll(() => dansLaVue(app, "/lire-cookie", "document.title")).toBe("essai=1");
  await fermer();
});

// --- La modale de réglages d'un espace ---

const boutonsEspace = '[data-testid^="espace-"]';
const modaleEspace = (fenetre: Page, titre: string) => fenetre.getByRole("dialog", { name: titre });

test("« + » ouvre la modale « Nouvel espace » : pas privé, aucun profil choisi ; « Créer » attend le choix puis ajoute l'espace", async () => {
  const { fenetre, fermer } = await lancer();
  await agir(fenetre, { type: "creerEspace", nom: "Travail", icone: "💼", prive: false, profil: "nouveau" });
  await expect(fenetre.locator(boutonsEspace, { hasText: "💼" })).toHaveAttribute("aria-current", "true");
  const travail = (await espaces(fenetre)).find((e) => e.nom === "Travail")!;

  await fenetre.getByTestId("nouvel-espace").click();
  const modale = modaleEspace(fenetre, "Nouvel espace");
  await expect(modale).toBeVisible();
  await expect(modale.getByRole("heading")).toHaveText("Nouvel espace");
  await expect(modale.getByLabel("Espace privé")).not.toBeChecked();
  const select = modale.getByLabel("Profil de connexion");
  await expect(select.locator("option")).toHaveText([
    "Choisir un profil…",
    "Nouveau profil",
    "Partagé avec « Perso »",
    "Partagé avec « Travail »",
  ]);
  await expect(select.locator("option:checked")).toHaveText("Choisir un profil…");
  await expect(select.locator("option").first()).toBeDisabled();
  await expect(modale.getByRole("button", { name: "Annuler" })).toBeVisible();

  await modale.getByLabel("Icône").fill("🎮");
  await modale.getByLabel("Nom de l'espace").fill("Jeux");
  // Sans profil choisi : « Créer » inactif, Entrée ne fait rien.
  const creer = modale.getByRole("button", { name: "Créer" });
  await expect(creer).toBeDisabled();
  await modale.getByLabel("Nom de l'espace").press("Enter");
  await expect(modale).toBeVisible();
  expect((await espaces(fenetre)).some((e) => e.nom === "Jeux")).toBe(false);

  await select.selectOption({ label: "Partagé avec « Travail »" });
  await expect(creer).toBeEnabled();
  await creer.click();
  await expect(modale).toBeHidden();
  await expect(fenetre.locator(boutonsEspace, { hasText: "🎮" })).toHaveAttribute("aria-current", "true");
  const jeux = (await espaces(fenetre)).find((e) => e.nom === "Jeux")!;
  expect(jeux).toMatchObject({ icone: "🎮", prive: false, profil: travail.profil });

  // « Nouveau profil » crée un profil à part.
  await fenetre.getByTestId("nouvel-espace").click();
  await modale.getByLabel("Nom de l'espace").fill("Neuf");
  await select.selectOption({ label: "Nouveau profil" });
  await modale.getByLabel("Nom de l'espace").press("Enter");
  await expect(modale).toBeHidden();
  await expect.poll(async () => (await espaces(fenetre)).find((e) => e.nom === "Neuf")?.profil).toBeTruthy();
  const neuf = (await espaces(fenetre)).find((e) => e.nom === "Neuf")!;
  expect([travail.profil, "defaut", "nouveau"]).not.toContain(neuf.profil);
  await fermer();
});

test("« Réglages » montre les valeurs de l'espace ; privé et son propre profil s'enregistrent", async () => {
  const { fenetre, fermer } = await lancer();
  await agir(fenetre, { type: "creerEspace", nom: "Banque", icone: "💶", prive: false, profil: "defaut" });
  await fenetre.locator(boutonsEspace, { hasText: "💶" }).click({ button: "right" });
  await expect(fenetre.getByRole("menuitem", { name: "Renommer" })).toHaveCount(0);
  await fenetre.getByRole("menuitem", { name: "Réglages" }).click();
  const modale = modaleEspace(fenetre, "Réglages de l'espace");
  await expect(modale).toBeVisible();
  await expect(modale.getByLabel("Icône")).toHaveValue("💶");
  await expect(modale.getByLabel("Nom de l'espace")).toHaveValue("Banque");
  await expect(modale.getByLabel("Espace privé")).not.toBeChecked();
  await expect(modale).toContainText("L'agent ne voit pas ces onglets, ne lit rien, n'a pas les outils de développement, et rien n'est retenu dans sa mémoire.");
  await expect(modale).toContainText(
    "Cookies, comptes connectés, autorisations des sites. Changer de profil : les onglets de l'espace se rechargent, tu devras peut-être te reconnecter.",
  );
  const select = modale.getByLabel("Profil de connexion");
  // L'espace réglé n'est pas nommé parmi ceux qui partagent le profil.
  await expect(select.locator("option")).toHaveText(["Son propre profil", "Partagé avec « Perso »"]);
  await expect(select.locator("option:checked")).toHaveText("Partagé avec « Perso »");

  await modale.getByLabel("Espace privé").check();
  await select.selectOption({ label: "Son propre profil" });
  await modale.getByRole("button", { name: "Enregistrer" }).click();
  await expect(modale).toBeHidden();
  await expect.poll(async () => (await espaces(fenetre)).find((e) => e.nom === "Banque")?.prive).toBe(true);
  const banque = (await espaces(fenetre)).find((e) => e.nom === "Banque")!;
  expect(banque.profil).not.toBe("defaut");

  // Rouverte, la modale montre son propre profil : le garder ne change rien.
  await fenetre.locator(boutonsEspace, { hasText: "💶" }).click({ button: "right" });
  await fenetre.getByRole("menuitem", { name: "Réglages" }).click();
  await expect(modale.getByLabel("Espace privé")).toBeChecked();
  await expect(modale.getByLabel("Profil de connexion").locator("option:checked")).toHaveText("Son propre profil");
  await modale.getByLabel("Nom de l'espace").fill("Banque pro");
  await modale.getByLabel("Nom de l'espace").press("Enter");
  await expect(modale).toBeHidden();
  await expect.poll(async () => (await espaces(fenetre)).find((e) => e.id === banque.id)).toMatchObject({ nom: "Banque pro", profil: banque.profil });
  await fermer();
});

test("Échap ferme la modale sans rien changer", async () => {
  const { fenetre, fermer } = await lancer();
  const avant = await espaces(fenetre);
  await fenetre.locator(boutonsEspace, { hasText: "🏠" }).click({ button: "right" });
  await fenetre.getByRole("menuitem", { name: "Réglages" }).click();
  const modale = modaleEspace(fenetre, "Réglages de l'espace");
  // Le reste de la fenêtre est inerte derrière la modale, la page figée sous un voile.
  await expect(fenetre.getByTestId("barre-laterale").locator("xpath=ancestor::*[@inert]")).toHaveCount(1);
  await modale.getByLabel("Nom de l'espace").fill("Autre");
  await modale.getByLabel("Espace privé").check();
  await fenetre.keyboard.press("Escape");
  await expect(modale).toBeHidden();
  expect(await espaces(fenetre)).toEqual(avant);

  await fenetre.getByTestId("nouvel-espace").click();
  await modaleEspace(fenetre, "Nouvel espace").getByLabel("Nom de l'espace").fill("Jeux");
  await fenetre.keyboard.press("Escape");
  await expect(modaleEspace(fenetre, "Nouvel espace")).toBeHidden();
  expect(await espaces(fenetre)).toEqual(avant);
  await fermer();
});

test("le bouton d'un espace privé porte un cadenas", async () => {
  const { fenetre, fermer } = await lancer();
  await agir(fenetre, { type: "creerEspace", nom: "Secret", icone: "🕵️", prive: true, profil: "defaut" });
  const secret = fenetre.locator(boutonsEspace, { hasText: "🕵️" });
  await expect(secret).toHaveAttribute("data-prive", "true");
  await expect(secret).toContainText("🔒");
  const perso = fenetre.locator(boutonsEspace, { hasText: "🏠" });
  await expect(perso).not.toHaveAttribute("data-prive", "true");
  await expect(perso).not.toContainText("🔒");
  await fermer();
});

test("supprimer le dernier espace d'un profil prévient que ses connexions seront perdues, même sans onglet", async () => {
  const { fenetre, fermer } = await lancer();
  // Partage le profil par défaut, sans onglet : supprimé sans confirmation.
  await agir(fenetre, { type: "creerEspace", nom: "Jeux", icone: "🎮", prive: false, profil: "defaut" });
  await fenetre.locator(boutonsEspace, { hasText: "🎮" }).click({ button: "right" });
  await fenetre.getByRole("menuitem", { name: "Supprimer" }).click();
  await expect(fenetre.locator(boutonsEspace, { hasText: "🎮" })).toHaveCount(0);
  await expect(fenetre.getByRole("alertdialog")).toHaveCount(0);

  await agir(fenetre, { type: "creerEspace", nom: "Travail", icone: "💼", prive: false, profil: "nouveau" });
  await fenetre.locator(boutonsEspace, { hasText: "💼" }).click({ button: "right" });
  await fenetre.getByRole("menuitem", { name: "Supprimer" }).click();
  const confirmation = fenetre.getByRole("alertdialog");
  await expect(confirmation).toContainText("Travail");
  await expect(confirmation).toContainText("Les connexions de cet espace seront perdues.");
  await confirmation.getByRole("button", { name: "Annuler" }).click();
  await expect(fenetre.locator(boutonsEspace, { hasText: "💼" })).toHaveCount(1);
  await fenetre.locator(boutonsEspace, { hasText: "💼" }).click({ button: "right" });
  await fenetre.getByRole("menuitem", { name: "Supprimer" }).click();
  await fenetre.getByRole("alertdialog").getByRole("button", { name: "Supprimer" }).click();
  await expect(fenetre.locator(boutonsEspace, { hasText: "💼" })).toHaveCount(0);
  await fermer();
});
