import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appelerOutil, dansLaVue, lancer, nouvelleRacine, ouvrirOnglet, serveurTest } from "./aide";

let serveur: Awaited<ReturnType<typeof serveurTest>>;
test.beforeAll(async () => (serveur = await serveurTest()));
test.afterAll(() => serveur.fermer());

test("au lancement, le noyau prépare l'espace dans WEBAIOS_RACINE et le serveur MCP répond", async () => {
  const { racine, fermer } = await lancer();
  await expect.poll(() => existsSync(join(racine, "AGENTS.md")) && existsSync(join(racine, ".webaios", "mcp.json")), { timeout: 10_000 }).toBe(true);
  expect(await appelerOutil(racine, "lister_onglets")).toEqual({ texte: "Aucun onglet ouvert.", erreur: false });
  await fermer();
});

test("sans Docker, la navigation fonctionne", async () => {
  const { app, fenetre, fermer } = await lancer({ env: { FAUX_DOCKER_ABSENT: "1" } });
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBe("Page A");
  await fermer();
});

test("lister_onglets : un onglet que l'utilisateur n'a pas partagé apparaît comme « onglet privé »", async () => {
  const { app, fenetre, racine, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBe("Page A");
  await expect.poll(() => existsSync(join(racine, ".webaios", "mcp.json"))).toBe(true);
  const { texte } = await appelerOutil(racine, "lister_onglets");
  expect(texte).toContain("onglet privé");
  expect(texte).not.toContain("a.html");
  await fermer();
});

// L'agent appelle ses outils depuis sa session : on l'attend (son démarrage remet les autorisations à zéro).
test("ouvrir_onglet sur une démo locale : onglet actif marqué ✦, lisible et capturable par l'agent", async () => {
  const { fenetre, racine, fermer } = await lancer();
  await expect(terminal(fenetre)).toContainText("faux agent prêt>");
  const { texte: id, erreur } = await appelerOutil(racine, "ouvrir_onglet", { url: `${serveur.url}/texte.html` });
  expect(erreur).toBe(false);
  const onglet = fenetre.locator(`[data-testid="onglet-${id}"]`);
  await expect(onglet).toHaveAttribute("aria-current", "page");
  await expect(onglet.locator(".agent")).toHaveText("✦");
  const lu = await appelerOutil(racine, "lire_onglet", { id });
  expect(lu.texte).toContain(`URL : ${serveur.url}/texte.html`);
  expect(lu.texte).toContain("Le chat dort");
  const capture = await appelerOutil(racine, "capture_ecran", { id });
  expect(capture.image?.startsWith("iVBOR")).toBe(true);
  expect(capture.image!.length).toBeGreaterThan(1000);
  await fermer();
});

test("un onglet de l'agent passé en arrière-plan reste lisible et capturable", async () => {
  const { fenetre, racine, fermer } = await lancer();
  await expect(terminal(fenetre)).toContainText("faux agent prêt>");
  const { texte: premier } = await appelerOutil(racine, "ouvrir_onglet", { url: `${serveur.url}/texte.html` });
  await appelerOutil(racine, "ouvrir_onglet", { url: `${serveur.url}/b.html` });
  const lu = await appelerOutil(racine, "lire_onglet", { id: premier });
  expect(lu.texte).toContain("Le chat dort");
  const capture = await appelerOutil(racine, "capture_ecran", { id: premier });
  expect(capture.image!.length).toBeGreaterThan(1000);
  await fermer();
});

const pret = (racine: string) => expect.poll(() => existsSync(join(racine, ".webaios", "mcp.json"))).toBe(true);
const idOnglet = async (fenetre: import("@playwright/test").Page, texte: string) =>
  (await fenetre.locator('[data-testid^="onglet-"]', { hasText: texte }).getAttribute("data-testid"))!.slice("onglet-".length);

test("lire un onglet de l'utilisateur demande la permission ; Refuser → refus renvoyé à l'agent", async () => {
  const { app, fenetre, racine, fermer } = await lancer();
  await pret(racine);
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBe("Page A");
  const lecture = appelerOutil(racine, "lire_onglet", { id: await idOnglet(fenetre, "Page A") });
  const bandeau = fenetre.getByTestId("demande-permission");
  await expect(bandeau).toContainText("L'agent veut lire l'onglet « Page A »");
  await bandeau.getByRole("button", { name: "Refuser" }).click();
  expect((await lecture).texte).toBe("Accès refusé par l'utilisateur à cet onglet.");
  await expect(bandeau).toBeHidden();
  await fermer();
});

test("Autoriser une fois → l'agent lit la page ; la question ne revient pas pour le même site", async () => {
  const { app, fenetre, racine, fermer } = await lancer();
  await pret(racine);
  await ouvrirOnglet(fenetre, `${serveur.url}/texte.html`);
  await expect.poll(() => dansLaVue(app, "texte.html", "document.title")).toBe("Texte");
  const id = await idOnglet(fenetre, "Texte");
  const lecture = appelerOutil(racine, "lire_onglet", { id });
  await fenetre.getByTestId("demande-permission").getByRole("button", { name: "Autoriser une fois" }).click();
  expect((await lecture).texte).toContain("Le chat dort");
  expect((await appelerOutil(racine, "lire_onglet", { id })).texte).toContain("Le chat dort");
  await expect(fenetre.getByTestId("demande-permission")).toBeHidden();
  await fermer();
});

test("onglet jamais affiché : une fois autorisé, il est chargé pour être lu", async () => {
  const { fenetre, racine, fermer } = await lancer();
  await pret(racine);
  await ouvrirOnglet(fenetre, `${serveur.url}/texte.html`, { activer: false });
  await expect(fenetre.locator('[data-testid^="onglet-"]')).toHaveCount(1);
  const id = (await fenetre.locator('[data-testid^="onglet-"]').getAttribute("data-testid"))!.slice("onglet-".length);
  const lecture = appelerOutil(racine, "lire_onglet", { id });
  await fenetre.getByTestId("demande-permission").getByRole("button", { name: "Autoriser une fois" }).click();
  expect((await lecture).texte).toContain("Le chat dort");
  await fermer();
});

test("onglet fermé pendant la question → refusée, bandeau retiré", async () => {
  const { app, fenetre, racine, fermer } = await lancer();
  await pret(racine);
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await ouvrirOnglet(fenetre, `${serveur.url}/b.html`);
  await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBe("Page A");
  const id = await idOnglet(fenetre, "Page A");
  const lecture = appelerOutil(racine, "lire_onglet", { id });
  await expect(fenetre.getByTestId("demande-permission")).toBeVisible();
  await fenetre.evaluate((id) => (window as unknown as { webaios: { agir(a: unknown): void } }).webaios.agir({ type: "fermerOnglet", id }), id);
  expect((await lecture).texte).toBe("Accès refusé par l'utilisateur à cet onglet.");
  await expect(fenetre.getByTestId("demande-permission")).toBeHidden();
  await fermer();
});

test("une question de lecture ne s'affiche que dans la fenêtre active", async () => {
  const { app, fenetre, racine, fermer } = await lancer();
  await pret(racine);
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBe("Page A");
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("nouvelle-fenetre")?.click());
  await expect.poll(() => app.windows().filter((p) => p.url().includes("/renderer/index.html")).length).toBe(2);
  const seconde = app.windows().find((p) => p.url().includes("/renderer/index.html") && p !== fenetre)!;
  // Fenêtres cachées : aucune n'a le focus, la fenêtre active est la première.
  void appelerOutil(racine, "lire_onglet", { id: await idOnglet(fenetre, "Page A") });
  await expect(fenetre.getByTestId("demande-permission")).toBeVisible();
  await new Promise((r) => setTimeout(r, 300));
  await expect(seconde.getByTestId("demande-permission")).toBeHidden();
  await fermer();
});

