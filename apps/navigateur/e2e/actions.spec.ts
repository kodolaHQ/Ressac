import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { lancer, nouveauProfil, nouvelleRacine } from "./aide";

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
