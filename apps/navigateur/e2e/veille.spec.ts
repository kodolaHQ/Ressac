import { expect, test, type Page } from "@playwright/test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  dossierWidgets,
  ecrireDisposition,
  ecrireEtatWidget,
  ecrireWidget,
  lancer,
  lireNotifications,
  nouveauProfil,
  nouvelleRacine,
} from "./aide";

// Veille de bout en bout (plan 10, tâche 17) : tout est local. Un site d'annonces, une fausse DuckDuckGo (les pages
// enregistrées des tests du noyau), un faux Kev et un faux Ollama ; le faux docker fait tourner le moteur sur le Mac.
// Aucune vraie notification : l'aide e2e les note dans un fichier à côté du profil.

const FIXTURES_DDG = join(__dirname, "..", "..", "..", "packages", "noyau", "test", "workflows", "fixtures", "duckduckgo");
/** Message exact du noyau (accueil/schemas.ts, WEB_AVEC_COMPTE). */
const WEB_AVEC_COMPTE = "web : impossible avec un compte (les données d'un compte ne doivent pas pouvoir partir vers un site inconnu)";

interface Serveur {
  url: string;
  /** Chemins reçus, dans l'ordre. */
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

const html = (res: ServerResponse, corps: string) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(corps);

/** Cinq annonces de deux modèles : trois Clio 4, deux 208. */
const ANNONCES = [
  { n: 1, titre: "Renault Clio 4 – 6 500 €" },
  { n: 2, titre: "Peugeot 208 – 7 200 €" },
  { n: 3, titre: "Renault Clio 4 – 5 900 €" },
  { n: 4, titre: "Peugeot 208 – 6 800 €" },
  { n: 5, titre: "Renault Clio 4 – 7 900 €" },
];

/**
 * Réglages du site et des faux serveurs, remis à chaque test. Les tests d'un fichier tournent l'un après l'autre (un
 * seul ouvrier par fichier) ; chacun lit les journaux à partir de leur longueur à son début.
 */
const reglages = {
  /** Pages d'annonce (n) dont la lecture échoue (connexion coupée). */
  pagesEnEchec: new Set<number>(),
  /** Fichier rendu par la fausse DuckDuckGo. */
  ddg: "resultats.html",
  /** Délai de réponse du faux Gemma. */
  lenteurGemmaMs: 0,
};

let site: Serveur;
let kev: Serveur;
let ollama: Serveur & { prompts: string[] };

test.beforeAll(async () => {
  site = await ecouter((req, res) => {
    const chemin = new URL(req.url ?? "/", "http://x").pathname;
    if (chemin === "/recherche")
      return html(
        res,
        `<title>Annonces</title><h1>Voitures d'occasion</h1><ul>${ANNONCES.map((a) => `<li><a href="/annonce/${a.n}">${a.titre}</a></li>`).join("")}</ul><a href="/aide">Aide</a>`,
      );
    const annonce = /^\/annonce\/(\d+)$/.exec(chemin);
    if (annonce) {
      const n = Number(annonce[1]);
      if (reglages.pagesEnEchec.has(n)) return void req.socket.destroy();
      const a = ANNONCES.find((x) => x.n === n);
      return html(res, `<title>Annonce ${n}</title><p>${a?.titre ?? "?"}, première main, 82 000 km, carnet d'entretien.</p>`);
    }
    if (chemin === "/ddg/") return html(res, readFileSync(join(FIXTURES_DDG, reglages.ddg), "utf8"));
    if (chemin === "/court") return html(res, "<title>Court</title>");
    res.writeHead(404).end();
  });
  // Faux Kev : toute annonce correspond aux critères.
  kev = await ecouter((req, res) => {
    if (req.method === "GET") return void res.writeHead(200, { "Content-Type": "application/json" }).end('{"data":[]}');
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ answers: { q: { noul: 0.9 } } }));
  });
  // Faux Ollama : Gemma répond un avis court (après `lenteurGemmaMs`) et note chaque consigne.
  const prompts: string[] = [];
  const serveurOllama = await ecouter((req, res, corps) => {
    if (req.url !== "/api/chat") return void res.writeHead(200, { "Content-Type": "application/json" }).end('{"models":[]}');
    prompts.push(String((JSON.parse(corps) as { messages: { content: string }[] }).messages[0]?.content));
    setTimeout(
      () => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ message: { content: "Bonne affaire." } })),
      reglages.lenteurGemmaMs,
    );
  });
  ollama = Object.assign(serveurOllama, { prompts });
});
test.afterAll(async () => {
  await Promise.all([site, kev, ollama].map((s) => s?.fermer()));
});
test.beforeEach(() => {
  reglages.pagesEnEchec.clear();
  reglages.ddg = "resultats.html";
  reglages.lenteurGemmaMs = 0;
});