const terminal = (p: import("@playwright/test").Page) => p.getByTestId("panneau-agent").locator(".xterm-rows");
const menuAgent = (app: import("@playwright/test").ElectronApplication) =>
  app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("panneau-agent")?.click());
const lireFichier = (chemin: string) => (existsSync(chemin) ? readFileSync(chemin, "utf8") : "");
/** Au lancement, la fenêtre montre la page d'accueil, où le panneau agent est ouvert par défaut. */
const panneauAccueil = (p: import("@playwright/test").Page) => expect(p.getByTestId("panneau-agent")).toBeVisible();

test("le panneau de la page d'accueil fait tourner le vrai CLI avec la config MCP", async () => {
  const { fenetre, racine, fermer } = await lancer();
  await panneauAccueil(fenetre);
  await expect(terminal(fenetre)).toContainText("faux agent prêt>");
  expect(JSON.parse(lireFichier(join(racine, "faux-agent-args.json")))).toEqual([
    "claude",
    "--dangerously-skip-permissions",
    "--mcp-config",
    "/workspace/.webaios/mcp.json",
  ]);
  await fermer();
});

test("taper dans le terminal arrive à l'agent", async () => {
  const { app, fenetre, fermer } = await lancer();
  await panneauAccueil(fenetre);
  await expect(terminal(fenetre)).toContainText("faux agent prêt>");
  await fenetre.getByTestId("panneau-agent").locator(".xterm-screen").click();
  await fenetre.keyboard.type("bonjour");
  await fenetre.keyboard.press("Enter");
  await expect(terminal(fenetre)).toContainText("reçu: bonjour");
  await fermer();
});

