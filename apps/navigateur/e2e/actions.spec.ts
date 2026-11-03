import { expect, test, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  dossierActions,
  dossierWidgets,
  ecrireAction,
  ecrireComposant,
  ecrireDisposition,
  ecrireEtatWidget,
  ecrireWidget,
  lancer,
  nouveauProfil,
  nouvelleRacine,
  ouvrirOnglet,
  reglerEspaceActifPrive,
} from "./aide";

// Les actions de bout en bout (plan 14). La page d'une action est servie depuis un résultat écrit par le test dans
// `<profil>/actions/<id>/…` (exécution et résultat), sans conteneur ni Gemma : rouvrir une page ne relance rien.

const EXECUTION = "2026-10-31T08-00-00-000Z";

type Bloc = { composant: string; props: Record<string, unknown>; blocs?: Bloc[]; gauche?: Bloc[]; droite?: Bloc[] };

/** Une action (`~/WebAiOs/actions/<id>/action.json`) et sa dernière exécution, avec son résultat, dans le profil. */
function ecrireActionAvecResultat(
  racine: string,
  profil: string,
  id: string,
  o: { nom: string; compte?: string[]; resultats: unknown; blocs: Bloc[]; secours?: boolean },
): void {
  ecrireAction(racine, id, { nom: o.nom, sources: { compte: o.compte ?? [] } });
  const donnees = join(dossierActions(profil), id);
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
  ecrireActionAvecResultat(racine, profil, "demo", { nom: "Démo", resultats: RESULTATS_DEMO, blocs: BLOCS_DEMO, secours: true });
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
  ecrireActionAvecResultat(racine, profil, "demo", { nom: "Démo", resultats: RESULTATS_DEMO, blocs: BLOCS_DEMO });
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
  ecrireActionAvecResultat(racine, profil, "demo", { nom: "Démo", resultats: RESULTATS_DEMO, blocs: BLOCS_DEMO });
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
  ecrireActionAvecResultat(racine, profil, "demo", { nom: "Démo", resultats: RESULTATS_DEMO, blocs: BLOCS_DEMO });
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
  ecrireActionAvecResultat(racine, profil, "courrier", {
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
  ecrireComposant(racine, "barres", {
    description: "Barres des priorités",
    proprietes: { valeurs: { genre: "reference", description: "Les tâches", requis: true } },
    html: BARRES,
  });
  ecrireActionAvecResultat(racine, profil, "graphe", {
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

type TicketGitlab = { n: number; titre: string; projet: string; priorite: string };
const TICKETS_GITLAB: TicketGitlab[] = [
  { n: 1, titre: "Connexion impossible", projet: "api", priorite: "urgent" },
  { n: 2, titre: "Facture en double", projet: "facturation", priorite: "normale" },
  { n: 3, titre: "Fuite mémoire du worker", projet: "api", priorite: "urgent" },
  { n: 4, titre: "Coquille sur l'accueil", projet: "site", priorite: "basse" },
  { n: 5, titre: "Export CSV lent", projet: "facturation", priorite: "normale" },
];
const ANNONCES_LBC = [
  { n: 1, titre: "Renault Clio 4", prix: 7200, ville: "Lyon" },
  { n: 2, titre: "Renault Clio 3", prix: 4900, ville: "Villeurbanne" },
];
const photoAnnonce = (n: number) => `https://img.leboncoin.exemple/photos/${n}.jpg`;

/**
 * Réglages des faux serveurs, remis à chaque test (les tests d'un fichier tournent l'un après l'autre). `plan` : ce que
 * rend le faux Gemma à une demande de mise en page (un objet, envoyé en JSON ; un texte, tel quel) ; à toute autre
 * consigne (un bloc `ia.rediger` d'un widget), il répond « Bonne affaire. ».
 */
const reglages: { lenteurSiteMs: number; lenteurGemmaMs: number; plan: unknown; tickets: TicketGitlab[] } = {
  lenteurSiteMs: 0,
  lenteurGemmaMs: 0,
  plan: null,
  tickets: [],
};
/** Le plan que rend le faux Gemma : un titre, puis la liste des pages lues. */
const PLAN_GEMMA = {
  blocs: [
    { composant: "titre", props: { texte: "Pages lues" } },
    { composant: "liste", props: { elements: "$", titre: "page.titre" } },
  ],
};

/** Les pages fixes du site de test (tâche 18) : les tickets « GitLab », la recherche « Leboncoin », celles des widgets. */
const PAGES_DU_SITE: Record<string, () => string> = {
  "/gitlab/tickets": () =>
    `<title>Tickets</title><h1>Tableau de bord</h1><ul>${reglages.tickets
      .map((t) => `<li><a href="/gitlab/ticket/${t.n}">#${t.n} ${t.titre} [${t.priorite}] (${t.projet})</a></li>`)
      .join("")}</ul><a href="/gitlab/aide">Aide</a>`,
  // Chaque photo est un lien (`source.page` ne rend que le texte et les liens d'une page) vers une adresse https.
  "/leboncoin/recherche": () =>
    `<title>Annonces</title><ul>${ANNONCES_LBC.map(
      (a) => `<li><a href="https://www.leboncoin.exemple/ad/${a.n}">${a.titre} – ${a.prix} – ${a.ville}</a> <a href="${photoAnnonce(a.n)}">Photo</a></li>`,
    ).join("")}</ul>`,
  "/court": () => "<title>Court</title>",
  "/veille": () => `<title>Veille</title><ul><li><a href="/annonce/1">Vélo de course</a></li><li><a href="/annonce/2">Vélo pliant</a></li></ul>`,
};

/** Le début de la consigne de mise en page (pages/mise-en-page.ts). */
const DEBUT_MISE_EN_PAGE = "Tu mets en page le résultat d'une action pour l'utilisateur.";

let site: Serveur;
let ollama: Serveur & { prompts: string[] };

test.beforeAll(async () => {
  site = await ecouter((req, res) => {
    const chemin = new URL(req.url ?? "/", "http://x").pathname;
    const page = PAGES_DU_SITE[chemin];
    if (page) return void setTimeout(() => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page()), chemin.startsWith("/gitlab/") ? reglages.lenteurSiteMs : 0);
    const n = /^\/lent\/(\d+)$/.exec(chemin)?.[1];
    if (!n) return void res.writeHead(404).end();
    setTimeout(() => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<title>Page ${n}</title><p>Texte ${n}</p>`), reglages.lenteurSiteMs);
  });
  const prompts: string[] = [];
  const serveur = await ecouter((req, res, corps) => {
    if (req.url !== "/api/chat") return void res.writeHead(200, { "Content-Type": "application/json" }).end('{"models":[]}');
    const prompt = String((JSON.parse(corps) as { messages: { content: string }[] }).messages[0]?.content);
    prompts.push(prompt);
    const plan = reglages.plan ?? PLAN_GEMMA;
    const contenu = !prompt.startsWith(DEBUT_MISE_EN_PAGE) ? "Bonne affaire." : typeof plan === "string" ? plan : JSON.stringify(plan);
    setTimeout(() => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ message: { content: contenu } })), reglages.lenteurGemmaMs);
  });
  ollama = Object.assign(serveur, { prompts });
});
test.afterAll(async () => {
  await Promise.all([site, ollama].map((s) => s?.fermer()));
});
test.beforeEach(() => {
  reglages.lenteurSiteMs = 0;
  reglages.lenteurGemmaMs = 0;
  reglages.plan = null;
  reglages.tickets = TICKETS_GITLAB;
});