const lancerVeille = (racine: string, profil: string) =>
  lancer({
    racine,
    profil,
    env: {
      WEBAIOS_KEV_URL: kev.url,
      WEBAIOS_OLLAMA_URL: ollama.url,
      WEBAIOS_TEST_ADRESSES_LOCALES: "1",
      WEBAIOS_TEST_DUCKDUCKGO_URL: `${site.url}/ddg/`,
    },
  });

/** Affiche ce qu'il reçoit : les données (JSON) et le statut. */
const AFFICHAGE = `<!doctype html><meta charset="utf-8">
<pre id="donnees"></pre><span id="statut"></span>
<script>
  addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || e.data.type !== "widget") return;
    document.getElementById("donnees").textContent = JSON.stringify(e.data.donnees);
    document.getElementById("statut").textContent = e.data.etat.statut;
  });
</script>`;

/** Extraction des annonces de la page de recherche (le code `annonces.mjs` que l'agent écrirait). */
const ANNONCES_MJS = `export default async (page) => {
  const annonces = [];
  for (const l of page.liens) {
    if (!l.url.includes("/annonce/")) continue;
    const [nom, prix] = l.texte.split(" – ");
    const [marque, ...reste] = nom.split(" ");
    const modele = reste.join(" ");
    annonces.push({ titre: l.texte, url: l.url, prix, marque, modele, ...(marque && modele ? { modeleComplet: marque + " " + modele } : {}) });
  }
  if (annonces.length === 0) throw new Error("Aucune annonce trouvée : Leboncoin a peut-être bloqué la lecture");
  return annonces;
};
`;

/** Le widget de veille, d'après l'exemple commenté d'AGENTS.md (les voitures d'occasion). */
function ecrireVeille(racine: string): void {
  ecrireWidget(racine, "voitures", {
    nom: "Veille voitures",
    tailles: { min: { l: 3, h: 3 }, max: { l: 12, h: 8 }, defaut: { l: 6, h: 5 } },
    recolte: { heures: ["07:00"], dureeMaxMinutes: 30, notifier: true },
    sources: { web: true },
    config: { recherche: `${site.url}/recherche`, criteres: "citadine fiable, moins de 100 000 km, moins de 8 000 €" },
    workflow: {
      version: 1,
      blocs: [
        { id: "recherche", type: "source.page", parametres: { url: "{config.recherche}" } },
        { id: "annonces", type: "code", parametres: { source: "annonces.mjs" } },
        { id: "nouvelles", type: "liste.nouveaux", parametres: { cle: "url", garderJours: 30 } },
        { id: "tri", type: "ia.trier", parametres: { question: "Cette annonce correspond-elle à : {config.criteres} ?", texte: "{titre}" } },
        { id: "top", type: "liste.garder", parametres: { nombre: 10 } },
        { id: "fiche", type: "source.page", parametres: { url: "{url}", parElement: true, champ: "fiche" } },
        {
          id: "fiabilite",
          type: "web.chercher",
          parametres: {
            requete: "fiabilité {marque} {modele}",
            parElement: true,
            champ: "fiabilite",
            reutiliser: "modeleComplet",
            garderJours: 30,
          },
        },
        {
          id: "avis",
          type: "ia.rediger",
          parametres: {
            parElement: true,
            champ: "avis",
            consigne:
              "Donne en trois phrases l'intérêt de cette annonce pour : {config.criteres}. Si l'annonce est une page de vérification ou ne décrit pas une voiture, ne réponds rien. Si aucun résultat de recherche n'est donné, juge sans. --- DÉBUT DE L'ANNONCE --- {fiche.texte} --- FIN DE L'ANNONCE --- --- DÉBUT DES RÉSULTATS DE RECHERCHE --- {fiabilite?} --- FIN DES RÉSULTATS DE RECHERCHE ---",
          },
        },
        { id: "sortie", type: "sortie", parametres: { vers: "widget", auFilDeLEau: true } },
      ],
      liens: [
        { de: "recherche", vers: "annonces" },
        { de: "annonces", vers: "nouvelles" },
        { de: "nouvelles", vers: "tri" },
        { de: "tri", vers: "top" },
        { de: "top", vers: "fiche" },
        { de: "fiche", vers: "fiabilite" },
        { de: "fiabilite", vers: "avis" },
        { de: "avis", vers: "sortie" },
      ],
    },
    fichiers: { "annonces.mjs": ANNONCES_MJS },
    affichage: AFFICHAGE,
    exemple: [],
  });
}

