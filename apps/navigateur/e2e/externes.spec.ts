import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer as serveurTcp } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lancer, lireNotifications, ouvrirOnglet, serveurTest } from "./aide";

// Le MCP externe sur un port libre choisi par le système ; la commande affichée porte le vrai port.
const ENV = { WEBAIOS_PORT_MCP_EXTERNE: "0", WEBAIOS_PORTS_APPS: "15280-15284" };

const menu = (app: ElectronApplication, id: string) => app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.click(), id);
const aucuneFenetreVisible = async (app: ElectronApplication) =>
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible()))).toBe(false);

/** Un dossier de projet temporaire (son nom est celui du projet). */
function dossierProjet(nom: string): string {
  const parent = mkdtempSync(join(tmpdir(), "webaios-externe-"));
  const d = join(parent, nom);
  mkdirSync(d);
  return realpathSync(d);
}

/** Ouvre la page Applications, branche un Claude Code et lit la commande affichée. */
async function brancher(fenetre: Page, app: ElectronApplication, nom?: string) {
  // Le menu peut ne pas être posé aussitôt après l'ouverture de la fenêtre.
  await expect.poll(() => app.evaluate(({ Menu }) => !!Menu.getApplicationMenu()?.getMenuItemById("applications"))).toBe(true);
  await menu(app, "applications");
  const section = fenetre.getByTestId("projets-externes");
  await expect(section).toBeVisible();
  await section.getByTestId("brancher-externe").click();
  if (nom !== undefined) await section.getByTestId("nom-brancher").fill(nom);
  await section.getByTestId("valider-brancher").click();
  const commande = (await section.getByTestId("commande-branchement").textContent()) ?? "";
  const m = /http:\/\/127\.0\.0\.1:(\d+)\/mcp-externe --header "Authorization: Bearer ([0-9a-f]{64})"/.exec(commande);
  expect(m, commande).not.toBeNull();
  return { commande, port: Number(m![1]), jeton: m![2]! };
}

async function client(port: number, jeton: string): Promise<Client> {
  const c = new Client({ name: "essai", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp-externe`), { requestInit: { headers: { Authorization: `Bearer ${jeton}` } } }));
  return c;
}

const texteDe = (r: unknown): string =>
  ((r as { content: { type: string; text?: string }[] }).content ?? []).map((x) => x.text ?? "").join("\n");

test("« Brancher un Claude Code » : commande avec le vrai port et un jeton de 64 hex, effacée à la fermeture ; clients-externes.json sous le profil sans le jeton", async () => {
  const { app, fenetre, profil, racine, fermer } = await lancer({ env: ENV });
  try {
    const { commande, port, jeton } = await brancher(fenetre, app);
    expect(commande).toBe(
      `claude mcp add --transport http --scope user webaios-remarques http://127.0.0.1:${port}/mcp-externe --header "Authorization: Bearer ${jeton}"`,
    );
    expect(port).toBeGreaterThan(0);
    const section = fenetre.getByTestId("projets-externes");
    await expect(section.getByTestId("client-externe")).toHaveCount(1);
    await expect(section.getByTestId("client-externe")).toContainText("Claude Code");
    const fichier = join(profil, "design", "clients-externes.json");
    expect(existsSync(fichier)).toBe(true);
    expect(readFileSync(fichier, "utf8")).not.toContain(jeton);
    expect(statSync(fichier).mode & 0o777).toBe(0o600);
    expect(existsSync(join(racine, ".webaios", "clients-externes.json"))).toBe(false);
    // Fermer efface la commande, qui n'est plus affichée nulle part.
    await section.getByTestId("fermer-commande").click();
    await expect(section.getByTestId("commande-branchement")).toHaveCount(0);
    expect(await fenetre.locator("body").innerText()).not.toContain(jeton);
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});

test("declarer_projet : la ligne projet-externe apparaît ; une notification une seule fois", async () => {
  const serveur = await serveurTest();
  const dossier = dossierProjet("mon-site");
  const { app, fenetre, profil, fermer } = await lancer({ env: ENV });
  try {
    const { port, jeton } = await brancher(fenetre, app);
    const c = await client(port, jeton);
    const portPage = Number(new URL(serveur.url).port);
    const r = await c.callTool({ name: "declarer_projet", arguments: { dossier, ports: [portPage] } });
    expect(texteDe(r)).toContain("mon-site");
    const ligne = fenetre.getByTestId("projet-externe");
    await expect(ligne).toHaveCount(1);
    await expect(ligne).toContainText("mon-site");
    await expect(ligne).toContainText(dossier);
    await expect(ligne).toContainText(String(portPage));
    await expect(ligne).toContainText("Claude Code");
    await expect.poll(() => lireNotifications(profil)).toEqual([{ titre: "WebAiOs", texte: "Claude Code a branché le projet mon-site" }]);
    // Deuxième déclaration : rien de nouveau.
    await c.callTool({ name: "declarer_projet", arguments: { dossier, ports: [portPage] } });
    await new Promise((r) => setTimeout(r, 500));
    expect(lireNotifications(profil)).toHaveLength(1);
    await expect(ligne).toHaveCount(1);
    await c.close();
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
    await serveur.fermer();
  }
});