test("l'agent quitté → « Relancer » repart sur une nouvelle session", async () => {
  const { app, fenetre, racine, fermer } = await lancer();
  await panneauAccueil(fenetre);
  await expect(terminal(fenetre)).toContainText("faux agent prêt>");
  const premier = lireFichier(join(racine, "faux-agent-pid"));
  await fenetre.getByTestId("panneau-agent").locator(".xterm-screen").click();
  await fenetre.keyboard.type("quitter");
  await fenetre.keyboard.press("Enter");
  const panneau = fenetre.getByTestId("panneau-agent");
  await expect(panneau.getByText("L'agent s'est arrêté.")).toBeVisible();
  await panneau.getByRole("button", { name: "Relancer" }).click();
  await expect.poll(() => lireFichier(join(racine, "faux-agent-pid"))).not.toBe(premier);
  await expect(panneau.getByText("L'agent s'est arrêté.")).toBeHidden();
  await fermer();
});

test("fermer puis rouvrir le panneau garde la conversation", async () => {
  const { app, fenetre, fermer } = await lancer();
  await panneauAccueil(fenetre);
  await expect(terminal(fenetre)).toContainText("faux agent prêt>");
  await fenetre.getByTestId("panneau-agent").locator(".xterm-screen").click();
  await fenetre.keyboard.type("souvenir");
  await fenetre.keyboard.press("Enter");
  await expect(terminal(fenetre)).toContainText("reçu: souvenir");
  await menuAgent(app);
  await expect(fenetre.getByTestId("panneau-agent")).toBeHidden();
  await menuAgent(app);
  await expect(terminal(fenetre)).toContainText("reçu: souvenir");
  await fermer();
});

test("une sortie énorme ne fige pas l'interface", async () => {
  const { app, fenetre, racine, fermer } = await lancer();
  await panneauAccueil(fenetre);
  await expect(terminal(fenetre)).toContainText("faux agent prêt>");
  await fenetre.getByTestId("panneau-agent").locator(".xterm-screen").click();
  await fenetre.keyboard.type("inonder");
  await fenetre.keyboard.press("Enter");
  // 1 Mo plus tard, la commande a défilé hors de l'écran et l'invite est revenue en bas.
  await expect(terminal(fenetre)).not.toContainText("reçu: inonder", { timeout: 10_000 });
  await expect(terminal(fenetre)).toContainText("faux agent prêt>");
  expect(lireFichier(join(racine, "faux-agent-entree.txt"))).toContain("inonder\r");
  await fenetre.getByTestId("nouvel-onglet").click();
  await expect(fenetre.getByTestId("page-vide")).toBeVisible();
  await fermer();
});