/** État « à jour, heure du jour déjà faite » : aucune exécution ne part d'elle-même pendant le test. */
function etatSansRattrapage(profil: string, id: string): void {
  const maintenant = new Date().toISOString();
  ecrireEtatWidget(profil, id, { statut: "ok", derniereMaj: maintenant, derniereTentative: maintenant, heures: { faite: "9999-12-31T23:59", echecs: null } });
}

const cadre = (fenetre: Page, id: string) => fenetre.frameLocator(`[data-testid="widget-${id}"] iframe`);
const donneesAffichees = (fenetre: Page, id: string) => cadre(fenetre, id).locator("#donnees");

async function recolter(fenetre: Page, id: string): Promise<void> {
  const w = fenetre.getByTestId(`widget-${id}`);
  await w.getByRole("button", { name: "Options du widget" }).click();
  await w.getByRole("menuitem", { name: "Mettre à jour maintenant" }).click();
}

const lireJson = (chemin: string) => JSON.parse(readFileSync(chemin, "utf8"));

type Annonce = { titre: string; url: string; marque: string; modele: string; fiche?: { texte: string }; fiabilite?: unknown[]; avis?: string };
const donneesVeille = (profil: string): Annonce[] | null => {
  const f = join(dossierWidgets(profil), "voitures", "donnees.json");
  return existsSync(f) ? lireJson(f) : null;
};

/** Exécutions du widget, de la plus ancienne à la plus récente. */
const executions = (profil: string, id = "voitures") => {
  const dossier = join(dossierWidgets(profil), id, "executions");
  if (!existsSync(dossier)) return [];
  return readdirSync(dossier)
    .sort()
    .map((f) => lireJson(join(dossier, f)) as { statut: string; declencheur: string; blocs: { id: string; statut: string; journal: string[] }[] });
};
const statutBloc = (e: { blocs: { id: string; statut: string }[] }, id: string) => e.blocs.find((b) => b.id === id)?.statut;
const urlAnnonce = (n: number) => `${site.url}/annonce/${n}`;

/** Requêtes reçues par la fausse DuckDuckGo depuis l'indice `depuis` du journal du site. */
const recherches = (depuis: number) => site.journal.slice(depuis).filter((c) => c.startsWith("/ddg/"));
const lecturesAnnonces = (depuis: number) => site.journal.slice(depuis).filter((c) => c.startsWith("/annonce/"));

/** Une exécution manuelle de la veille, attendue jusqu'à sa fin (une nouvelle exécution écrite). */
async function executerVeille(fenetre: Page, profil: string): Promise<{ statut: string; blocs: { id: string; statut: string; journal: string[] }[] }> {
  const avant = executions(profil).length;
  await recolter(fenetre, "voitures");
  await expect.poll(() => executions(profil).length, { timeout: 60_000 }).toBe(avant + 1);
  return executions(profil).at(-1)!;
}