const lancerActions = (racine: string, profil: string) =>
  lancer({ racine, profil, env: { WEBAIOS_OLLAMA_URL: ollama.url, WEBAIOS_KEV_URL: ollama.url, WEBAIOS_TEST_ADRESSES_LOCALES: "1" } });

/** Une action exécutable : `action.json`, `workflow.json` (un bloc `code`, des blocs entre, puis la sortie vers la page). */
function ecrireActionExecutable(
  racine: string,
  id: string,
  o: { nom: string; code: string; compte?: string[]; saisie?: string; motsCles?: string[]; blocs?: { id: string; type: string; parametres: Record<string, unknown> }[] },
): void {
  const blocs = [{ id: "liste", type: "code", parametres: { source: "liste.mjs" } }, ...(o.blocs ?? []), { id: "sortie", type: "sortie", parametres: { vers: "page" } }];
  ecrireAction(racine, id, {
    nom: o.nom,
    sources: { compte: o.compte ?? [] },
    ...(o.motsCles ? { motsCles: o.motsCles } : {}),
    ...(o.saisie ? { saisie: { libelle: o.saisie } } : {}),
    workflow: enChaine(blocs),
    fichiers: { "liste.mjs": o.code },
  });
}

/** Un workflow dont les blocs s'enchaînent dans l'ordre du tableau. */
const enChaine = (blocs: { id: string; type: string; parametres: Record<string, unknown> }[]) => ({
  version: 1,
  blocs,
  liens: blocs.slice(1).map((b, i) => ({ de: blocs[i]!.id, vers: b.id })),
});

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
  const dossier = join(dossierActions(profil), id, "executions");
  return existsSync(dossier) ? readdirSync(dossier).filter((f) => f.endsWith(".json")).sort() : [];
};

const SANS_NOYAU = "Le service des actions ne répond pas (agent arrêté ?)";
/** Le message du noyau pour une action sans workflow.json (actions/executer.ts). */
const ACTION_SANS_WORKFLOW = "Cette action n'a pas de workflow.json";
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
    // Un bloc qui ne lit pas de page : le libellé du catalogue (« Code »), jamais son id (« liste »).
    await expect(avancement.getByTestId("ligne-bloc").first().locator(".libelle")).toHaveText("Code");
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
  const donnees = join(dossierActions(profil), id);
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

test("lancement refusé sans exécution écrite (pas de workflow.json) : « Relancer » comme une suggestion montrent l'erreur", async () => {
  test.setTimeout(60_000);
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireAction(racine, "sans-workflow", { nom: "Sans workflow" });
  const { fenetre, fermer } = await lancerActions(racine, profil);
  try {
    await attendreNoyau(fenetre);
    // Comme le choix d'une suggestion ou « Lancer » de la page Actions : la page s'ouvre, le lancement part du process principal.
    expect(await fenetre.evaluate(() => window.webaios.actions.ouvrir("sans-workflow", null))).toEqual({ ok: true });
    await expect(fenetre.getByTestId("page-action")).toBeVisible();
    await expect(fenetre.getByTestId("erreur-action")).toHaveText(ACTION_SANS_WORKFLOW, { timeout: 30_000 });
    await expect(fenetre.getByTestId("pas-de-resultat")).toHaveCount(0);
    // Rechargée, la page le montre encore (rien n'est écrit sur le disque).
    await fenetre.reload();
    await expect(fenetre.getByTestId("erreur-action")).toHaveText(ACTION_SANS_WORKFLOW, { timeout: 30_000 });
    // « Relancer » depuis la page : de même.
    await fenetre.getByTestId("relancer-action").click();
    await expect(fenetre.getByTestId("erreur-action")).toHaveText(ACTION_SANS_WORKFLOW);
    expect(executionsSurDisque(profil, "sans-workflow")).toEqual([]);
  } finally {
    await fermer();
  }
});