/** Un dossier, un port, un client branché, un onglet ouvert sur la page : la base des tests d'envoi. */
async function projetOuvert() {
  const serveur = await serveurTest();
  const dossier = dossierProjet("mon-site");
  const l = await lancer({ env: ENV });
  const { port, jeton } = await brancher(l.fenetre, l.app);
  const c = await client(port, jeton);
  const portPage = Number(new URL(serveur.url).port);
  await c.callTool({ name: "declarer_projet", arguments: { dossier, ports: [portPage] } });
  await expect(l.fenetre.getByTestId("projet-externe")).toHaveCount(1);
  const adresse = `http://127.0.0.1:${portPage}`;
  await ouvrirOnglet(l.fenetre, `${adresse}/design.html`);
  await expect.poll(() => l.app.evaluate(({ webContents }, a) => webContents.getAllWebContents().some((w) => w.getURL().startsWith(a) && !w.isLoading()), adresse)).toBe(true);
  return { ...l, serveur, dossier, port, jeton, c, adresse, fermerTout: async () => { await c.close().catch(() => undefined); await l.fermer(); await serveur.fermer(); } };
}

/** La page Applications (d'où se gèrent les projets externes) et l'onglet de la page d'essai (« Design »). */
const versApplications = (fenetre: Page) => fenetre.getByRole("tab", { name: /Applications/ }).click();
const versPage = (fenetre: Page) => fenetre.getByRole("tab", { name: /Design/ }).click();