// ---------------------------------------------------------------------------------------------------------------------

test("veille de bout en bout : le widget se remplit au fil de l'eau (compteur vu), une recherche par modèle, une notification « 5 nouveaux éléments »", async () => {
  test.setTimeout(120_000);
  // Gemma lent : les annonces finissent l'une après l'autre, la progression et les publications se voient.
  reglages.lenteurGemmaMs = 2500;
  const racine = nouvelleRacine();
  ecrireVeille(racine);
  ecrireDisposition(racine, [{ id: "voitures", x: 0, y: 0, l: 6, h: 5 }]);
  const profil = nouveauProfil();
  etatSansRattrapage(profil, "voitures");
  const depuis = site.journal.length;
  const { fenetre, fermer } = await lancerVeille(racine, profil);
  const widget = fenetre.getByTestId("widget-voitures");
  await expect(donneesAffichees(fenetre, "voitures")).toHaveText("[]");

  await recolter(fenetre, "voitures");
  // Le compteur, puis une partie des annonces dans le widget avant la fin.
  await expect(widget.getByTestId("progression")).toHaveText(/^mise à jour… [1-4] \/ 5$/, { timeout: 60_000 });
  await expect
    .poll(async () => {
      const t = await donneesAffichees(fenetre, "voitures").textContent();
      const n = t?.startsWith("[") ? (JSON.parse(t) as unknown[]).length : -1;
      return n >= 1 && n < 5;
    }, { timeout: 30_000 })
    .toBe(true);
  // Puis toutes, avec leur fiche, leur fiabilité et leur avis.
  await expect.poll(() => executions(profil).length, { timeout: 60_000 }).toBe(1);
  const execution = executions(profil)[0]!;
  expect(execution.statut).toBe("reussie");
  const annonces = donneesVeille(profil)!;
  expect(annonces.map((a) => a.url).sort()).toEqual([1, 2, 3, 4, 5].map(urlAnnonce).sort());
  for (const a of annonces) {
    expect(a.fiche?.texte).toContain("première main");
    expect(a.fiabilite?.length).toBeGreaterThan(0);
    expect(a.avis).toBe("Bonne affaire.");
  }
  await expect(widget.getByTestId("progression")).toHaveCount(0);
  await expect(donneesAffichees(fenetre, "voitures")).toContainText("Bonne affaire.");
  // Une recherche par modèle (trois Clio 4, deux 208), une lecture par annonce.
  expect(recherches(depuis).map((c) => decodeURIComponent(c.slice(c.indexOf("?q=") + 3)).replace(/\+/g, " ")).sort()).toEqual([
    "fiabilité Peugeot 208",
    "fiabilité Renault Clio 4",
  ]);
  expect(lecturesAnnonces(depuis).sort()).toEqual([1, 2, 3, 4, 5].map((n) => `/annonce/${n}`));
  // La notification : le nom du widget, le nombre d'éléments, rien d'autre.
  await expect.poll(() => lireNotifications(profil)).toEqual([{ titre: "Veille voitures", texte: "5 nouveaux éléments" }]);
  await fermer();
});