test("atelier arrêté (Docker absent) : « Relancer » montre l'erreur au lieu de rien", async () => {
  test.setTimeout(60_000);
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireActionPages(racine);
  const { fenetre, fermer } = await lancer({
    racine,
    profil,
    env: { WEBAIOS_OLLAMA_URL: ollama.url, WEBAIOS_KEV_URL: ollama.url, WEBAIOS_TEST_ADRESSES_LOCALES: "1", FAUX_DOCKER_ABSENT: "1" },
  });
  try {
    await attendreNoyau(fenetre);
    await ouvrirAction(fenetre, "pages", "Pages");
    await fenetre.getByTestId("relancer-action").click();
    await expect(fenetre.getByTestId("erreur-action")).toHaveText("Mise à jour impossible : atelier arrêté", { timeout: 30_000 });
    await expect(fenetre.getByTestId("pas-de-resultat")).toHaveCount(0);
    expect(executionsSurDisque(profil, "pages")).toEqual([]);
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

/** Compte, dans le process principal, les appels IPC qui demandent la liste des actions. */
const espionnerListe = (app: AppElectron) =>
  app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { appelsListe: number };
    g.appelsListe = 0;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
    const canal = "webaios:actions-liste";
    const original = handlers.get(canal);
    if (!original) throw new Error("gestionnaire de la liste des actions introuvable");
    // Réenregistré par l'API publique : le gestionnaire d'origine reste appelé, après le comptage.
    ipcMain.removeHandler(canal);
    ipcMain.handle(canal, ((...a: unknown[]) => (g.appelsListe++, original(...a))) as Parameters<typeof ipcMain.handle>[1]);
  });
const appelsListe = (app: AppElectron) => app.evaluate(() => (globalThis as unknown as { appelsListe: number }).appelsListe);

/** Deux actions : une sans saisie (mot-clé gitlab) et une avec saisie ; la fenêtre montre le nouvel onglet. */
async function lancerAvecSuggestions(opt: { prive?: boolean } = {}) {
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireActionExecutable(racine, "tickets", { nom: TICKETS_NOM, motsCles: ["gitlab"], code: "export default async () => [{ page: { titre: 'Ticket 1' } }];" });
  ecrireActionExecutable(racine, "leboncoin", { nom: "Leboncoin", saisie: "Recherche", code: "export default async () => [{ page: { titre: 'Annonce' } }];" });
  const o = await lancerActions(racine, profil);
  await attendreNoyau(o.fenetre);
  await espionnerReseau(o.app);
  // Le compteur est posé avant l'ouverture du nouvel onglet (et avant le passage en espace privé) : toute demande de la
  // liste faite par ce nouvel onglet est comptée.
  await espionnerListe(o.app);
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

test("barre de commande : « leboncoin », Entrée demande la saisie ; « clio », Entrée lance avec elle", async () => {
  test.setTimeout(90_000);
  const { app, fenetre, profil, fermer } = await lancerAvecSuggestions();
  try {
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("nouvel-onglet")!.click());
    const saisie = fenetre.getByTestId("saisie-commande");
    await saisie.fill("leboncoin");
    await expect(fenetre.locator('[data-testid="ligne-commande"][data-type="action"]')).toHaveCount(1);
    await saisie.press("ArrowDown");
    await saisie.press("Enter");
    const parametre = fenetre.getByTestId("parametre-commande");
    await expect(parametre).toBeFocused();
    // Sur l'accueil, aucune page web : rien de prérempli.
    await expect(parametre).toHaveValue("");
    await expect(parametre).toHaveAttribute("placeholder", "Recherche");
    await parametre.fill("clio");
    await parametre.press("Enter");
    await expect(fenetre.getByTestId("page-action")).toBeVisible();
    await expect(fenetre.getByTestId("barre-commande")).toHaveCount(0);
    await expect.poll(() => executionsSurDisque(profil, "leboncoin"), { timeout: 60_000 }).toHaveLength(1);
    const [fichier] = executionsSurDisque(profil, "leboncoin");
    expect(JSON.parse(readFileSync(join(dossierActions(profil), "leboncoin", "executions", fichier!), "utf8")).saisie).toBe("clio");
  } finally {
    await fermer();
  }
});

/** Une action de plus : le noyau signale le changement (`api.actions.surChange`), que PageVide n'écoute qu'hors espace privé. */
const ajouterAction = (racine: string, id: string) =>
  ecrireActionExecutable(racine, id, { nom: `Autre ${id}`, code: "export default async () => [];" });

test("espace privé : aucune suggestion, la liste n'est même pas demandée (même quand les actions changent)", async () => {
  const { app, fenetre, racine, fermer } = await lancerAvecSuggestions({ prive: true });
  try {
    ajouterAction(racine, "nouvelle");
    await fenetre.getByTestId("saisie-page-vide").fill("autre");
    await fenetre.waitForTimeout(1500);
    await expect(fenetre.getByTestId("suggestions-actions")).toHaveCount(0);
    expect(await appelsListe(app)).toBe(0);
  } finally {
    await fermer();
  }
});

test("espace normal : un changement des actions redemande la liste (le compteur du process principal fonctionne)", async () => {
  const { app, fenetre, racine, fermer } = await lancerAvecSuggestions();
  try {
    ajouterAction(racine, "nouvelle");
    await expect.poll(() => appelsListe(app), { timeout: 15_000 }).toBeGreaterThan(0);
    await fenetre.getByTestId("saisie-page-vide").fill("autre");
    await expect(fenetre.getByTestId("suggestions-actions")).toContainText("Autre nouvelle");
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

// --- La page « Actions » (barre latérale) ---

const HIER = "2026-10-30T08:00:00.000Z";

/** Deux actions : « Tickets » (mots-clés, dernier résultat) et « Leboncoin » (saisie, jamais lancée). */
function ecrireDeuxActions(racine: string, profil: string): void {
  ecrireActionExecutable(racine, "tickets", { nom: TICKETS_NOM, motsCles: ["gitlab", "tickets"], code: "export default async () => [{ page: { titre: 'Ticket 1' } }];" });
  ecrireResultat(profil, "tickets", EXECUTION, HIER, "Ticket 1");
  ecrireActionExecutable(racine, "leboncoin", { nom: "Leboncoin", saisie: "Recherche", code: "export default async () => [{ page: { titre: 'Annonce' } }];" });
}

async function ouvrirPageActions(fenetre: Page): Promise<void> {
  await fenetre.getByTestId("bouton-actions").click();
  await expect(fenetre.getByTestId("page-actions")).toBeVisible();
}

test("la page liste deux actions avec leurs mots-clés et leur dernier résultat", async () => {
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireDeuxActions(racine, profil);
  const { fenetre, fermer } = await lancerActions(racine, profil);
  try {
    await attendreNoyau(fenetre);
    await ouvrirPageActions(fenetre);
    const tickets = fenetre.getByTestId("ligne-action-tickets");
    await expect(tickets).toContainText(TICKETS_NOM);
    await expect(tickets.getByTestId("mots-cles-tickets")).toHaveText("gitlab, tickets");
    await expect(tickets.getByTestId("dernier-tickets")).toContainText("Réussie");
    await expect(fenetre.getByTestId("ligne-action-leboncoin")).toContainText("Leboncoin");
    await expect(fenetre.getByTestId("dernier-leboncoin")).toContainText("Jamais lancée");
    // Pas d'accord : pas de « Retirer l'accord ».
    await expect(fenetre.getByTestId("retirer-accord-tickets")).toHaveCount(0);
  } finally {
    await fermer();
  }
});

test("Lancer ouvre la page de l'action ; une action à saisie la demande en ligne d'abord", async () => {
  test.setTimeout(90_000);
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireDeuxActions(racine, profil);
  const { fenetre, fermer } = await lancerActions(racine, profil);
  try {
    await attendreNoyau(fenetre);
    await ouvrirPageActions(fenetre);
    await fenetre.getByTestId("lancer-tickets").click();
    await expect(fenetre.getByTestId("page-action")).toBeVisible();
    await expect.poll(() => executionsSurDisque(profil, "tickets"), { timeout: 60_000 }).toHaveLength(2);
    await ouvrirPageActions(fenetre);
    await fenetre.getByTestId("lancer-leboncoin").click();
    const saisie = fenetre.getByTestId("saisie-leboncoin");
    await expect(saisie).toBeVisible();
    await expect(fenetre.getByTestId("page-action")).toHaveCount(0);
    // Saisie vide : rien n'est lancé, le champ reste avec son message.
    await saisie.press("Enter");
    await expect(fenetre.getByTestId("refus-actions")).toHaveText("Saisie requise : Recherche");
    await expect(saisie).toBeVisible();
    await expect(fenetre.getByTestId("page-action")).toHaveCount(0);
    expect(executionsSurDisque(profil, "leboncoin")).toHaveLength(0);
    await saisie.fill("vélo");
    await saisie.press("Enter");
    await expect(fenetre.getByTestId("page-action")).toBeVisible();
    await expect.poll(() => executionsSurDisque(profil, "leboncoin"), { timeout: 60_000 }).toHaveLength(1);
  } finally {
    await fermer();
  }
});

test("« Voir le workflow » ouvre le constructeur de l'action", async () => {
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireDeuxActions(racine, profil);
  const { fenetre, fermer } = await lancerActions(racine, profil);
  try {
    await attendreNoyau(fenetre);
    await ouvrirPageActions(fenetre);
    await fenetre.getByTestId("voir-workflow-tickets").click();
    await expect(fenetre.locator('[data-testid^="onglet-"]').filter({ hasText: `Workflow — ${TICKETS_NOM}` })).toHaveCount(1);
  } finally {
    await fermer();
  }
});

test("Supprimer : le dossier part dans actions/.corbeille, l'accord et les résultats sont effacés, la ligne disparaît", async () => {
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireActionExecutable(racine, "compte", { nom: "Avec compte", compte: ["127.0.0.1"], code: "export default async () => [{ page: { titre: 'x' } }];" });
  ecrireResultat(profil, "compte", EXECUTION, HIER, "Secret");
  ecrireDeuxActions(racine, profil);
  writeFileSync(join(dossierActions(profil), "accords.json"), JSON.stringify({ compte: { domaines: ["127.0.0.1"], publiques: [], profil: "defaut" } }));
  const { fenetre, fermer } = await lancerActions(racine, profil);
  try {
    await attendreNoyau(fenetre);
    await ouvrirPageActions(fenetre);
    await expect(fenetre.getByTestId("retirer-accord-compte")).toBeVisible();
    await fenetre.getByTestId("supprimer-compte").click();
    await expect(fenetre.getByTestId("confirmation-suppression-action")).toContainText("Avec compte");
    // La confirmation couvre toute la fenêtre, dont les zones de glisser de macOS (les clics CDP l'ignorent).
    for (const id of ["voile-suppression-action", "confirmation-suppression-action"]) {
      expect(await fenetre.getByTestId(id).evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region"))).toBe("no-drag");
    }
    // Annuler ne supprime rien.
    await fenetre.getByTestId("annuler-suppression-action").click();
    await expect(fenetre.getByTestId("ligne-action-compte")).toBeVisible();
    await fenetre.getByTestId("supprimer-compte").click();
    await fenetre.getByTestId("confirmer-suppression-action").click();
    await expect(fenetre.getByTestId("ligne-action-compte")).toHaveCount(0);
    expect(readdirSync(join(racine, "actions", ".corbeille")).some((f) => f.startsWith("compte-"))).toBe(true);
    expect(existsSync(join(racine, "actions", "compte"))).toBe(false);
    expect(existsSync(join(dossierActions(profil), "compte"))).toBe(false);
    expect(readFileSync(join(dossierActions(profil), "accords.json"), "utf8")).not.toContain("compte");
    await expect(fenetre.getByTestId("ligne-action-tickets")).toBeVisible();
  } finally {
    await fermer();
  }
});

test("Retirer l'accord : le bouton disparaît, résultats effacés", async () => {
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireActionExecutable(racine, "compte", { nom: "Avec compte", compte: ["127.0.0.1"], code: "export default async () => [{ page: { titre: 'x' } }];" });
  ecrireResultat(profil, "compte", EXECUTION, HIER, "Secret");
  writeFileSync(join(dossierActions(profil), "accords.json"), JSON.stringify({ compte: { domaines: ["127.0.0.1"], publiques: [], profil: "defaut" } }));
  const { fenetre, fermer } = await lancerActions(racine, profil);
  try {
    await attendreNoyau(fenetre);
    await ouvrirPageActions(fenetre);
    await fenetre.getByTestId("retirer-accord-compte").click();
    // Annuler garde l'accord et les résultats.
    await fenetre.getByTestId("annuler-suppression-action").click();
    await expect(fenetre.getByTestId("retirer-accord-compte")).toBeVisible();
    expect(existsSync(join(dossierActions(profil), "compte", "resultats", `${EXECUTION}.json`))).toBe(true);
    await fenetre.getByTestId("retirer-accord-compte").click();
    await fenetre.getByTestId("confirmer-suppression-action").click();
    await expect(fenetre.getByTestId("retirer-accord-compte")).toHaveCount(0);
    await expect(fenetre.getByTestId("dernier-compte")).toContainText("Jamais lancée");
    expect(existsSync(join(dossierActions(profil), "compte", "resultats", `${EXECUTION}.json`))).toBe(false);
  } finally {
    await fermer();
  }
});

test("une action.json abîmée montre son erreur", async () => {
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireDeuxActions(racine, profil);
  mkdirSync(join(racine, "actions", "cassee"), { recursive: true });
  writeFileSync(join(racine, "actions", "cassee", "action.json"), "{ pas du json");
  const { fenetre, fermer } = await lancerActions(racine, profil);
  try {
    await attendreNoyau(fenetre);
    await ouvrirPageActions(fenetre);
    await expect(fenetre.getByTestId("erreur-cassee")).toContainText("action.json");
    await expect(fenetre.getByTestId("lancer-cassee")).toHaveCount(0);
    await expect(fenetre.getByTestId("ligne-action-tickets")).toBeVisible();
  } finally {
    await fermer();
  }
});

test("aucune action : le message d'invitation ; espace privé : ACTIONS_EN_ESPACE_PRIVE", async () => {
  const { fenetre, fermer } = await lancerActions(nouvelleRacine(), nouveauProfil());
  try {
    await attendreNoyau(fenetre);
    await ouvrirPageActions(fenetre);
    await expect(fenetre.getByTestId("page-actions")).toContainText("Aucune action. Demande à l'agent de t'en créer une.");
    await reglerEspaceActifPrive(fenetre, true);
    await expect(fenetre.getByTestId("action-espace-prive")).toHaveText("Les actions ne sont pas disponibles dans un espace privé");
    await expect(fenetre.getByTestId("page-actions")).toHaveCount(0);
  } finally {
    await fermer();
  }
});

// --- De bout en bout (tâche 18) ---------------------------------------------------------------------------------------
// Les actions d'AGENTS.md (« Deux exemples d'actions »), avec le code d'extraction que l'agent écrirait. Les tickets
// « GitLab » sont lus avec le compte (profil de test, accord déjà donné) ; les photos « Leboncoin » viennent d'une
// session interceptée (aucun réseau).

/** `extraire.mjs` des tickets : lit les liens du tableau de bord (« #1 Titre [priorité] (projet) »). */
const EXTRAIRE_TICKETS = `export default async (page) => {
  const tickets = [];
  for (const l of page.liens) {
    const m = /^#(\\d+) (.+) \\[([\\w-]+)\\] \\(([\\w-]+)\\)$/.exec(l.texte.trim());
    if (m) tickets.push({ titre: m[2], projet: m[4], priorite: m[3], url: l.url });
  }
  return { tickets };
};
`;
const MISE_EN_PAGE_TICKETS = "un chiffre clé, les tickets par priorité, les trois plus urgents en encadré";
const ID_TICKETS = "tickets-gitlab";

/** L'action « Tickets GitLab » d'AGENTS.md : `source.page` avec le compte → `extraire` → page ; l'accord est donné. */
function ecrireActionTickets(racine: string, profil: string): void {
  ecrireAction(racine, ID_TICKETS, {
    nom: "Tickets GitLab",
    motsCles: ["gitlab", "tickets"],
    sources: { compte: ["127.0.0.1"] },
    miseEnPage: MISE_EN_PAGE_TICKETS,
    workflow: enChaine([
      { id: "tickets", type: "source.page", parametres: { url: `${site.url}/gitlab/tickets`, compte: true } },
      { id: "extraire", type: "code", parametres: { source: "extraire.mjs" } },
      { id: "sortie", type: "sortie", parametres: { vers: "page" } },
    ]),
    fichiers: { "extraire.mjs": EXTRAIRE_TICKETS },
  });
  accorder(profil, ID_TICKETS);
}

/** L'accord de l'utilisateur pour lire 127.0.0.1 avec son compte (profil par défaut, celui du test). */
function accorder(profil: string, id: string): void {
  mkdirSync(dossierActions(profil), { recursive: true });
  writeFileSync(join(dossierActions(profil), "accords.json"), JSON.stringify({ [id]: { domaines: ["127.0.0.1"], publiques: [], profil: "defaut" } }));
}

/** Le plan que Gemma rend pour les tickets : un chiffre clé, l'encadré des plus urgents, le tableau par priorité. */
const PLAN_TICKETS = {
  blocs: [
    { composant: "chiffre", props: { valeur: "compter(filtrer(tickets, priorite = urgent))", libelle: "Tickets urgents" } },
    { composant: "encadre", props: { niveau: "attention", titre: "À traiter d'abord", elements: "garder(filtrer(tickets, priorite = urgent), 3)", champ: "titre" } },
    {
      composant: "tableau",
      props: { elements: "regrouper(tickets, priorite)", colonnes: [{ champ: "titre", libelle: "Ticket" }, { champ: "projet", libelle: "Projet" }], lien: "url" },
    },
  ],
};

/** Ce qu'affiche la page des tickets (un chiffre, l'encadré, une section du tableau par priorité). */
async function attendrePageTickets(fenetre: Page): Promise<void> {
  const page = fenetre.getByTestId("rendu-page");
  await expect(page).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("bloc-chiffre").locator(".valeur")).toHaveText("2");
  await expect(page.getByTestId("bloc-chiffre")).toContainText("Tickets urgents");
  const encadre = page.getByTestId("bloc-encadre");
  await expect(encadre).toContainText("À traiter d'abord");
  await expect(encadre).toContainText("Connexion impossible");
  await expect(encadre).toContainText("Fuite mémoire du worker");
  await expect(encadre).not.toContainText("Facture en double");
  const tableau = page.getByTestId("bloc-tableau");
  await expect(tableau.locator('th[scope="rowgroup"]')).toHaveText(["urgent", "normale", "basse"]);
  await expect(tableau.locator("tbody").nth(1)).toContainText("Facture en double");
  await expect(tableau.locator("tbody").nth(1)).toContainText("Export CSV lent");
  await expect(page.getByTestId("mention-secours")).toHaveCount(0);
}

/** Les consignes de mise en page reçues par le faux Gemma depuis l'indice `depuis`. */
const promptsMiseEnPage = (depuis: number) => ollama.prompts.slice(depuis).filter((p) => p.startsWith(DEBUT_MISE_EN_PAGE));

const lireJsonFichier = (chemin: string) => JSON.parse(readFileSync(chemin, "utf8"));
const statutsSurDisque = (profil: string, id: string) =>
  executionsSurDisque(profil, id).map((f) => (lireJsonFichier(join(dossierActions(profil), id, "executions", f)) as { statut: string }).statut);

test("réussite de la spec : taper « git », valider, voir l'avancement puis un chiffre clé, un tableau par priorité et un encadré « à traiter d'abord »", async () => {
  test.setTimeout(120_000);
  reglages.lenteurSiteMs = 1500;
  reglages.plan = PLAN_TICKETS;
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireActionTickets(racine, profil);
  const { fenetre, fermer } = await lancerActions(racine, profil);
  try {
    await attendreNoyau(fenetre);
    const depuis = ollama.prompts.length;
    await fenetre.getByTestId("nouvel-onglet").click();
    const saisie = fenetre.getByTestId("saisie-page-vide");
    await saisie.fill("git");
    await expect(fenetre.getByTestId("suggestions-actions")).toContainText("Tickets GitLab");
    await saisie.press("ArrowDown");
    await saisie.press("Enter");
    await expect(fenetre.getByTestId("page-action")).toBeVisible();
    await expect(fenetre.getByTestId("avancement-action").getByText("Lecture de 127.0.0.1…")).toBeVisible({ timeout: 30_000 });
    await attendrePageTickets(fenetre);
    await expect(fenetre.getByTestId("avancement-action")).toHaveCount(0);
    // Une seule consigne de mise en page : les résultats (bornés) et la consigne de l'action, entre leurs marques.
    const prompts = promptsMiseEnPage(depuis);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Connexion impossible");
    expect(prompts[0]).toContain(`<<<CONSIGNE\n${MISE_EN_PAGE_TICKETS}\nCONSIGNE>>>`);
    expect(statutsSurDisque(profil, ID_TICKETS)).toEqual(["reussie"]);
  } finally {
    await fermer();
  }
});

test("le lendemain, sans ticket : « Aucun résultat », aucun prompt ; le résultat d'hier se rouvre sans relancer", async () => {
  test.setTimeout(120_000);
  reglages.plan = PLAN_TICKETS;
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireActionTickets(racine, profil);
  const { fenetre, fermer } = await lancerActions(racine, profil);
  try {
    await attendreNoyau(fenetre);
    await ouvrirAction(fenetre, ID_TICKETS, "Tickets GitLab");
    await fenetre.getByTestId("relancer-action").click();
    await attendrePageTickets(fenetre);
    const [hier] = executionsSurDisque(profil, ID_TICKETS).map((f) => f.replace(/\.json$/, ""));

    // Le lendemain, plus aucun ticket : la page le dit, sans rien demander à Gemma.
    reglages.tickets = [];
    const depuis = ollama.prompts.length;
    await fenetre.getByTestId("relancer-action").click();
    await expect(fenetre.getByTestId("aucun-resultat")).toHaveText("Aucun résultat", { timeout: 60_000 });
    expect(executionsSurDisque(profil, ID_TICKETS)).toHaveLength(2);
    expect(ollama.prompts.length).toBe(depuis);

    // Le résultat d'hier, rouvert depuis les résultats précédents : rien n'est relancé, Gemma n'est pas rappelée.
    await fenetre.getByTestId("resultats-precedents").click();
    await fenetre.getByTestId(`resultat-${hier}`).click();
    await attendrePageTickets(fenetre);
    await fenetre.waitForTimeout(500);
    expect(ollama.prompts.length).toBe(depuis);
    expect(executionsSurDisque(profil, ID_TICKETS)).toHaveLength(2);
  } finally {
    await fermer();
  }
});

/** Une image PNG d'un pixel. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/**
 * Les images des résultats sont cherchées dans la session `webaios-icones` : toute adresse https y est servie par le test
 * (un pixel) et notée. Aucune requête ne part sur le réseau.
 */
const intercepterImages = (app: AppElectron) =>
  app.evaluate(({ session }, png) => {
    const g = globalThis as unknown as { images: string[] };
    g.images = [];
    session.fromPartition("webaios-icones").protocol.handle("https", (req) => {
      g.images.push(req.url);
      return new Response(Buffer.from(png, "base64"), { headers: { "Content-Type": "image/png" } });
    });
  }, PNG);
const imagesDemandees = (app: AppElectron) => app.evaluate(() => (globalThis as unknown as { images: string[] }).images);

/** `extraire.mjs` des annonces : chaque annonce et sa photo (un lien de la page), le prix en nombre. */
const EXTRAIRE_ANNONCES = `export default async (page) => {
  const photos = new Map();
  for (const l of page.liens) {
    const p = /\\/photos\\/(\\d+)\\.jpg$/.exec(l.url);
    if (p) photos.set(p[1], l.url);
  }
  const annonces = [];
  for (const l of page.liens) {
    const m = /\\/ad\\/(\\d+)$/.exec(l.url);
    if (!m) continue;
    const [titre, prix, ville] = l.texte.split(" – ");
    annonces.push({ titre, prix: Number(prix), ville, url: l.url, ...(photos.has(m[1]) ? { photo: photos.get(m[1]) } : {}) });
  }
  return { annonces };
};
`;

test("Leboncoin « leboncoin clio lyon » : la saisie arrive dans l'URL lue, cartes avec photos chargées par webaios-image", async () => {
  test.setTimeout(120_000);
  reglages.plan = {
    blocs: [{ composant: "cartes", props: { elements: "trier(annonces, prix)", titre: "titre", sousTitre: "ville", valeur: "prix", image: "photo", lien: "url" } }],
  };
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireAction(racine, "annonces-leboncoin", {
    nom: "Annonces Leboncoin",
    saisie: { libelle: "Recherche" },
    sources: { web: true },
    miseEnPage: "des cartes avec le prix et la ville, les moins chères en premier",
    workflow: enChaine([
      { id: "recherche", type: "source.page", parametres: { url: `${site.url}/leboncoin/recherche?text={saisie}` } },
      { id: "extraire", type: "code", parametres: { source: "extraire.mjs" } },
      { id: "sortie", type: "sortie", parametres: { vers: "page" } },
    ]),
    fichiers: { "extraire.mjs": EXTRAIRE_ANNONCES },
  });
  const { app, fenetre, fermer } = await lancerActions(racine, profil);
  try {
    await attendreNoyau(fenetre);
    await intercepterImages(app);
    const depuis = site.journal.length;
    await fenetre.getByTestId("nouvel-onglet").click();
    const saisie = fenetre.getByTestId("saisie-page-vide");
    await saisie.fill("leboncoin clio lyon");
    await expect(fenetre.getByTestId("suggestions-actions")).toContainText("Annonces Leboncoin");
    await saisie.press("ArrowDown");
    await saisie.press("Enter");
    await expect(fenetre.getByTestId("page-action")).toBeVisible();
    const cartes = fenetre.getByTestId("bloc-cartes");
    await expect(cartes).toBeVisible({ timeout: 60_000 });
    // La saisie, encodée, dans l'adresse lue ; et gardée dans l'en-tête.
    expect(site.journal.slice(depuis)).toContain("/leboncoin/recherche?text=clio%20lyon");
    await expect(fenetre.getByTestId("saisie-action")).toHaveValue("clio lyon");
    // Les moins chères en premier, chacune avec sa photo, chargée par webaios-image.
    await expect(cartes.locator(".pa-carte .titre")).toHaveText(["Renault Clio 3", "Renault Clio 4"]);
    const images = cartes.locator("img");
    await expect(images).toHaveCount(2);
    for (const src of await images.evaluateAll((l) => l.map((i) => (i as HTMLImageElement).src))) expect(src).toMatch(/^webaios-image:/);
    await expect
      .poll(() => images.evaluateAll((l) => l.map((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth)))
      .toEqual([1, 1]);
    await expect(cartes.getByTestId("image-neutre")).toHaveCount(0);
    expect((await imagesDemandees(app)).sort()).toEqual([photoAnnonce(1), photoAnnonce(2)]);
  } finally {
    await fermer();
  }
});

test("Gemma rend du JSON invalide deux fois : page de secours avec « mise en page simple »", async () => {
  test.setTimeout(90_000);
  reglages.plan = "Voici la page : { blocs: [titre";
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireActionExecutable(racine, "taches", {
    nom: "Tâches",
    code: `export default async () => ({ taches: [{ nom: "Alpha", etat: "ouvert" }, { nom: "Bravo", etat: "fermé" }] });`,
  });
  const { fenetre, fermer } = await lancerActions(racine, profil);
  try {
    await attendreNoyau(fenetre);
    const depuis = ollama.prompts.length;
    await ouvrirAction(fenetre, "taches", "Tâches");
    await fenetre.getByTestId("relancer-action").click();
    const page = fenetre.getByTestId("rendu-page");
    await expect(page).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("mention-secours")).toHaveText("mise en page simple");
    await expect(page).toContainText("Alpha");
    await expect(page).toContainText("Bravo");
    // Deux tentatives, la seconde avec la raison du refus.
    const prompts = promptsMiseEnPage(depuis);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("la réponse n'est pas du JSON valide");
    expect(statutsSurDisque(profil, "taches")).toEqual(["reussie"]);
  } finally {
    await fermer();
  }
});

test("plan hostile (lien composé vers le serveur de test avec une donnée, image d'une action avec compte, HTML dans un titre) : aucune requête n'atteint le serveur avec la donnée, lien inerte, image neutre, titre en texte", async () => {
  test.setTimeout(90_000);
  const SECRET = "jeton-du-compte-4242";
  const fuite = `${site.url}/tiers?d=${SECRET}`;
  const titre = `<img src=${site.url}/tiers?d=titre>Tickets`;
  reglages.plan = {
    blocs: [
      { composant: "titre", props: { texte: titre } },
      // Une adresse composée par Gemma : un champ n'est qu'un nom, ce bloc est écarté.
      { composant: "lien", props: { objet: "compte", url: `"${site.url}/tiers?d=" + jeton`, texte: "Ouvrir" } },
      // Un champ qui ne contient pas d'adresse : le lien reste du texte.
      { composant: "lien", props: { objet: "compte", url: "jeton", texte: "Voir le jeton" } },
      // Une adresse des résultats vers le serveur de test (locale) : inerte. L'image d'une action avec compte : neutre.
      { composant: "cartes", props: { elements: "tickets", titre: "titre", image: "photo", lien: "fuite" } },
    ],
  };
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireActionExecutable(racine, "hostile", {
    nom: "Hostile",
    compte: ["127.0.0.1"],
    code: `export default async () => ({
      compte: { jeton: ${JSON.stringify(SECRET)} },
      tickets: [{ titre: "Connexion impossible", photo: "https://img.exemple.org/avatar.png", fuite: ${JSON.stringify(fuite)} }],
    });`,
  });
  accorder(profil, "hostile");
  const { app, fenetre, fermer } = await lancerActions(racine, profil);
  try {
    await attendreNoyau(fenetre);
    await intercepterImages(app);
    const depuis = site.journal.length;
    await ouvrirAction(fenetre, "hostile", "Hostile");
    await fenetre.getByTestId("relancer-action").click();
    const page = fenetre.getByTestId("rendu-page");
    await expect(page).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("mention-secours")).toHaveCount(0);
    // Le titre en texte, sans élément HTML.
    await expect(page.getByTestId("bloc-titre")).toHaveText(titre);
    await expect(page.locator("img")).toHaveCount(0);
    // Le lien composé est écarté ; l'autre n'est que du texte ; la carte n'a ni lien ni image.
    await expect(page.getByTestId("bloc-lien")).toHaveCount(1);
    await expect(page.getByTestId("bloc-lien")).toHaveText("Voir le jeton");
    await expect(page.locator("a, button.pa-lien")).toHaveCount(0);
    const cartes = page.getByTestId("bloc-cartes");
    await expect(cartes).toContainText("Connexion impossible");
    await expect(cartes.getByTestId("image-neutre")).toBeVisible();
    await cartes.getByText("Connexion impossible").click();
    await fenetre.waitForTimeout(1000);
    // Rien n'est parti : ni vers le serveur de test, ni vers l'adresse de l'image, et aucun onglet ouvert vers la fuite.
    expect(site.journal.slice(depuis).filter((c) => c.includes("/tiers") || c.includes(SECRET))).toEqual([]);
    expect(await imagesDemandees(app)).toEqual([]);
    const urls = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => w.getURL()));
    expect(urls.filter((u) => u.includes("/tiers"))).toEqual([]);
  } finally {
    await fermer();
  }
});

test("trois actions lancées : la troisième dit « En attente : deux actions tournent déjà », puis tourne", async () => {
  test.setTimeout(150_000);
  reglages.lenteurSiteMs = 3000;
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  for (const id of ["un", "deux", "trois"]) ecrireActionPages(racine, id, `Pages ${id}`);
  const { fenetre, fermer } = await lancerActions(racine, profil);
  try {
    await attendreNoyau(fenetre);
    // Les deux premières, lancées comme le ferait l'agent ou la page « Actions » (sans attendre leur fin).
    await fenetre.evaluate(() => {
      void window.webaios.actions.lancer("un", null);
      void window.webaios.actions.lancer("deux", null);
    });
    await expect.poll(() => fenetre.evaluate(() => window.webaios.actions.direct().then((d) => d.courantes.length)), { timeout: 30_000 }).toBe(2);
    await ouvrirAction(fenetre, "trois", "Pages trois");
    await fenetre.getByTestId("relancer-action").click();
    await expect(fenetre.getByTestId("en-attente")).toHaveText("En attente : deux actions tournent déjà", { timeout: 30_000 });
    const etat = await fenetre.evaluate(() => window.webaios.actions.direct());
    expect(etat.enAttente.map((a) => a.action)).toEqual(["trois"]);
    expect(etat.courantes.map((a) => a.action).sort()).toEqual(["deux", "un"]);
    // Une place se libère : la troisième tourne, puis montre sa page.
    await expect(fenetre.getByTestId("en-attente")).toHaveCount(0, { timeout: 60_000 });
    await expect(fenetre.getByTestId("rendu-page")).toBeVisible({ timeout: 60_000 });
    await expect(fenetre.getByTestId("bloc-liste")).toContainText("Page 3");
    for (const id of ["un", "deux", "trois"]) await expect.poll(() => statutsSurDisque(profil, id), { timeout: 60_000 }).toEqual(["reussie"]);
  } finally {
    await fermer();
  }
});

test("restauration de session avec un onglet d'action : le dernier résultat s'affiche, aucune exécution lancée", async () => {
  test.setTimeout(90_000);
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireActionExecutable(racine, "annonces", { nom: "Annonces", code: "export default async () => ({ titre: 'Nouveau' });" });
  ecrireResultat(profil, "annonces", EXECUTION, "2026-10-31T08:00:00.000Z", "Résultat gardé");
  const depuis = ollama.prompts.length;
  const premier = await lancerActions(racine, profil);
  await attendreNoyau(premier.fenetre);
  await ouvrirAction(premier.fenetre, "annonces", "Annonces");
  await expect(premier.fenetre.getByTestId("bloc-titre")).toHaveText("Résultat gardé");
  await premier.fermer();

  const second = await lancerActions(racine, profil);
  try {
    await expect(second.fenetre.getByTestId("page-action")).toBeVisible({ timeout: 30_000 });
    await expect(second.fenetre.getByTestId("bloc-titre")).toHaveText("Résultat gardé", { timeout: 30_000 });
    await expect(second.fenetre.getByTestId("avancement-action")).toHaveCount(0);
    await second.fenetre.waitForTimeout(1000);
    expect(executionsSurDisque(profil, "annonces")).toEqual([`${EXECUTION}.json`]);
    expect(await second.fenetre.evaluate(() => window.webaios.actions.direct())).toEqual({ courantes: [], enAttente: [] });
    expect(ollama.prompts.length).toBe(depuis);
  } finally {
    await second.fermer();
  }
});

/** Un affichage de widget qui écrit les données reçues (JSON) et son statut. */
const AFFICHAGE_WIDGET = `<!doctype html><meta charset="utf-8">
<pre id="donnees"></pre><span id="statut"></span>
<script>
  addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || e.data.type !== "widget") return;
    document.getElementById("donnees").textContent = JSON.stringify(e.data.donnees);
    document.getElementById("statut").textContent = e.data.etat.statut;
  });
</script>`;

const donneesWidget = (fenetre: Page, id: string) => fenetre.frameLocator(`[data-testid="widget-${id}"] iframe`).locator("#donnees");
async function mettreAJourWidget(fenetre: Page, id: string): Promise<void> {
  const w = fenetre.getByTestId(`widget-${id}`);
  await w.getByRole("button", { name: "Options du widget" }).click();
  await w.getByRole("menuitem", { name: "Mettre à jour maintenant" }).click();
}
const executionsWidget = (profil: string, id: string) => {
  const dossier = join(dossierWidgets(profil), id, "executions");
  return existsSync(dossier) ? readdirSync(dossier).filter((f) => f.endsWith(".json")) : [];
};
const executionsLuesWidget = (profil: string, id: string) =>
  executionsWidget(profil, id)
    .sort()
    .map((f) => lireJsonFichier(join(dossierWidgets(profil), id, "executions", f)) as { statut: string; proprietaire: unknown });

test("le widget Gmail (compte, recolte.mjs) et une veille se mettent à jour comme avant pendant qu'une action tourne", async () => {
  test.setTimeout(150_000);
  reglages.lenteurSiteMs = 8000;
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  // Le widget Gmail de l'utilisateur : un compte, une récolte écrite à la main (recolte.mjs), aucun workflow.
  ecrireWidget(racine, "gmail", {
    nom: "Gmail",
    recolte: { minutes: 60 },
    sources: { compte: ["127.0.0.1"], publiques: [] },
    config: { url: `${site.url}/court` },
    code: "export default async (webaios) => ({ titre: (await webaios.lirePage(webaios.config.url, { compte: true })).titre });",
    affichage: AFFICHAGE_WIDGET,
    exemple: { exemple: "gmail" },
  });
  // Une veille : la liste, les nouveautés, un avis de Gemma par annonce, montrées au fil de l'eau.
  ecrireWidget(racine, "veille", {
    nom: "Veille vélos",
    recolte: { heures: ["07:00"], dureeMaxMinutes: 30 },
    workflow: {
      version: 1,
      blocs: [
        { id: "recherche", type: "source.page", parametres: { url: `${site.url}/veille` } },
        { id: "annonces", type: "code", parametres: { source: "annonces.mjs" } },
        { id: "nouvelles", type: "liste.nouveaux", parametres: { cle: "url" } },
        { id: "avis", type: "ia.rediger", parametres: { parElement: true, champ: "avis", consigne: "Avis sur l'annonce : --- DÉBUT --- {titre} --- FIN ---" } },
        { id: "sortie", type: "sortie", parametres: { vers: "widget", auFilDeLEau: true } },
      ],
      liens: [
        { de: "recherche", vers: "annonces" },
        { de: "annonces", vers: "nouvelles" },
        { de: "nouvelles", vers: "avis" },
        { de: "avis", vers: "sortie" },
      ],
    },
    fichiers: { "annonces.mjs": "export default async (page) => page.liens.filter((l) => l.url.includes('/annonce/')).map((l) => ({ titre: l.texte, url: l.url }));" },
    affichage: AFFICHAGE_WIDGET,
    exemple: [],
  });
  ecrireDisposition(racine, [
    { id: "gmail", x: 0, y: 0, l: 4, h: 3 },
    { id: "veille", x: 4, y: 0, l: 6, h: 5 },
  ]);
  ecrireEtatWidget(profil, "gmail");
  const maintenant = new Date().toISOString();
  ecrireEtatWidget(profil, "veille", { statut: "ok", derniereMaj: maintenant, derniereTentative: maintenant, heures: { faite: "9999-12-31T23:59", echecs: null } });
  writeFileSync(join(dossierWidgets(profil), "accords.json"), JSON.stringify({ gmail: { domaines: ["127.0.0.1"], publiques: [], profil: "defaut" } }));
  ecrireActionPages(racine);
  const { fenetre, fermer } = await lancerActions(racine, profil);
  try {
    await expect(donneesWidget(fenetre, "gmail")).toHaveText('{"exemple":"gmail"}');
    await attendreNoyau(fenetre);
    await fenetre.evaluate(() => void window.webaios.actions.lancer("pages", null));
    const actionsCourantes = () => fenetre.evaluate(() => window.webaios.actions.direct().then((d) => d.courantes.map((c) => c.action)));
    await expect.poll(actionsCourantes, { timeout: 30_000 }).toEqual(["pages"]);

    await mettreAJourWidget(fenetre, "gmail");
    await mettreAJourWidget(fenetre, "veille");
    await expect(donneesWidget(fenetre, "gmail")).toHaveText('{"titre":"Court"}', { timeout: 30_000 });
    await expect.poll(() => executionsLuesWidget(profil, "veille").map((e) => e.statut), { timeout: 30_000 }).toEqual(["reussie"]);
    const veille = JSON.parse((await donneesWidget(fenetre, "veille").textContent()) ?? "null") as { titre: string; avis: string }[];
    expect(veille.map((a) => [a.titre, a.avis])).toEqual([
      ["Vélo de course", "Bonne affaire."],
      ["Vélo pliant", "Bonne affaire."],
    ]);
    // L'action tournait toujours pendant ces deux mises à jour.
    expect(await actionsCourantes()).toEqual(["pages"]);
    // Les exécutions des widgets sont restées celles d'un widget.
    expect(executionsLuesWidget(profil, "gmail").map((e) => e.statut)).toEqual(["reussie"]);
    for (const id of ["gmail", "veille"]) expect(executionsLuesWidget(profil, id)[0]!.proprietaire).toEqual({ type: "widget", id });
    expect(lireJsonFichier(join(dossierWidgets(profil), "gmail", "etat.json")).statut).toBe("ok");
    await expect.poll(() => statutsSurDisque(profil, "pages"), { timeout: 60_000 }).toEqual(["reussie"]);
  } finally {
    await fermer();
  }
});

test("quitter pendant une action : à la relance, son exécution est « interrompue » dans les résultats précédents", async () => {
  test.setTimeout(120_000);
  reglages.lenteurSiteMs = 6000;
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireActionPages(racine);
  const premier = await lancerActions(racine, profil);
  await attendreNoyau(premier.fenetre);
  await ouvrirAction(premier.fenetre, "pages", "Pages");
  await premier.fenetre.getByTestId("relancer-action").click();
  await expect(premier.fenetre.getByTestId("avancement-action").getByText("Lecture de 127.0.0.1…")).toBeVisible({ timeout: 30_000 });
  await premier.fermer();
  // L'exécution est écrite « interrompue » à l'arrêt ; aucun résultat n'est gardé pour elle.
  expect(statutsSurDisque(profil, "pages")).toEqual(["interrompue"]);
  const [execution] = executionsSurDisque(profil, "pages").map((f) => f.replace(/\.json$/, ""));
  expect(existsSync(join(dossierActions(profil), "pages", "resultats", `${execution}.json`))).toBe(false);

  reglages.lenteurSiteMs = 0;
  const second = await lancerActions(racine, profil);
  try {
    // L'onglet de l'action est restauré : il montre l'exécution interrompue, sans la relancer.
    await expect(second.fenetre.getByTestId("page-action")).toBeVisible({ timeout: 30_000 });
    await second.fenetre.getByTestId("resultats-precedents").click();
    await expect(second.fenetre.getByTestId(`resultat-${execution}`)).toContainText("interrompue");
    await second.fenetre.waitForTimeout(500);
    expect(statutsSurDisque(profil, "pages")).toEqual(["interrompue"]);
  } finally {
    await second.fermer();
  }
});
