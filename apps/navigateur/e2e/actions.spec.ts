import { expect, test, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { lancer, nouveauProfil, nouvelleRacine, ouvrirOnglet, reglerEspaceActifPrive } from "./aide";

// Les actions de bout en bout (plan 14). La page d'une action est servie depuis un résultat écrit par le test dans
// `<profil>/actions/<id>/…` (exécution et résultat), sans conteneur ni Gemma : rouvrir une page ne relance rien.

const EXECUTION = "2026-10-31T08-00-00-000Z";

type Bloc = { composant: string; props: Record<string, unknown>; blocs?: Bloc[]; gauche?: Bloc[]; droite?: Bloc[] };

/** Une action (`~/WebAiOs/actions/<id>/action.json`) et sa dernière exécution, avec son résultat, dans le profil. */
function ecrireAction(
  racine: string,
  profil: string,
  id: string,
  o: { nom: string; compte?: string[]; resultats: unknown; blocs: Bloc[]; secours?: boolean },
): void {
  const dossier = join(racine, "actions", id);
  mkdirSync(dossier, { recursive: true });
  writeFileSync(join(dossier, "action.json"), JSON.stringify({ nom: o.nom, sources: { compte: o.compte ?? [], publiques: [] } }));
  const donnees = join(profil, "actions", id);
  mkdirSync(join(donnees, "executions"), { recursive: true });
  mkdirSync(join(donnees, "resultats"), { recursive: true });
  const debut = "2026-10-31T08:00:00.000Z";
  writeFileSync(
    join(donnees, "executions", `${EXECUTION}.json`),
    JSON.stringify({
      version: 1,
      id: EXECUTION,
      proprietaire: { type: "action", id },
      declencheur: "manuelle",
      debut,
      fin: "2026-10-31T08:00:05.000Z",
      statut: "reussie",
      blocs: [],
    }),
  );
  writeFileSync(
    join(donnees, "resultats", `${EXECUTION}.json`),
    JSON.stringify({ version: 1, execution: EXECUTION, saisie: null, resultats: o.resultats, plan: { blocs: o.blocs }, secours: o.secours ?? false, vide: false }),
  );
}

/** Un composant de l'agent (`~/WebAiOs/composants/<nom>/`). */
function ecrireComposant(racine: string, nom: string, html: string): void {
  const dossier = join(racine, "composants", nom);
  mkdirSync(dossier, { recursive: true });
  writeFileSync(
    join(dossier, "composant.json"),
    JSON.stringify({ nom, description: "Barres des priorités", proprietes: { valeurs: { genre: "reference", description: "Les tâches", requis: true } } }),
  );
  writeFileSync(join(dossier, "composant.html"), html);
}

/** Attend que le noyau serve la page, puis l'ouvre dans un onglet (rien n'est lancé). */
async function ouvrirPage(fenetre: Page, id: string, nom: string): Promise<void> {
  await expect
    .poll(() => fenetre.evaluate(([id, e]) => window.webaios.actions.page(id, e).then((p) => p !== null), [id, EXECUTION] as const), { timeout: 30_000 })
    .toBe(true);
  await fenetre.evaluate(
    ([id, nom, execution]) => window.webaios.agir({ type: "ouvrirAction", fenetreId: window.webaios.fenetreId, id, nom, execution }),
    [id, nom, EXECUTION] as const,
  );
  await expect(fenetre.getByTestId("rendu-page")).toBeVisible();
}

const TACHES = [
  { nom: "Alpha", priorite: 9, etat: "ouvert", url: "https://exemple.invalide/alpha", image: "https://exemple.invalide/a.png" },
  { nom: "Bravo", priorite: 10, etat: "fermé" },
  { nom: "Charlie", priorite: 2, etat: "ouvert" },
];

const BLOCS_DEMO: Bloc[] = [
  { composant: "titre", props: { texte: "<b>gras</b>" } },
  { composant: "paragraphe", props: { texte: "Trois tâches cette semaine." } },
  { composant: "encadre", props: { niveau: "attention", titre: "À voir", elements: "taches", champ: "nom" } },
  { composant: "chiffre", props: { valeur: "compter(taches)", libelle: "Tâches" } },
  { composant: "chiffres", props: { chiffres: [{ valeur: "compter(taches)", libelle: "En tout" }, { valeur: "resume.ouvertes", libelle: "Ouvertes" }] } },
  { composant: "liste", props: { elements: "taches", titre: "nom", sousTitre: "etat", lien: "url" } },
  { composant: "cartes", props: { elements: "taches", titre: "nom", valeur: "priorite", etiquettes: "etat" } },
  {
    composant: "tableau",
    props: { elements: "taches", colonnes: [{ champ: "nom", libelle: "Nom" }, { champ: "priorite", libelle: "Priorité" }] },
  },
  { composant: "champs", props: { objet: "resume" } },
  { composant: "etiquettes", props: { elements: "taches", champ: "etat" } },
  { composant: "lien", props: { objet: "resume", url: "source", texte: "La source" } },
  { composant: "groupe", props: { titre: "Détails" }, blocs: [{ composant: "paragraphe", props: { texte: "Dans le groupe." } }] },
  {
    composant: "colonnes",
    props: {},
    gauche: [{ composant: "paragraphe", props: { texte: "À gauche." } }],
    droite: [{ composant: "paragraphe", props: { texte: "À droite." } }],
  },
];
const RESULTATS_DEMO = { taches: TACHES, resume: { ouvertes: 2, semaine: "44", source: "https://exemple.invalide/source" } };

test("chaque composant intégré s'affiche (data-testid=\"bloc-<nom>\")", async () => {
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireAction(racine, profil, "demo", { nom: "Démo", resultats: RESULTATS_DEMO, blocs: BLOCS_DEMO, secours: true });
  const { fenetre, fermer } = await lancer({ racine, profil });
  try {
    await fenetre.emulateMedia({ colorScheme: "dark" });
    await ouvrirPage(fenetre, "demo", "Démo");
    const page = fenetre.getByTestId("rendu-page");
    for (const nom of ["titre", "paragraphe", "encadre", "chiffre", "chiffres", "liste", "cartes", "tableau", "champs", "etiquettes", "lien", "groupe", "colonnes"]) {
      await expect(page.getByTestId(`bloc-${nom}`).first(), nom).toBeVisible();
    }
    // Mise en page de secours : la mention est en tête.
    await expect(page.getByTestId("mention-secours")).toHaveText("mise en page simple");
    await expect(page.getByTestId("bloc-chiffre")).toContainText("3");
    await expect(page.getByTestId("bloc-encadre")).toContainText("Charlie");
    await expect(page.getByTestId("bloc-champs")).toContainText("semaine");
    await expect(page.getByTestId("bloc-groupe")).toContainText("Dans le groupe.");
    await expect(page.getByTestId("bloc-colonnes")).toContainText("À droite.");
    // Les couleurs suivent le thème (sombre par défaut, clair au réglage du système).
    const fond = () => fenetre.getByTestId("bloc-encadre").evaluate((e) => getComputedStyle(e).backgroundColor);
    const sombre = await fond();
    await fenetre.emulateMedia({ colorScheme: "light" });
    await expect.poll(fond).not.toBe(sombre);
  } finally {
    await fermer();
  }
});

test("un titre « <b>gras</b> » s'affiche en texte", async () => {
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireAction(racine, profil, "demo", { nom: "Démo", resultats: RESULTATS_DEMO, blocs: BLOCS_DEMO });
  const { fenetre, fermer } = await lancer({ racine, profil });
  try {
    await ouvrirPage(fenetre, "demo", "Démo");
    const titre = fenetre.getByTestId("bloc-titre");
    await expect(titre).toHaveText("<b>gras</b>");
    await expect(titre.locator("b")).toHaveCount(0);
    await expect(fenetre.getByTestId("mention-secours")).toHaveCount(0);
  } finally {
    await fermer();
  }
});

test("cliquer l'en-tête Priorité trie le tableau", async () => {
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireAction(racine, profil, "demo", { nom: "Démo", resultats: RESULTATS_DEMO, blocs: BLOCS_DEMO });
  const { fenetre, fermer } = await lancer({ racine, profil });
  try {
    await ouvrirPage(fenetre, "demo", "Démo");
    const tableau = fenetre.getByTestId("bloc-tableau");
    const colonne = () => tableau.locator("tbody tr td:nth-child(2)").allTextContents();
    expect(await colonne()).toEqual(["9", "10", "2"]);
    const entete = tableau.getByRole("columnheader", { name: "Priorité" });
    await entete.getByRole("button").click();
    await expect.poll(colonne).toEqual(["2", "9", "10"]);
    await expect(entete).toHaveAttribute("aria-sort", "ascending");
    await entete.getByRole("button").click();
    await expect.poll(colonne).toEqual(["10", "9", "2"]);
    await expect(entete).toHaveAttribute("aria-sort", "descending");
    await expect(tableau.getByRole("columnheader", { name: "Nom" })).toHaveAttribute("aria-sort", "none");
  } finally {
    await fermer();
  }
});

test("un lien sans url n'est pas cliquable ; un lien permis ouvre un onglet", async () => {
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireAction(racine, profil, "demo", { nom: "Démo", resultats: RESULTATS_DEMO, blocs: BLOCS_DEMO });
  const { app, fenetre, fermer } = await lancer({ racine, profil });
  try {
    await ouvrirPage(fenetre, "demo", "Démo");
    const liste = fenetre.getByTestId("bloc-liste");
    await expect(liste.getByText("Bravo")).toBeVisible();
    await expect(liste.getByRole("button", { name: "Bravo" })).toHaveCount(0);
    await expect(liste.locator("a")).toHaveCount(0);
    const urls = () => app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => w.getURL()));
    expect((await urls()).some((u) => u.includes("exemple.invalide/alpha"))).toBe(false);
    await liste.getByRole("button", { name: "Alpha" }).click();
    await expect.poll(async () => (await urls()).some((u) => u.includes("exemple.invalide/alpha"))).toBe(true);
  } finally {
    await fermer();
  }
});