async function cliquerDans(app: ElectronApplication, adresse: string, selecteur: string) {
  const c = await app.evaluate(({ webContents }, [a, s]) =>
    webContents.getAllWebContents().find((w) => w.getURL().startsWith(a!))!.executeJavaScript(
      `(() => { const r = document.querySelector(${JSON.stringify(s)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
    ) as Promise<{ x: number; y: number }>, [adresse, selecteur] as const);
  await app.evaluate(async ({ webContents }, [a, c]) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith((a as string)))!;
    const p = c as { x: number; y: number };
    wc.sendInputEvent({ type: "mouseMove", x: p.x, y: p.y });
    await new Promise((r) => setTimeout(r, 50));
    wc.sendInputEvent({ type: "mouseDown", x: p.x, y: p.y, button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x: p.x, y: p.y, button: "left", clickCount: 1 });
  }, [adresse, c] as const);
}

async function pageCalque(app: ElectronApplication): Promise<Page> {
  for (const fin = Date.now() + 10_000; Date.now() < fin; ) {
    const p = app.windows().find((x) => !x.url().startsWith("http") && x.url().includes("design.html"));
    if (p) return p;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("le calque du mode design n'est pas apparu");
}

/** Mode design, une remarque sur `#email`, ajoutée au panier. */
async function remarquer(o: { app: ElectronApplication; adresse: string }, texte: string) {
  await menu(o.app, "mode-design");
  await expect.poll(() => o.app.evaluate(({ webContents }, a) =>
    webContents.getAllWebContents().find((w) => w.getURL().startsWith(a))!.executeJavaScript(`document.querySelectorAll("webaios-viseur").length`) as Promise<number>, o.adresse)).toBe(1);
  await cliquerDans(o.app, o.adresse, "#email");
  const calque = await pageCalque(o.app);
  const bulle = calque.getByTestId("bulle-design");
  await expect(bulle).toContainText("input#email.champ");
  await bulle.locator("textarea").fill(texte);
  await bulle.locator("textarea").press("Meta+Enter");
}

test("onglet sur le port déclaré : envoi à Claude Code, lire_remarques (texte et image), lot lu puis traité avec la note", async () => {
  const p = await projetOuvert();
  try {
    const bouton = p.fenetre.getByTestId("bouton-design");
    await expect(bouton).toBeEnabled();
    await remarquer(p, "Champ plus large");
    await expect(p.fenetre.getByTestId("envoyer-remarques")).toHaveText("Envoyer 1 remarque à Claude Code (Claude Code)");
    await p.fenetre.getByTestId("envoyer-remarques").click();
    const lot = p.fenetre.getByTestId("lot-envoye");
    await expect(lot).toHaveCount(1);
    await expect(lot).toHaveAttribute("data-etat", "en-attente");
    // Rien dans le terminal de l'agent : un lot externe ne pré-remplit rien.
    expect(existsSync(join(p.racine, "faux-agent-entree.txt"))).toBe(false);
    const lu = await p.c.callTool({ name: "lire_remarques", arguments: { dossier: p.dossier } });
    const contenu = (lu as { content: { type: string; text?: string }[] }).content;
    expect(contenu.some((x) => x.type === "image")).toBe(true);
    const texte = texteDe(lu);
    expect(texte).toContain("Champ plus large");
    await expect(lot).toHaveAttribute("data-etat", "lu");
    const id = /Remarque (e-[0-9a-f]{8})/.exec(texte)![1]!;
    await p.c.callTool({ name: "marquer_traitee", arguments: { dossier: p.dossier, ids: [id], note: "corrigé" } });
    await expect(lot).toHaveAttribute("data-etat", "traite");
    await expect(lot).toContainText("corrigé");
    await aucuneFenetreVisible(p.app);
  } finally {
    await p.fermerTout();
  }
});

test("attendre_remarques lancé avant l'envoi rend le lot dès l'envoi", async () => {
  const p = await projetOuvert();
  try {
    await remarquer(p, "Bouton plus grand");
    const debut = Date.now();
    const attente = p.c.callTool({ name: "attendre_remarques", arguments: { dossier: p.dossier, delai_s: 30 } });
    await new Promise((r) => setTimeout(r, 400));
    await p.fenetre.getByTestId("envoyer-remarques").click();
    const r = await attente;
    expect(texteDe(r)).toContain("Bouton plus grand");
    expect(Date.now() - debut).toBeLessThan(15_000);
    await aucuneFenetreVisible(p.app);
  } finally {
    await p.fermerTout();
  }
});

test("Révoquer : l'appel suivant rend 401 ; le projet affiche « aucun client » et l'envoi est grisé avec SANS_CLIENT", async () => {
  const p = await projetOuvert();
  try {
    await remarquer(p, "Une remarque");
    await expect(p.fenetre.getByTestId("envoyer-remarques")).toBeEnabled();
    await versApplications(p.fenetre);
    await p.fenetre.getByTestId("client-externe").getByRole("button", { name: "Révoquer" }).click();
    await expect(p.fenetre.getByTestId("client-externe")).toHaveCount(0);
    await expect(p.c.callTool({ name: "lire_remarques", arguments: { dossier: p.dossier } })).rejects.toMatchObject({ code: 401 });
    const ligne = p.fenetre.getByTestId("projet-externe");
    await expect(ligne).toContainText("aucun client");
    await versPage(p.fenetre);
    await menu(p.app, "mode-design");
    await expect(p.fenetre.getByTestId("envoyer-remarques")).toBeDisabled();
    await expect(p.fenetre.getByTestId("panier-design")).toContainText("Aucun Claude Code branché pour ce projet : il doit le redéclarer");
    await aucuneFenetreVisible(p.app);
  } finally {
    await p.fermerTout();
  }
});

test("Oublier : la ligne disparaît, le bouton-design de l'onglet redevient indisponible", async () => {
  const p = await projetOuvert();
  try {
    await expect(p.fenetre.getByTestId("bouton-design")).toBeEnabled();
    await versApplications(p.fenetre);
    await p.fenetre.getByTestId("projet-externe").getByRole("button", { name: "Oublier" }).click();
    await expect(p.fenetre.getByTestId("projet-externe")).toHaveCount(0);
    await versPage(p.fenetre);
    await expect(p.fenetre.getByTestId("bouton-design")).toBeDisabled();
    await aucuneFenetreVisible(p.app);
  } finally {
    await p.fermerTout();
  }
});

function fichiersDe(dossier: string): string[] {
  const sortie: string[] = [];
  const parcourir = (d: string) => {
    for (const n of readdirSync(d)) {
      const chemin = join(d, n);
      sortie.push(chemin);
      if (statSync(chemin).isDirectory()) parcourir(chemin);
    }
  };
  parcourir(dossier);
  return sortie;
}

test("aucun fichier du projet externe (registres, dépôt, lots) n'apparaît sous racine/", async () => {
  const p = await projetOuvert();
  try {
    await remarquer(p, "Une remarque");
    await p.fenetre.getByTestId("envoyer-remarques").click();
    await expect(p.fenetre.getByTestId("lot-envoye")).toHaveCount(1);
    // Le dépôt de relecture se prépare en tâche de fond.
    await expect.poll(() => existsSync(join(p.profil, "design"))).toBe(true);
    await new Promise((r) => setTimeout(r, 800));
    for (const f of fichiersDe(p.racine)) {
      expect(f, f).not.toMatch(/externes|relecture|ext-[0-9a-f]{16}/);
      if (statSync(f).isFile() && statSync(f).size < 2_000_000) expect(readFileSync(f, "utf8"), f).not.toContain(p.jeton);
    }
    const lots = fichiersDe(join(p.profil, "design", "remarques"));
    expect(lots.some((f) => f.endsWith("lot.json"))).toBe(true);
    await aucuneFenetreVisible(p.app);
  } finally {
    await p.fermerTout();
  }
});

test("port tenu par ailleurs : la section affiche portPris(port) et rien d'autre n'est tenté", async () => {
  const tenu = serveurTcp();
  await new Promise<void>((ok) => tenu.listen(0, "127.0.0.1", ok));
  const port = (tenu.address() as { port: number }).port;
  const { app, fenetre, fermer } = await lancer({ env: { ...ENV, WEBAIOS_PORT_MCP_EXTERNE: String(port) } });
  try {
    await menu(app, "applications");
    const section = fenetre.getByTestId("projets-externes");
    await expect(section.getByTestId("raison-externes")).toHaveText(`Le port ${port} est pris : le MCP externe est éteint.`);
    await expect(section.getByTestId("brancher-externe")).toBeDisabled();
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
    await new Promise<void>((ok) => tenu.close(() => ok()));
  }
});