test("Docker absent → message clair et Réessayer", async () => {
  const { app, fenetre, fermer } = await lancer({ env: { FAUX_DOCKER_ABSENT: "1" } });
  await panneauAccueil(fenetre);
  const panneau = fenetre.getByTestId("panneau-agent");
  await expect(panneau).toContainText("Docker n'est pas lancé. La navigation fonctionne ; seul l'agent est indisponible.");
  await expect(panneau.getByRole("button", { name: "Réessayer" })).toBeVisible();
  await fermer();
});

test("conteneur impossible à démarrer → erreur et Réessayer", async () => {
  const { app, fenetre, fermer } = await lancer({ env: { FAUX_DOCKER_ECHEC: "1" } });
  await panneauAccueil(fenetre);
  const panneau = fenetre.getByTestId("panneau-agent");
  await expect(panneau).toContainText("L'agent n'a pas pu démarrer :", { timeout: 10_000 });
  await expect(panneau).toContainText("échec simulé");
  await expect(panneau.getByRole("button", { name: "Réessayer" })).toBeVisible();
  await fermer();
});

test("⌘W sur la page vide de la dernière fenêtre la ferme et arrête son agent (l'app reste ouverte)", async () => {
  const { app, fenetre, racine, fermer } = await lancer();
  await panneauAccueil(fenetre);
  await expect(terminal(fenetre)).toContainText("faux agent prêt>");
  const pid = Number(lireFichier(join(racine, "faux-agent-pid")));
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("fermer-onglet")?.click());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  const vivant = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  await expect.poll(vivant, { timeout: 10_000 }).toBe(false);
  await expect.poll(() => lireFichier(join(racine, "faux-docker-arrets.log"))).toMatch(/webaios-session-[0-9a-f]+\.pid[\s\S]*signaler KILL/);
  await fermer();
});

test("⇧⌘W sur la dernière fenêtre avec un onglet arrête son agent ; la rouvrir (Dock) en démarre un nouveau", async () => {
  const { app, fenetre, racine, fermer } = await lancer();
  await panneauAccueil(fenetre);
  await expect(terminal(fenetre)).toContainText("faux agent prêt>");
  const pid = Number(lireFichier(join(racine, "faux-agent-pid")));
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("fermer-fenetre")?.click());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  const vivant = (p: number) => {
    try {
      process.kill(p, 0);
      return true;
    } catch {
      return false;
    }
  };
  await expect.poll(() => vivant(pid), { timeout: 10_000 }).toBe(false);
  await app.evaluate(({ app }) => app.emit("activate"));
  await expect.poll(() => app.windows().filter((p) => p.url().includes("/renderer/index.html")).length).toBe(1);
  await fermer();
});

test("fermer la fenêtre arrête son agent", async () => {
  const { app, fenetre, racine, fermer } = await lancer();
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("nouvelle-fenetre")?.click());
  await expect.poll(() => app.windows().filter((p) => p.url().includes("/renderer/index.html")).length).toBe(2);
  const seconde = app.windows().find((p) => p.url().includes("/renderer/index.html") && p !== fenetre)!;
  await panneauAccueil(seconde);
  await expect(terminal(seconde)).toContainText("faux agent prêt>");
  const pid = Number(lireFichier(join(racine, "faux-agent-pid")));
  await seconde.evaluate(() => window.close());
  const vivant = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  await expect.poll(vivant, { timeout: 10_000 }).toBe(false);
  // Avec un vrai Docker, tuer le client local laisserait l'agent tourner : il est aussi tué dans le conteneur
  // (script vérifié contre le vrai conteneur par session.integration.test.ts du noyau).
  await expect.poll(() => lireFichier(join(racine, "faux-docker-arrets.log"))).toMatch(/webaios-session-[0-9a-f]+\.pid[\s\S]*signaler KILL/);
  await fermer();
});