test("seconde exécution : aucune annonce déjà vue, aucune recherche pour un modèle déjà étudié, aucune notification", async () => {
  test.setTimeout(120_000);
  const racine = nouvelleRacine();
  ecrireVeille(racine);
  ecrireDisposition(racine, [{ id: "voitures", x: 0, y: 0, l: 6, h: 5 }]);
  const profil = nouveauProfil();
  etatSansRattrapage(profil, "voitures");
  const { fenetre, fermer } = await lancerVeille(racine, profil);
  expect((await executerVeille(fenetre, profil)).statut).toBe("reussie");
  expect(donneesVeille(profil)).toHaveLength(5);
  await expect.poll(() => lireNotifications(profil)).toHaveLength(1);

  const depuis = site.journal.length;
  const promptsAvant = ollama.prompts.length;
  const seconde = await executerVeille(fenetre, profil);
  expect(seconde.statut).toBe("reussie");
  // Rien de nouveau : aucune page d'annonce relue, aucune recherche, aucun avis demandé ; le widget montre la liste vide.
  expect(lecturesAnnonces(depuis)).toEqual([]);
  expect(recherches(depuis)).toEqual([]);
  expect(ollama.prompts.length).toBe(promptsAvant);
  expect(donneesVeille(profil)).toEqual([]);
  await expect(donneesAffichees(fenetre, "voitures")).toHaveText("[]");
  // Laisse le temps à une notification fautive d'être notée.
  await new Promise((r) => setTimeout(r, 1000));
  expect(lireNotifications(profil)).toEqual([{ titre: "Veille voitures", texte: "5 nouveaux éléments" }]);
  await fermer();
});

test("une annonce dont la page échoue revient à l'exécution suivante", async () => {
  test.setTimeout(120_000);
  const racine = nouvelleRacine();
  ecrireVeille(racine);
  ecrireDisposition(racine, [{ id: "voitures", x: 0, y: 0, l: 6, h: 5 }]);
  const profil = nouveauProfil();
  etatSansRattrapage(profil, "voitures");
  const { fenetre, fermer } = await lancerVeille(racine, profil);
  reglages.pagesEnEchec.add(3);
  const premiere = await executerVeille(fenetre, profil);
  expect(premiere.statut).toBe("partielle");
  expect(statutBloc(premiere, "fiche")).toBe("partiel");
  const sansFiche = donneesVeille(profil)!.find((a) => a.url === urlAnnonce(3))!;
  expect(sansFiche.fiche).toBeUndefined();
  expect(sansFiche.avis).toBeUndefined();

  // La page répond de nouveau : seule l'annonce 3 revient, lue cette fois ; son modèle (Clio 4) déjà étudié n'est pas recherché.
  reglages.pagesEnEchec.clear();
  const depuis = site.journal.length;
  const seconde = await executerVeille(fenetre, profil);
  expect(seconde.statut).toBe("reussie");
  expect(lecturesAnnonces(depuis)).toEqual(["/annonce/3"]);
  expect(recherches(depuis)).toEqual([]);
  const revenue = donneesVeille(profil)!;
  expect(revenue.map((a) => a.url)).toEqual([urlAnnonce(3)]);
  expect(revenue[0]!.fiche?.texte).toContain("5 900 €");
  expect(revenue[0]!.fiabilite?.length).toBeGreaterThan(0);
  expect(revenue[0]!.avis).toBe("Bonne affaire.");
  await fermer();
});

test("une veille longue en cours n'empêche pas un widget court de se mettre à jour", async () => {
  test.setTimeout(120_000);
  // Chaque avis prend 8 s : la veille dure bien plus que la récolte du widget court.
  reglages.lenteurGemmaMs = 8000;
  const racine = nouvelleRacine();
  ecrireVeille(racine);
  ecrireWidget(racine, "court", {
    nom: "Court",
    recolte: { minutes: 60 },
    code: "export default async () => ({ court: true });",
    affichage: AFFICHAGE,
    exemple: { exemple: "court" },
  });
  ecrireDisposition(racine, [
    { id: "voitures", x: 0, y: 0, l: 6, h: 5 },
    { id: "court", x: 6, y: 0, l: 4, h: 3 },
  ]);
  const profil = nouveauProfil();
  etatSansRattrapage(profil, "voitures");
  ecrireEtatWidget(profil, "court");
  const { fenetre, fermer } = await lancerVeille(racine, profil);
  await expect(donneesAffichees(fenetre, "court")).toHaveText('{"exemple":"court"}');
  await recolter(fenetre, "voitures");
  // La veille a commencé ses avis (Gemma appelé) : elle est en cours, et le restera plusieurs secondes.
  const promptsAvant = ollama.prompts.length;
  await expect.poll(() => ollama.prompts.length, { timeout: 30_000 }).toBeGreaterThan(promptsAvant);
  await recolter(fenetre, "court");
  await expect(donneesAffichees(fenetre, "court")).toHaveText('{"court":true}', { timeout: 15_000 });
  // Toujours en cours : le widget court n'a pas attendu la fin de la veille.
  expect(lireJson(join(dossierWidgets(profil), "voitures", "etat.json")).statut).toBe("en-cours");
  expect(executions(profil)).toEqual([]);
  await fermer();
});