test("action avec compte : l'image est un emplacement neutre et aucune requête n'atteint le serveur de test", async () => {
  const requetes: string[] = [];
  const serveur = createServer((req, res) => {
    requetes.push(req.url ?? "/");
    res.writeHead(200, { "Content-Type": "image/png" }).end();
  });
  await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
  const image = `https://127.0.0.1:${(serveur.address() as AddressInfo).port}/photo.png`;
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireAction(racine, profil, "courrier", {
    nom: "Courrier",
    compte: ["mail.exemple.fr"],
    resultats: { messages: [{ sujet: "Bonjour", photo: image }] },
    blocs: [{ composant: "cartes", props: { elements: "messages", titre: "sujet", image: "photo" } }],
  });
  const { fenetre, fermer } = await lancer({ racine, profil });
  try {
    await ouvrirPage(fenetre, "courrier", "Courrier");
    const cartes = fenetre.getByTestId("bloc-cartes");
    await expect(cartes.getByText("Bonjour")).toBeVisible();
    await expect(cartes.getByTestId("image-neutre")).toBeVisible();
    await expect(cartes.locator("img")).toHaveCount(0);
    await fenetre.waitForTimeout(500);
    expect(requetes).toEqual([]);
  } finally {
    await fermer();
    await new Promise((ok) => serveur.close(ok));
  }
});