/** Attend la session d'agent du panneau de la page d'accueil (sa saisie n'est prête qu'ensuite), puis referme le panneau. */
async function agentPret(app: import("@playwright/test").ElectronApplication, fenetre: import("@playwright/test").Page) {
  await panneauAccueil(fenetre);
  await expect(terminal(fenetre)).toContainText("faux agent prêt>");
  await menuAgent(app);
  await expect(fenetre.getByTestId("panneau-agent")).toBeHidden();
}

test("le bouton ✦ de la barre latérale ouvre et ferme le panneau agent", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBe("Page A");
  await expect(fenetre.getByTestId("panneau-agent")).toBeHidden();
  await fenetre.getByTestId("bouton-agent").click();
  await expect(fenetre.getByTestId("panneau-agent")).toBeVisible();
  await fenetre.getByTestId("bouton-agent").click();
  await expect(fenetre.getByTestId("panneau-agent")).toBeHidden();
  await fermer();
});

test("⌘J sur un onglet : préfixe de contexte pré-rempli, jamais envoyé", async () => {
  const { app, fenetre, racine, fermer } = await lancer();
  await agentPret(app, fenetre);
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBe("Page A");
  await menuAgent(app);
  await expect.poll(() => lireFichier(join(racine, "faux-agent-entree.txt"))).toBe(`[contexte : Page A — ${serveur.url}/a.html] `);
  await fermer();
});

test("après ⌘J, page_courante lit l'onglet sans demander", async () => {
  const { app, fenetre, racine, fermer } = await lancer();
  await agentPret(app, fenetre);
  await ouvrirOnglet(fenetre, `${serveur.url}/texte.html`);
  await expect.poll(() => dansLaVue(app, "texte.html", "document.title")).toBe("Texte");
  await menuAgent(app);
  expect((await appelerOutil(racine, "page_courante")).texte).toContain("Le chat dort");
  await expect(fenetre.getByTestId("demande-permission")).toBeHidden();
  await fermer();
});

test("onglet visité sans parler à l'agent : page_courante demande la permission", async () => {
  const { app, fenetre, racine, fermer } = await lancer();
  await agentPret(app, fenetre);
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBe("Page A");
  await menuAgent(app);
  await menuAgent(app);
  await ouvrirOnglet(fenetre, `${serveur.url}/b.html`);
  await expect.poll(() => dansLaVue(app, "b.html", "document.title")).toBe("Page B");
  const lecture = appelerOutil(racine, "page_courante");
  await expect(fenetre.getByTestId("demande-permission")).toContainText("L'agent veut lire l'onglet « Page B »");
  await fenetre.getByTestId("demande-permission").getByRole("button", { name: "Refuser" }).click();
  expect((await lecture).texte).toBe("Accès refusé par l'utilisateur à cet onglet.");
  await fermer();
});

test("envoyer un message depuis un onglet le partage", async () => {
  const { app, fenetre, racine, fermer } = await lancer();
  await agentPret(app, fenetre);
  // Ouvert par l'utilisateur sur la page d'accueil (sans onglet, donc sans contexte) : le panneau reste ouvert ensuite.
  await menuAgent(app);
  await expect(fenetre.getByTestId("panneau-agent")).toBeVisible();
  await ouvrirOnglet(fenetre, `${serveur.url}/texte.html`);
  await expect.poll(() => dansLaVue(app, "texte.html", "document.title")).toBe("Texte");
  await fenetre.getByTestId("panneau-agent").locator(".xterm-screen").click();
  await fenetre.keyboard.type("salut");
  await fenetre.keyboard.press("Enter");
  await expect(terminal(fenetre)).toContainText("reçu: salut");
  expect((await appelerOutil(racine, "page_courante")).texte).toContain("Le chat dort");
  await expect(fenetre.getByTestId("demande-permission")).toBeHidden();
  await fermer();
});