test("DuckDuckGo montre une vérification : une seule requête envoyée, avis sans fiabilité, bloc partiel ; les annonces reviennent ensuite avec leur fiabilité", async () => {
  test.setTimeout(180_000);
  reglages.ddg = "verification.html";
  const racine = nouvelleRacine();
  ecrireVeille(racine);
  ecrireDisposition(racine, [{ id: "voitures", x: 0, y: 0, l: 6, h: 5 }]);
  const profil = nouveauProfil();
  etatSansRattrapage(profil, "voitures");
  const depuis = site.journal.length;
  const promptsAvant = ollama.prompts.length;
  const { fenetre, fermer } = await lancerVeille(racine, profil);
  const execution = await executerVeille(fenetre, profil);
  // Une seule requête : après le refus, les recherches suivantes de l'exécution ne partent plus.
  expect(recherches(depuis)).toHaveLength(1);
  expect(statutBloc(execution, "fiabilite")).toBe("partiel");
  expect(execution.blocs.find((b) => b.id === "fiabilite")!.journal.join("\n")).toContain("Recherche refusée par DuckDuckGo (vérification anti-robot)");
  expect(execution.statut).toBe("partielle");
  // Aucune annonce n'a de fiabilité ; l'avis est rédigé sans ({fiabilite?}, voir AGENTS.md).
  const annonces = donneesVeille(profil)!;
  expect(annonces).toHaveLength(5);
  for (const a of annonces) {
    expect(a.fiche?.texte).toContain("première main");
    expect(a.fiabilite).toBeUndefined();
    expect(a.avis).toBe("Bonne affaire.");
  }
  // Gemma a rédigé les cinq avis, sans aucun texte de fiabilité dans sa consigne.
  const prompts = ollama.prompts.slice(promptsAvant);
  expect(prompts).toHaveLength(5);
  for (const p of prompts) {
    expect(p).toContain("première main");
    expect(p).toContain("--- DÉBUT DES RÉSULTATS DE RECHERCHE ---  --- FIN DES RÉSULTATS DE RECHERCHE ---");
  }

  // La première exécution (partielle) notifie ses cinq annonces.
  const notification = [{ titre: "Veille voitures", texte: "5 nouveaux éléments" }];
  await expect.poll(() => lireNotifications(profil)).toEqual(notification);

  // DuckDuckGo répond de nouveau : les annonces en échec dans `fiabilite` reviennent, cette fois avec leur fiabilité.
  reglages.ddg = "resultats.html";
  const seconde = await executerVeille(fenetre, profil);
  expect(seconde.statut).toBe("reussie");
  const reprises = donneesVeille(profil)!;
  expect(reprises.map((a) => a.url).sort()).toEqual([1, 2, 3, 4, 5].map(urlAnnonce).sort());
  for (const a of reprises) expect(a.fiabilite?.length).toBeGreaterThan(0);
  // Revenues, elles ne sont pas notifiées une seconde fois. Laisse le temps à une notification fautive d'être notée.
  await new Promise((r) => setTimeout(r, 1000));
  expect(lireNotifications(profil)).toEqual(notification);
  await fermer();
});