/** Composant de l'agent : écrit les noms reçus, puis annonce sa hauteur (après un message que la page doit ignorer). */
const BARRES = `<!doctype html><meta charset="utf-8"><body style="margin:0"><p id="noms"></p>
<script>
  addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || e.data.type !== "composant") return;
    document.getElementById("noms").textContent = e.data.props.valeurs.map((t) => t.nom).join(", ") + " · " + e.data.theme;
    parent.postMessage({ type: "autre", px: 900 }, "*");
    parent.postMessage({ type: "hauteur", px: 321 }, "*");
  });
</script>`;

test("composant de l'agent : sa hauteur suit son message ; un composant absent montre « Composant indisponible : … » et le reste de la page s'affiche", async () => {
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireComposant(racine, "barres", BARRES);
  ecrireAction(racine, profil, "graphe", {
    nom: "Graphe",
    resultats: { taches: TACHES },
    blocs: [
      { composant: "titre", props: { texte: "Priorités" } },
      { composant: "barres", props: { valeurs: "taches" } },
      { composant: "absent", props: {} },
      { composant: "paragraphe", props: { texte: "Après le composant." } },
    ],
  });
  const { app, fenetre, fermer } = await lancer({ racine, profil });
  try {
    await fenetre.emulateMedia({ colorScheme: "dark" });
    await ouvrirPage(fenetre, "graphe", "Graphe");
    const cadre = fenetre.getByTestId("cadre-composant");
    await expect(cadre).toHaveAttribute("sandbox", "allow-scripts");
    await expect(cadre).toHaveAttribute("src", "webaios-composant://barres/composant.html");
    await expect.poll(() => cadre.evaluate((e) => e.getBoundingClientRect().height)).toBe(321);
    const texte = () =>
      app.evaluate(({ webContents }) =>
        Promise.all(
          webContents
            .getAllWebContents()
            .flatMap((w) => w.mainFrame.framesInSubtree)
            .filter((f) => f.url.startsWith("webaios-composant:"))
            .map((f) => f.executeJavaScript("document.getElementById('noms').textContent")),
        ),
      );
    await expect.poll(texte).toEqual(["Alpha, Bravo, Charlie · sombre"]);
    await expect(fenetre.getByTestId("bloc-erreur")).toHaveText("Composant indisponible : absent");
    await expect(fenetre.getByText("Après le composant.")).toBeVisible();
    await expect(fenetre.getByTestId("bloc-titre")).toHaveText("Priorités");
  } finally {
    await fermer();
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// La page de l'action (tâche 13) : de vraies exécutions, avec le faux docker (le moteur tourne sur le Mac), un site lent
// servi en local et un faux Ollama (Gemma) qui note chaque consigne. Rouvrir une page ne lance rien.

interface Serveur {
  url: string;
  journal: string[];
  fermer(): Promise<void>;
}

async function ecouter(gerer: (req: IncomingMessage, res: ServerResponse, corps: string) => void): Promise<Serveur> {
  const journal: string[] = [];
  const serveur = createServer((req, res) => {
    journal.push(req.url ?? "/");
    let corps = "";
    req.on("data", (d) => (corps += d));
    req.on("end", () => gerer(req, res, corps));
  });
  await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
  return {
    url: `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`,
    journal,
    fermer: () =>
      new Promise((ok) => {
        serveur.closeAllConnections();
        serveur.close(() => ok());
      }),
  };
}

/** Réglages des faux serveurs, remis à chaque test (les tests d'un fichier tournent l'un après l'autre). */
const reglages = { lenteurSiteMs: 0, lenteurGemmaMs: 0 };
/** Le plan que rend le faux Gemma : un titre, puis la liste des pages lues. */
const PLAN_GEMMA = {
  blocs: [
    { composant: "titre", props: { texte: "Pages lues" } },
    { composant: "liste", props: { elements: "$", titre: "page.titre" } },
  ],
};

let site: Serveur;
let ollama: Serveur & { prompts: string[] };

test.beforeAll(async () => {
  site = await ecouter((req, res) => {
    const n = /^\/lent\/(\d+)$/.exec(new URL(req.url ?? "/", "http://x").pathname)?.[1];
    if (!n) return void res.writeHead(404).end();
    setTimeout(() => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<title>Page ${n}</title><p>Texte ${n}</p>`), reglages.lenteurSiteMs);
  });
  const prompts: string[] = [];
  const serveur = await ecouter((req, res, corps) => {
    if (req.url !== "/api/chat") return void res.writeHead(200, { "Content-Type": "application/json" }).end('{"models":[]}');
    prompts.push(String((JSON.parse(corps) as { messages: { content: string }[] }).messages[0]?.content));
    setTimeout(
      () => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ message: { content: JSON.stringify(PLAN_GEMMA) } })),
      reglages.lenteurGemmaMs,
    );
  });
  ollama = Object.assign(serveur, { prompts });
});
test.afterAll(async () => {
  await Promise.all([site, ollama].map((s) => s?.fermer()));
});
test.beforeEach(() => {
  reglages.lenteurSiteMs = 0;
  reglages.lenteurGemmaMs = 0;
});

const lancerActions = (racine: string, profil: string) =>
  lancer({ racine, profil, env: { WEBAIOS_OLLAMA_URL: ollama.url, WEBAIOS_KEV_URL: ollama.url, WEBAIOS_TEST_ADRESSES_LOCALES: "1" } });

/** Une action exécutable : `action.json`, `workflow.json` (un bloc `code`, des blocs entre, puis la sortie vers la page). */
function ecrireActionExecutable(
  racine: string,
  id: string,
  o: { nom: string; code: string; compte?: string[]; saisie?: string; motsCles?: string[]; blocs?: { id: string; type: string; parametres: Record<string, unknown> }[] },
): void {
  const dossier = join(racine, "actions", id);
  mkdirSync(dossier, { recursive: true });
  writeFileSync(
    join(dossier, "action.json"),
    JSON.stringify({ nom: o.nom, sources: { compte: o.compte ?? [], publiques: [] }, ...(o.motsCles ? { motsCles: o.motsCles } : {}), ...(o.saisie ? { saisie: { libelle: o.saisie } } : {}) }),
  );
  const blocs = [{ id: "liste", type: "code", parametres: { source: "liste.mjs" } }, ...(o.blocs ?? []), { id: "sortie", type: "sortie", parametres: { vers: "page" } }];
  writeFileSync(
    join(dossier, "workflow.json"),
    JSON.stringify({ version: 1, blocs, liens: blocs.slice(1).map((b, i) => ({ de: blocs[i]!.id, vers: b.id })) }),
  );
  writeFileSync(join(dossier, "liste.mjs"), o.code);
}

/** Trois pages du site lent, lues une par une (un bloc par élément) : « Lecture de 127.0.0.1… » puis « 3 / 3 ». */
function ecrireActionPages(racine: string, id = "pages", nom = "Pages"): void {
  ecrireActionExecutable(racine, id, {
    nom,
    code: `export default async () => [1, 2, 3].map((n) => ({ url: "${site.url}/lent/" + n }));`,
    blocs: [{ id: "lecture", type: "source.page", parametres: { url: "{url}", parElement: true, champ: "page" } }],
  });
}

/** Exécutions finies écrites sur disque pour cette action (sans les fichiers temporaires). */
const executionsSurDisque = (profil: string, id: string) => {
  const dossier = join(profil, "actions", id, "executions");
  return existsSync(dossier) ? readdirSync(dossier).filter((f) => f.endsWith(".json")).sort() : [];
};

const SANS_NOYAU = "Le service des actions ne répond pas (agent arrêté ?)";
/** Attend que le noyau serve les actions (une action inconnue est alors refusée comme telle). */
async function attendreNoyau(fenetre: Page): Promise<void> {
  await expect
    .poll(() => fenetre.evaluate((m) => window.webaios.actions.lancer("inconnue-du-test", null).then((r) => r.erreur !== m), SANS_NOYAU), { timeout: 30_000 })
    .toBe(true);
}

/** Ouvre la page de l'action (le dernier résultat, ou `execution`) sans rien lancer. */
async function ouvrirAction(fenetre: Page, id: string, nom: string, execution?: string): Promise<void> {
  await fenetre.evaluate(
    ([id, nom, execution]) =>
      window.webaios.agir({ type: "ouvrirAction", fenetreId: window.webaios.fenetreId, id, nom, ...(execution ? { execution } : {}) }),
    [id, nom, execution] as const,
  );
  await expect(fenetre.getByTestId("page-action")).toBeVisible();
}

test("pendant l'exécution, « Lecture de 127.0.0.1… » puis « 3 / 3 » puis « Mise en page… », puis la page", async () => {
  test.setTimeout(90_000);
  reglages.lenteurSiteMs = 1500;
  reglages.lenteurGemmaMs = 2500;
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireActionPages(racine);
  const { fenetre, fermer } = await lancerActions(racine, profil);
  try {
    await attendreNoyau(fenetre);
    const prompts = ollama.prompts.length;
    await ouvrirAction(fenetre, "pages", "Pages");
    // Ouvrir la page ne lance rien.
    await expect(fenetre.getByTestId("pas-de-resultat")).toHaveText("Pas encore de résultat");
    await expect(fenetre.getByTestId("nom-action")).toHaveText("Pages");
    await fenetre.waitForTimeout(500);
    expect(executionsSurDisque(profil, "pages")).toEqual([]);
    await fenetre.getByTestId("relancer-action").click();
    const avancement = fenetre.getByTestId("avancement-action");
    await expect(avancement.getByText("Lecture de 127.0.0.1…")).toBeVisible({ timeout: 30_000 });
    await expect(avancement.getByTestId("compteur-bloc")).toHaveText("3 / 3", { timeout: 30_000 });
    await expect(avancement.getByTestId("mise-en-page")).toHaveText("Mise en page…", { timeout: 30_000 });
    await expect(fenetre.getByTestId("rendu-page")).toBeVisible({ timeout: 30_000 });
    await expect(fenetre.getByTestId("bloc-titre")).toHaveText("Pages lues");
    await expect(fenetre.getByTestId("bloc-liste")).toContainText("Page 2");
    await expect(avancement).toHaveCount(0);
    await expect(fenetre.getByTestId("heure-resultat")).not.toBeEmpty();
    expect(ollama.prompts.length).toBe(prompts + 1);
    expect(executionsSurDisque(profil, "pages")).toHaveLength(1);
  } finally {
    await fermer();
  }
});

test("Arrêter : la page dit « Arrêtée à ta demande »", async () => {
  test.setTimeout(90_000);
  reglages.lenteurSiteMs = 4000;
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireActionPages(racine);
  const { fenetre, fermer } = await lancerActions(racine, profil);
  try {
    await attendreNoyau(fenetre);
    await ouvrirAction(fenetre, "pages", "Pages");
    await fenetre.getByTestId("relancer-action").click();
    await expect(fenetre.getByTestId("avancement-action").getByText("Lecture de 127.0.0.1…")).toBeVisible({ timeout: 30_000 });
    await fenetre.getByTestId("arreter-action").click();
    await expect(fenetre.getByTestId("erreur-action")).toHaveText("Arrêtée à ta demande", { timeout: 30_000 });
    await expect(fenetre.getByTestId("avancement-action")).toHaveCount(0);
  } finally {
    await fermer();
  }
});

test("relancer pendant l'exécution n'en démarre pas une seconde (une seule exécution écrite)", async () => {
  test.setTimeout(90_000);
  reglages.lenteurSiteMs = 1500;
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireActionPages(racine);
  const { fenetre, fermer } = await lancerActions(racine, profil);
  try {
    await attendreNoyau(fenetre);
    await ouvrirAction(fenetre, "pages", "Pages");
    const relancer = fenetre.getByTestId("relancer-action");
    await relancer.click();
    await expect(fenetre.getByTestId("avancement-action")).toBeVisible({ timeout: 30_000 });
    // Le bouton est grisé pendant l'exécution ; un lancement de plus (l'agent, une autre fenêtre) rend la même exécution.
    await expect(relancer).toBeDisabled();
    const [a, b] = await fenetre.evaluate(() => Promise.all([window.webaios.actions.lancer("pages", null), window.webaios.actions.lancer("pages", null)]));
    expect(a.execution).toBeTruthy();
    expect(b.execution).toBe(a.execution);
    await expect(fenetre.getByTestId("rendu-page")).toBeVisible({ timeout: 30_000 });
    await expect(relancer).toBeEnabled();
    expect(executionsSurDisque(profil, "pages")).toHaveLength(1);
  } finally {
    await fermer();
  }
});

/** Une exécution finie et son résultat (un titre), écrits sur disque. */
function ecrireResultat(profil: string, id: string, execution: string, debut: string, titre: string, saisie: string | null = null): void {
  const donnees = join(profil, "actions", id);
  mkdirSync(join(donnees, "executions"), { recursive: true });
  mkdirSync(join(donnees, "resultats"), { recursive: true });
  writeFileSync(
    join(donnees, "executions", `${execution}.json`),
    JSON.stringify({
      version: 1,
      id: execution,
      proprietaire: { type: "action", id },
      declencheur: "manuelle",
      debut,
      fin: debut,
      statut: "reussie",
      ...(saisie ? { saisie } : {}),
      blocs: [],
    }),
  );
  writeFileSync(
    join(donnees, "resultats", `${execution}.json`),
    JSON.stringify({
      version: 1,
      execution,
      saisie,
      resultats: { titre },
      plan: { blocs: [{ composant: "titre", props: { texte: titre } }] },
      secours: false,
      vide: false,
    }),
  );
}

test("menu des résultats précédents : rouvrir l'exécution d'hier ne lance rien (aucun prompt de plus au faux Ollama)", async () => {
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireActionExecutable(racine, "annonces", { nom: "Annonces", saisie: "Recherche", code: "export default async () => ({});" });
  const HIER = "2026-10-30T08-00-00-000Z";
  const AUJOURDHUI = "2026-10-31T08-00-00-000Z";
  ecrireResultat(profil, "annonces", HIER, "2026-10-30T08:00:00.000Z", "Hier", "clio lyon");
  ecrireResultat(profil, "annonces", AUJOURDHUI, "2026-10-31T08:00:00.000Z", "Aujourd'hui", "208 paris");
  const { fenetre, fermer } = await lancerActions(racine, profil);
  try {
    await attendreNoyau(fenetre);
    const prompts = ollama.prompts.length;
    await ouvrirAction(fenetre, "annonces", "Annonces");
    await expect(fenetre.getByTestId("bloc-titre")).toHaveText("Aujourd'hui");
    await expect(fenetre.getByTestId("saisie-action")).toHaveValue("208 paris");
    await fenetre.getByTestId("resultats-precedents").click();
    const hier = fenetre.getByTestId(`resultat-${HIER}`);
    await expect(hier).toContainText("clio lyon");
    await expect(hier).toContainText("réussie");
    await hier.click();
    await expect(fenetre.getByTestId("bloc-titre")).toHaveText("Hier");
    await expect(fenetre.getByTestId("saisie-action")).toHaveValue("clio lyon");
    await fenetre.waitForTimeout(500);
    expect(ollama.prompts.length).toBe(prompts);
    expect(executionsSurDisque(profil, "annonces")).toEqual([`${HIER}.json`, `${AUJOURDHUI}.json`]);
  } finally {
    await fermer();
  }
});

test("workflow en échec : le message s'affiche", async () => {
  test.setTimeout(60_000);
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireActionExecutable(racine, "cassee", { nom: "Cassée", code: `export default async () => { throw new Error("Site indisponible"); };` });
  const { fenetre, fermer } = await lancerActions(racine, profil);
  try {
    await attendreNoyau(fenetre);
    const prompts = ollama.prompts.length;
    await ouvrirAction(fenetre, "cassee", "Cassée");
    await fenetre.getByTestId("relancer-action").click();
    await expect(fenetre.getByTestId("erreur-action")).toContainText("Site indisponible", { timeout: 30_000 });
    expect(ollama.prompts.length).toBe(prompts);
  } finally {
    await fermer();
  }
});

test("résultats vides : « Aucun résultat », aucun prompt", async () => {
  test.setTimeout(60_000);
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireActionExecutable(racine, "vide", { nom: "Vide", code: "export default async () => ({ tickets: [] });" });
  const { fenetre, fermer } = await lancerActions(racine, profil);
  try {
    await attendreNoyau(fenetre);
    const prompts = ollama.prompts.length;
    await ouvrirAction(fenetre, "vide", "Vide");
    await fenetre.getByTestId("relancer-action").click();
    await expect(fenetre.getByTestId("aucun-resultat")).toHaveText("Aucun résultat", { timeout: 30_000 });
    expect(ollama.prompts.length).toBe(prompts);
    expect(executionsSurDisque(profil, "vide")).toHaveLength(1);
  } finally {
    await fermer();
  }
});

test("action avec compte sans accord : la carte, puis l'exécution après accord", async () => {
  test.setTimeout(60_000);
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireActionExecutable(racine, "courrier", {
    nom: "Courrier",
    compte: ["127.0.0.1"],
    code: `export default async () => ({ messages: [{ sujet: "Bonjour" }] });`,
  });
  const { fenetre, fermer } = await lancerActions(racine, profil);
  try {
    await attendreNoyau(fenetre);
    await ouvrirAction(fenetre, "courrier", "Courrier");
    const carte = fenetre.getByTestId("carte-accord");
    await expect(carte.getByRole("heading")).toHaveText("Autoriser l'action « Courrier » à lire avec ton compte");
    await expect(carte.getByTestId("accord-compte")).toHaveText("Cette action veut lire 127.0.0.1 avec ton compte, connecté avec le profil choisi.");
    await expect(carte.getByRole("radio", { checked: true })).toHaveValue("defaut");
    // Rien n'est lancé tant que l'utilisateur n'a pas accordé.
    await fenetre.waitForTimeout(500);
    expect(executionsSurDisque(profil, "courrier")).toEqual([]);
    await carte.getByRole("button", { name: "Autoriser" }).click();
    await expect(carte).toHaveCount(0);
    await expect(fenetre.getByTestId("rendu-page")).toBeVisible({ timeout: 30_000 });
    await expect(fenetre.getByTestId("rendu-page")).toContainText("Bonjour");
    expect(executionsSurDisque(profil, "courrier")).toHaveLength(1);
  } finally {
    await fermer();
  }
});

test("onglet webaios://action/x dans un espace privé : ACTIONS_EN_ESPACE_PRIVE, rien de lancé", async () => {
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireActionExecutable(racine, "x", { nom: "X", code: "export default async () => ({ a: 1 });" });
  ecrireResultat(profil, "x", "2026-10-31T08-00-00-000Z", "2026-10-31T08:00:00.000Z", "Secret");
  const { fenetre, fermer } = await lancerActions(racine, profil);
  try {
    await attendreNoyau(fenetre);
    const prompts = ollama.prompts.length;
    await reglerEspaceActifPrive(fenetre, true);
    await ouvrirOnglet(fenetre, "webaios://action/x");
    await expect(fenetre.getByTestId("action-espace-prive")).toHaveText("Les actions ne sont pas disponibles dans un espace privé");
    await expect(fenetre.getByTestId("page-action")).toHaveCount(0);
    await expect(fenetre.getByText("Secret")).toHaveCount(0);
    await fenetre.waitForTimeout(500);
    expect(executionsSurDisque(profil, "x")).toEqual(["2026-10-31T08-00-00-000Z.json"]);
    expect(ollama.prompts.length).toBe(prompts);
  } finally {
    await fermer();
  }
});

test("fermer l'onglet pendant l'exécution : le résultat apparaît dans les résultats précédents", async () => {
  test.setTimeout(90_000);
  reglages.lenteurSiteMs = 1500;
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireActionPages(racine);
  const { fenetre, fermer } = await lancerActions(racine, profil);
  try {
    await attendreNoyau(fenetre);
    await ouvrirAction(fenetre, "pages", "Pages");
    await fenetre.getByTestId("relancer-action").click();
    await expect(fenetre.getByTestId("avancement-action")).toBeVisible({ timeout: 30_000 });
    // Fermer l'onglet n'arrête pas l'exécution.
    await fenetre.evaluate(
      () =>
        new Promise<void>((ok) => {
          const fin = window.webaios.surEtat((e) => {
            setTimeout(() => fin());
            const id = Object.values(e.onglets).find((o) => o.url.startsWith("webaios://action/pages"))!.id;
            window.webaios.agir({ type: "fermerOnglet", id });
            ok();
          });
        }),
    );
    await expect(fenetre.getByTestId("page-action")).toHaveCount(0);
    await expect.poll(() => executionsSurDisque(profil, "pages").length, { timeout: 60_000 }).toBe(1);
    const execution = executionsSurDisque(profil, "pages")[0]!.replace(/\.json$/, "");
    await expect
      .poll(() => fenetre.evaluate(() => window.webaios.actions.direct().then((d) => d.courantes.length)), { timeout: 30_000 })
      .toBe(0);
    await ouvrirAction(fenetre, "pages", "Pages");
    await expect(fenetre.getByTestId("rendu-page")).toBeVisible();
    await fenetre.getByTestId("resultats-precedents").click();
    await expect(fenetre.getByTestId(`resultat-${execution}`)).toContainText("réussie");
  } finally {
    await fermer();
  }
});

test("une exécution qui n'existe plus : « Ce résultat n'existe plus » et le dernier résultat à un clic ; une action inconnue le dit", async () => {
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireActionExecutable(racine, "annonces", { nom: "Annonces", code: "export default async () => ({});" });
  const DERNIERE = "2026-10-31T08-00-00-000Z";
  ecrireResultat(profil, "annonces", DERNIERE, "2026-10-31T08:00:00.000Z", "Dernier");
  const { fenetre, fermer } = await lancerActions(racine, profil);
  try {
    await attendreNoyau(fenetre);
    const prompts = ollama.prompts.length;
    await ouvrirAction(fenetre, "annonces", "Annonces", "2026-10-01T08-00-00-000Z");
    await expect(fenetre.getByTestId("resultat-disparu")).toContainText("Ce résultat n'existe plus");
    await expect(fenetre.getByTestId("rendu-page")).toHaveCount(0);
    await fenetre.getByTestId("voir-dernier-resultat").click();
    await expect(fenetre.getByTestId("bloc-titre")).toHaveText("Dernier");
    await expect(fenetre.getByTestId("resultat-disparu")).toHaveCount(0);
    await ouvrirOnglet(fenetre, "webaios://action/inconnue");
    await expect(fenetre.getByTestId("erreur-action")).toHaveText("Action inconnue");
    expect(ollama.prompts.length).toBe(prompts);
    expect(executionsSurDisque(profil, "annonces")).toEqual([`${DERNIERE}.json`]);
  } finally {
    await fermer();
  }
});

// --- Les suggestions du nouvel onglet -------------------------------------------------------------------------

const TICKETS_NOM = "Mes tickets GitLab à traiter";
type AppElectron = import("@playwright/test").ElectronApplication;
/** Note (et coupe) les requêtes vers Google et exemple.org : aucun test n'atteint le réseau. */
const espionnerReseau = (app: AppElectron) =>
  app.evaluate(({ session }) => {
    const g = globalThis as unknown as { demandes: string[] };
    g.demandes = [];
    session.fromPartition("persist:webaios").webRequest.onBeforeRequest({ urls: ["https://www.google.com/*", "https://exemple.org/*"] }, (d, rappel) => {
      g.demandes.push(d.url);
      rappel({ cancel: true });
    });
  });
const demandesReseau = (app: AppElectron) => app.evaluate(() => (globalThis as unknown as { demandes: string[] }).demandes);

/** Deux actions : une sans saisie (mot-clé gitlab) et une avec saisie ; la fenêtre montre le nouvel onglet. */
async function lancerAvecSuggestions(opt: { prive?: boolean } = {}) {
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireActionExecutable(racine, "tickets", { nom: TICKETS_NOM, motsCles: ["gitlab"], code: "export default async () => [{ page: { titre: 'Ticket 1' } }];" });
  ecrireActionExecutable(racine, "leboncoin", { nom: "Leboncoin", saisie: "Recherche", code: "export default async () => [{ page: { titre: 'Annonce' } }];" });
  const o = await lancerActions(racine, profil);
  await attendreNoyau(o.fenetre);
  await espionnerReseau(o.app);
  if (opt.prive) await reglerEspaceActifPrive(o.fenetre, true);
  await o.fenetre.getByTestId("nouvel-onglet").click();
  await expect(o.fenetre.getByTestId("saisie-page-vide")).toBeVisible();
  return { ...o, profil };
}

test("taper « git » montre la suggestion ; ↓ puis Entrée ouvre la page de l'action et lance", async () => {
  test.setTimeout(90_000);
  const { fenetre, profil, fermer } = await lancerAvecSuggestions();
  try {
    const saisie = fenetre.getByTestId("saisie-page-vide");
    await saisie.fill("git");
    const liste = fenetre.getByTestId("suggestions-actions");
    await expect(liste).toContainText(TICKETS_NOM);
    await expect(liste).toContainText("Rechercher");
    await saisie.press("ArrowDown");
    await expect(saisie).toHaveAttribute("aria-activedescendant", /.+/);
    await saisie.press("Enter");
    await expect(fenetre.getByTestId("page-action")).toBeVisible();
    await expect.poll(() => executionsSurDisque(profil, "tickets"), { timeout: 60_000 }).toHaveLength(1);
  } finally {
    await fermer();
  }
});

test("Échap ferme la liste, Entrée cherche « git » comme avant", async () => {
  const { app, fenetre, profil, fermer } = await lancerAvecSuggestions();
  try {
    const saisie = fenetre.getByTestId("saisie-page-vide");
    await saisie.fill("git");
    await expect(fenetre.getByTestId("suggestions-actions")).toBeVisible();
    await saisie.press("Escape");
    await expect(fenetre.getByTestId("suggestions-actions")).toHaveCount(0);
    await saisie.press("Enter");
    await expect.poll(() => demandesReseau(app)).toContain("https://www.google.com/search?q=git");
    expect(executionsSurDisque(profil, "tickets")).toEqual([]);
  } finally {
    await fermer();
  }
});

test("taper « exemple.org » sans correspondance puis Entrée ouvre l'adresse", async () => {
  const { app, fenetre, fermer } = await lancerAvecSuggestions();
  try {
    const saisie = fenetre.getByTestId("saisie-page-vide");
    await saisie.fill("exemple.org");
    await expect(fenetre.getByTestId("suggestions-actions")).toHaveCount(0);
    await saisie.press("Enter");
    await expect.poll(() => demandesReseau(app)).toContain("https://exemple.org/");
  } finally {
    await fermer();
  }
});

test("« leboncoin » puis Entrée : page avec le champ de saisie, rien de lancé", async () => {
  const { fenetre, profil, fermer } = await lancerAvecSuggestions();
  try {
    const saisie = fenetre.getByTestId("saisie-page-vide");
    await saisie.fill("leboncoin");
    await expect(fenetre.getByTestId("suggestions-actions")).toContainText("Leboncoin");
    await saisie.press("ArrowDown");
    await saisie.press("Enter");
    await expect(fenetre.getByTestId("page-action")).toBeVisible();
    await expect(fenetre.getByTestId("saisie-action")).toBeVisible();
    await fenetre.waitForTimeout(500);
    expect(executionsSurDisque(profil, "leboncoin")).toEqual([]);
  } finally {
    await fermer();
  }
});

test("espace privé : aucune suggestion, la liste n'est même pas demandée", async () => {
  const { fenetre, fermer } = await lancerAvecSuggestions({ prive: true });
  try {
    await fenetre.evaluate(() => {
      const w = window as unknown as { webaios: { actions: { liste: () => unknown } }; __appels: number };
      w.__appels = 0;
      const liste = w.webaios.actions.liste.bind(w.webaios.actions);
      w.webaios.actions.liste = () => (w.__appels++, liste());
    });
    const saisie = fenetre.getByTestId("saisie-page-vide");
    await saisie.fill("git");
    await fenetre.waitForTimeout(500);
    await expect(fenetre.getByTestId("suggestions-actions")).toHaveCount(0);
    expect(await fenetre.evaluate(() => (window as unknown as { __appels: number }).__appels)).toBe(0);
  } finally {
    await fermer();
  }
});

test("la liste de suggestions n'est pas dans une zone de glisser de macOS", async () => {
  const { fenetre, fermer } = await lancerAvecSuggestions();
  try {
    await fenetre.getByTestId("saisie-page-vide").fill("git");
    const zone = await fenetre.getByTestId("suggestions-actions").evaluate((el) => getComputedStyle(el as HTMLElement).getPropertyValue("-webkit-app-region"));
    expect(zone).not.toBe("drag");
  } finally {
    await fermer();
  }
});