test("une nouvelle session d'agent (autre fenêtre) remet les accès à zéro : l'agent redemande", async () => {
  const { app, fenetre, racine, fermer } = await lancer();
  await agentPret(app, fenetre);
  await ouvrirOnglet(fenetre, `${serveur.url}/texte.html`);
  await expect.poll(() => dansLaVue(app, "texte.html", "document.title")).toBe("Texte");
  await menuAgent(app); // donne l'onglet à l'agent
  const id = (await fenetre.locator('[data-testid^="onglet-"]').getAttribute("data-testid"))!.replace("onglet-", "");
  expect((await appelerOutil(racine, "lire_onglet", { id })).texte).toContain("Le chat dort");
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("nouvelle-fenetre")?.click());
  await expect.poll(() => app.windows().filter((p) => p.url().includes("/renderer/index.html")).length).toBe(2);
  const seconde = app.windows().find((p) => p.url().includes("/renderer/index.html") && p !== fenetre)!;
  await panneauAccueil(seconde);
  await expect(terminal(seconde)).toContainText("faux agent prêt>");
  // La politique est commune aux sessions : mieux vaut redemander qu'hériter des accès d'une autre conversation.
  const lecture = appelerOutil(racine, "lire_onglet", { id });
  const bandeaux = () => Promise.all([fenetre, seconde].map((p) => p.getByTestId("demande-permission").count()));
  await expect.poll(async () => (await bandeaux()).reduce((a, b) => a + b, 0)).toBe(1);
  const avecBandeau = (await bandeaux())[0] ? fenetre : seconde;
  await avecBandeau.getByTestId("demande-permission").getByRole("button", { name: "Refuser" }).click();
  expect((await lecture).texte).toBe("Accès refusé par l'utilisateur à cet onglet.");
  await fermer();
});

test("un second profil dans .webaios/profils apparaît dans le panneau ; le choisir relance l'agent avec sa commande", async () => {
  const racine = nouvelleRacine();
  mkdirSync(join(racine, ".webaios", "profils"), { recursive: true });
  writeFileSync(
    join(racine, ".webaios", "profils", "autre.json"),
    JSON.stringify({ id: "autre", nom: "Autre", interactif: ["autre-agent", "--mcp", "{mcpConfig}"], nonInteractif: ["autre-agent", "-p", "{consigne}"], configMcp: "claude-json" }),
  );
  const { fenetre, fermer } = await lancer({ racine });
  await panneauAccueil(fenetre);
  await expect(terminal(fenetre)).toContainText("faux agent prêt>");
  const premier = lireFichier(join(racine, "faux-agent-pid"));
  const choix = fenetre.getByTestId("profil-agent");
  await expect(choix.locator("option")).toHaveText(["Autre", "Claude Code"]);
  await choix.selectOption("autre");
  await expect.poll(() => lireFichier(join(racine, "faux-agent-pid"))).not.toBe(premier);
  expect(JSON.parse(lireFichier(join(racine, "faux-agent-args.json")))).toEqual(["autre-agent", "--mcp", "/workspace/.webaios/mcp.json"]);
  await expect(terminal(fenetre)).toContainText("faux agent prêt>");
  await expect(fenetre.getByTestId("panneau-agent")).not.toContainText("L'agent s'est arrêté.");
  await fermer();
});

test("un seul profil : pas de menu de profils", async () => {
  const { fenetre, fermer } = await lancer();
  await panneauAccueil(fenetre);
  await expect(terminal(fenetre)).toContainText("faux agent prêt>");
  await expect(fenetre.getByTestId("profil-agent")).toHaveCount(0);
  await fermer();
});