test('le widget Gmail (compte, recolte.mjs) se met à jour comme avant ; avec "web": true ajouté, il s\'affiche en erreur avec le message exact', async () => {
  const racine = nouvelleRacine();
  const gmail = {
    nom: "Gmail",
    recolte: { minutes: 60 },
    sources: { compte: ["127.0.0.1"], publiques: [] },
    config: { url: `${site.url}/court` },
    code: "export default async (webaios) => ({ titre: (await webaios.lirePage(webaios.config.url, { compte: true })).titre });",
    affichage: AFFICHAGE,
    exemple: { exemple: "gmail" },
  };
  ecrireWidget(racine, "gmail", gmail);
  ecrireDisposition(racine, [{ id: "gmail", x: 0, y: 0, l: 4, h: 3 }]);
  const profil = nouveauProfil();
  // L'accord de l'utilisateur, déjà donné.
  ecrireEtatWidget(profil, "gmail");
  writeFileSync(join(dossierWidgets(profil), "accords.json"), JSON.stringify({ gmail: { domaines: ["127.0.0.1"], publiques: [], profil: "defaut" } }));
  const { fenetre, fermer } = await lancerVeille(racine, profil);
  await recolter(fenetre, "gmail");
  await expect(donneesAffichees(fenetre, "gmail")).toHaveText('{"titre":"Court"}', { timeout: 20_000 });
  expect(lireJson(join(dossierWidgets(profil), "gmail", "etat.json")).statut).toBe("ok");
  expect(executions(profil, "gmail").map((e) => e.statut)).toEqual(["reussie"]);

  // L'agent ajoute "web": true : le widget est refusé, avec le message exact, et ne gagne aucun accès.
  const depuis = site.journal.length;
  ecrireWidget(racine, "gmail", { ...gmail, sources: { ...gmail.sources, web: true } });
  await expect(fenetre.getByTestId("widget-gmail")).toContainText(WEB_AVEC_COMPTE);
  await expect(fenetre.getByTestId("widget-gmail").getByRole("button", { name: "Options du widget" })).toBeVisible();
  expect(site.journal.slice(depuis)).toEqual([]);
  await fermer();
});

test("quitter pendant la veille : à la relance, les annonces publiées sont là, l'exécution est interrompue", async () => {
  test.setTimeout(120_000);
  reglages.lenteurGemmaMs = 6000;
  const racine = nouvelleRacine();
  ecrireVeille(racine);
  ecrireDisposition(racine, [{ id: "voitures", x: 0, y: 0, l: 6, h: 5 }]);
  const profil = nouveauProfil();
  etatSansRattrapage(profil, "voitures");
  const premier = await lancerVeille(racine, profil);
  await recolter(premier.fenetre, "voitures");
  // Une première publication (au moins une annonce montrée), puis l'utilisateur quitte avant la fin.
  await expect.poll(() => donneesVeille(profil)?.length ?? 0, { timeout: 60_000 }).toBeGreaterThan(0);
  await premier.fermer();
  // Ce qui a été publié avant l'arrêt : une partie des annonces, chacune avec son avis.
  const publiees = donneesVeille(profil)!;
  expect(publiees.length).toBeGreaterThan(0);
  expect(publiees.length).toBeLessThan(5);
  for (const a of publiees) expect(a.avis).toBe("Bonne affaire.");
  // L'exécution est écrite « interrompue » ; aucune notification pour une exécution interrompue.
  expect(executions(profil).map((e) => e.statut)).toEqual(["interrompue"]);
  expect(lireNotifications(profil)).toEqual([]);

  reglages.lenteurGemmaMs = 0;
  const second = await lancerVeille(racine, profil);
  await expect(donneesAffichees(second.fenetre, "voitures")).toHaveText(JSON.stringify(donneesVeille(profil)));
  expect(donneesVeille(profil)!.map((a) => a.url)).toEqual(publiees.map((a) => a.url));
  // L'état n'est plus « en cours » (remis à celui d'avant), et rien n'a été relancé.
  await expect.poll(() => lireJson(join(dossierWidgets(profil), "voitures", "etat.json")).statut).toBe("ok");
  await expect(second.fenetre.getByTestId("widget-voitures").getByTestId("progression")).toHaveCount(0);
  expect(executions(profil).map((e) => e.statut)).toEqual(["interrompue"]);
  await second.fermer();
});
