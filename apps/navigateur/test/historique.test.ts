import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Historique } from "../src/main/historique";

let h: Historique;
let chemin: string;
const date = (iso: string) => new Date(iso);

beforeEach(() => {
  chemin = join(mkdtempSync(join(tmpdir(), "webaios-hist-")), "historique.sqlite");
  h = new Historique(chemin);
});
afterEach(() => h.fermer());

test("noter deux fois la même URL → une ligne, visites = 2, titre mis à jour", () => {
  h.noter({ espaceId: "", prive: false, url: "https://a.fr/", titre: "Ancien", date: date("2026-10-01T10:00:00Z") });
  h.noter({ espaceId: "", prive: false, url: "https://a.fr/", titre: "Nouveau", date: date("2026-10-02T10:00:00Z") });
  expect(h.recents()).toEqual([{ url: "https://a.fr/", titre: "Nouveau", derniereVisite: "2026-10-02T10:00:00.000Z", visites: 2, espaceId: "", prive: false, retenu: false }]);
});

test("rechercher trouve par titre et par URL, sans tenir compte de la casse", () => {
  h.noter({ espaceId: "", prive: false, url: "https://www.youtube.com/watch?v=1", titre: "Conférence Rust" });
  h.noter({ espaceId: "", prive: false, url: "https://github.com/sveltejs/svelte", titre: "Svelte" });
  expect(h.rechercher("RUST").map((v) => v.url)).toEqual(["https://www.youtube.com/watch?v=1"]);
  expect(h.rechercher("GitHub").map((v) => v.titre)).toEqual(["Svelte"]);
});

test("rechercher ignore la casse et les accents hors ASCII (É, é, e)", () => {
  h.noter({ espaceId: "", prive: false, url: "https://meteo.fr/", titre: "Été à Paris" });
  expect(h.rechercher("été").map((v) => v.url)).toEqual(["https://meteo.fr/"]);
  expect(h.rechercher("ETE").map((v) => v.url)).toEqual(["https://meteo.fr/"]);
});

test("tri : les plus visitées d'abord", () => {
  h.noter({ espaceId: "", prive: false, url: "https://rare.fr/", titre: "page rare", date: date("2026-10-03T00:00:00Z") });
  for (let i = 0; i < 3; i++) h.noter({ espaceId: "", prive: false, url: "https://souvent.fr/", titre: "page souvent", date: date("2026-10-01T00:00:00Z") });
  expect(h.rechercher("page").map((v) => v.url)).toEqual(["https://souvent.fr/", "https://rare.fr/"]);
});

test("recents : la plus récente d'abord", () => {
  h.noter({ espaceId: "", prive: false, url: "https://a.fr/", titre: "A", date: date("2026-10-01T00:00:00Z") });
  h.noter({ espaceId: "", prive: false, url: "https://b.fr/", titre: "B", date: date("2026-10-02T00:00:00Z") });
  expect(h.recents().map((v) => v.titre)).toEqual(["B", "A"]);
});

test("effacer(depuis) ne retire que les visites récentes", () => {
  h.noter({ espaceId: "", prive: false, url: "https://vieux.fr/", titre: "V", date: date("2026-10-01T00:00:00Z") });
  h.noter({ espaceId: "", prive: false, url: "https://recent.fr/", titre: "R", date: date("2026-10-05T00:00:00Z") });
  h.effacer(date("2026-10-04T00:00:00Z"));
  expect(h.recents().map((v) => v.url)).toEqual(["https://vieux.fr/"]);
  h.effacer();
  expect(h.recents()).toEqual([]);
});

test("les caractères spéciaux (% _ ') dans la recherche sont traités littéralement", () => {
  h.noter({ espaceId: "", prive: false, url: "https://a.fr/100%", titre: "cent pour cent" });
  h.noter({ espaceId: "", prive: false, url: "https://a.fr/x_y", titre: "l'apostrophe" });
  h.noter({ espaceId: "", prive: false, url: "https://a.fr/autre", titre: "rien" });
  expect(h.rechercher("%").map((v) => v.url)).toEqual(["https://a.fr/100%"]);
  expect(h.rechercher("_").map((v) => v.url)).toEqual(["https://a.fr/x_y"]);
  expect(h.rechercher("l'a").map((v) => v.url)).toEqual(["https://a.fr/x_y"]);
  expect(h.rechercher("\\")).toEqual([]);
});

test("l'historique survit à la réouverture du fichier", () => {
  h.noter({ espaceId: "", prive: false, url: "https://a.fr/", titre: "A" });
  h.fermer();
  h = new Historique(chemin);
  expect(h.recents().map((v) => v.url)).toEqual(["https://a.fr/"]);
});

test("majTitre change le titre d'une URL déjà notée, sans compter de visite", () => {
  h.noter({ espaceId: "", prive: false, url: "https://a.fr/", titre: "https://a.fr/" });
  h.majTitre("https://a.fr/", "", "Le vrai titre");
  h.majTitre("https://inconnu.fr/", "", "ignoré");
  expect(h.recents()).toMatchObject([{ url: "https://a.fr/", titre: "Le vrai titre", visites: 1 }]);
});

test("après fermer, noter et majTitre sont ignorés sans lever d'erreur (événements tardifs à la sortie)", () => {
  h.fermer();
  expect(() => h.noter({ espaceId: "", prive: false, url: "https://a.fr/", titre: "A" })).not.toThrow();
  expect(() => h.majTitre("https://a.fr/", "", "A")).not.toThrow();
  expect(h.recents()).toEqual([]);
});

test("même URL dans deux espaces : deux lignes ; une nouvelle visite dans A ne compte que pour A", () => {
  h.noter({ url: "https://a.fr/", titre: "A", espaceId: "A", prive: false });
  h.noter({ url: "https://a.fr/", titre: "A", espaceId: "B", prive: false });
  h.noter({ url: "https://a.fr/", titre: "A", espaceId: "A", prive: false });
  const lignes = h.recents();
  expect(lignes).toHaveLength(2);
  expect(Object.fromEntries(lignes.map((v) => [v.espaceId, v.visites]))).toEqual({ A: 2, B: 1 });
});

test("majTitre ne touche que l'espace visé", () => {
  h.noter({ url: "https://a.fr/", titre: "t", espaceId: "A", prive: false });
  h.noter({ url: "https://a.fr/", titre: "t", espaceId: "B", prive: false });
  h.majTitre("https://a.fr/", "A", "nouveau");
  expect(Object.fromEntries(h.recents().map((v) => [v.espaceId, v.titre]))).toEqual({ A: "nouveau", B: "t" });
});

test("une visite dans un espace privé est notée privée", () => {
  h.noter({ url: "https://a.fr/", titre: "A", espaceId: "P", prive: true });
  expect(h.recents()).toMatchObject([{ espaceId: "P", prive: true }]);
});

test("rendrePrive marque les lignes de cet espace seulement", () => {
  h.noter({ url: "https://a.fr/", titre: "A", espaceId: "A", prive: false });
  h.noter({ url: "https://a.fr/", titre: "A", espaceId: "B", prive: false });
  h.noter({ url: "https://b.fr/", titre: "B", espaceId: "", prive: false });
  h.rendrePrive("A");
  expect(Object.fromEntries(h.recents().map((v) => [`${v.espaceId}|${v.url}`, v.prive]))).toEqual({
    "A|https://a.fr/": true,
    "B|https://a.fr/": false,
    "|https://b.fr/": false,
  });
});

test("ancien schéma (clé url seule) : lignes gardées, espace vide, non privées", () => {
  h.fermer();
  const vieux = join(mkdtempSync(join(tmpdir(), "webaios-hist-")), "historique.sqlite");
  const db = new DatabaseSync(vieux);
  db.exec(`CREATE TABLE visites (url TEXT PRIMARY KEY, titre TEXT NOT NULL, derniere_visite TEXT NOT NULL, visites INTEGER NOT NULL DEFAULT 1);
    INSERT INTO visites VALUES ('https://vieux.fr/', 'Vieux', '2026-01-01T00:00:00.000Z', 3);`);
  db.close();
  h = new Historique(vieux);
  expect(h.recents()).toEqual([{ url: "https://vieux.fr/", titre: "Vieux", derniereVisite: "2026-01-01T00:00:00.000Z", visites: 3, espaceId: "", prive: false, retenu: false }]);
  h.noter({ url: "https://vieux.fr/", titre: "Vieux", espaceId: "A", prive: false });
  expect(h.recents()).toHaveLength(2);
  h.fermer();
  h = new Historique(vieux); // déjà migrée : rouvrir ne change rien
  expect(h.recents()).toHaveLength(2);
});

test("rechercher en mode distinct : une URL vue dans deux espaces sort une fois, et la limite compte des URL", () => {
  h.noter({ url: "https://a.fr/", titre: "page", espaceId: "A", prive: false });
  h.noter({ url: "https://a.fr/", titre: "page", espaceId: "B", prive: false });
  h.noter({ url: "https://b.fr/", titre: "page", espaceId: "A", prive: false });
  expect(h.rechercher("page")).toHaveLength(3);
  expect(h.rechercher("page", 2, true).map((v) => v.url).sort()).toEqual(["https://a.fr/", "https://b.fr/"]);
});

test("une ligne privée qui redevient non privée repart à une visite, avec titre et date neufs", () => {
  h.noter({ url: "https://a.fr/", titre: "Secret", espaceId: "A", prive: true, date: date("2026-10-01T00:00:00Z") });
  h.noter({ url: "https://a.fr/", titre: "Secret", espaceId: "A", prive: true, date: date("2026-10-02T00:00:00Z") });
  h.noter({ url: "https://a.fr/", titre: "Public", espaceId: "A", prive: false, date: date("2026-10-03T00:00:00Z") });
  expect(h.recents()).toMatchObject([{ visites: 1, prive: false, titre: "Public", derniereVisite: "2026-10-03T00:00:00.000Z" }]);
  h.noter({ url: "https://a.fr/", titre: "Public", espaceId: "A", prive: false });
  expect(h.recents()[0]!.visites).toBe(2);
});

// --- Texte retenu des pages (mémoire de navigation) ---

const JOUR = 86_400_000;
/** Une visite non privée et son texte retenu, à la même date. */
function visiter(url: string, titre: string, texte: string, o: { espaceId?: string; date?: string } = {}) {
  const d = date(o.date ?? "2026-10-01T00:00:00Z");
  h.noter({ url, titre, espaceId: o.espaceId ?? "A", prive: false, date: d });
  h.retenir({ url, titre, espaceId: o.espaceId ?? "A", texte, date: d });
}

test("retenir tronque le texte à 20 000 caractères", () => {
  visiter("https://a.fr/", "A", "x".repeat(25_000));
  expect(h.texteRetenu("https://a.fr/")!.texte).toHaveLength(20_000);
});

test("retenir une seconde fois la même page dans le même espace remplace le texte", () => {
  visiter("https://a.fr/", "A", "premier texte");
  visiter("https://a.fr/", "A", "second texte", { date: "2026-10-02T00:00:00Z" });
  expect(h.texteRetenu("https://a.fr/")).toEqual({ url: "https://a.fr/", titre: "A", date: "2026-10-02T00:00:00.000Z", texte: "second texte" });
  expect(h.rechercherPourAgent({ requete: "premier" })).toEqual([]);
});

test("Visite.retenu dit si le texte de cette visite (URL et espace) est retenu ; oublierTexte l'oublie seul", () => {
  visiter("https://a.fr/", "A", "texte", { espaceId: "A" });
  h.noter({ url: "https://a.fr/", titre: "A", espaceId: "B", prive: false });
  expect(Object.fromEntries(h.recents().map((v) => [v.espaceId, v.retenu]))).toEqual({ A: true, B: false });
  h.oublierTexte("https://a.fr/", "A");
  expect(h.recents().map((v) => v.retenu)).toEqual([false, false]);
  expect(h.recents()).toHaveLength(2);
});

test("purger efface le texte de plus de 183 jours et garde celui de 182", () => {
  const maintenant = date("2026-10-28T12:00:00Z");
  visiter("https://vieux.fr/", "V", "vieux", { date: new Date(maintenant.getTime() - 184 * JOUR).toISOString() });
  visiter("https://jeune.fr/", "J", "jeune", { date: new Date(maintenant.getTime() - 182 * JOUR).toISOString() });
  h.purger(maintenant);
  expect(h.texteRetenu("https://vieux.fr/")).toBeNull();
  expect(h.texteRetenu("https://jeune.fr/")).not.toBeNull();
  expect(h.recents()).toHaveLength(2); // les visites restent
});

test("au-delà du plafond, purger efface le texte le plus ancien d'abord", () => {
  h.fermer();
  h = new Historique(chemin, { plafondOctets: 25 });
  visiter("https://1.fr/", "1", "a".repeat(10), { date: "2026-10-01T00:00:00Z" });
  visiter("https://2.fr/", "2", "é".repeat(5), { date: "2026-10-02T00:00:00Z" }); // 10 octets en UTF-8
  visiter("https://3.fr/", "3", "c".repeat(10), { date: "2026-10-03T00:00:00Z" });
  h.purger(date("2026-10-04T00:00:00Z"));
  expect(["https://1.fr/", "https://2.fr/", "https://3.fr/"].map((u) => h.texteRetenu(u) !== null)).toEqual([false, true, true]);
});

test("effacer(depuis) efface aussi le texte retenu depuis cette date ; effacer() efface tout", () => {
  visiter("https://vieux.fr/", "V", "vieux", { date: "2026-10-01T00:00:00Z" });
  visiter("https://recent.fr/", "R", "recent", { date: "2026-10-05T00:00:00Z" });
  h.effacer(date("2026-10-04T00:00:00Z"));
  expect(h.texteRetenu("https://recent.fr/")).toBeNull();
  expect(h.texteRetenu("https://vieux.fr/")).not.toBeNull();
  expect(h.rechercherPourAgent({ requete: "recent" })).toEqual([]);
  h.effacer();
  expect(h.texteRetenu("https://vieux.fr/")).toBeNull();
  expect(h.rechercherPourAgent({ requete: "vieux" })).toEqual([]);
});

test("rendrePrive oublie le texte de cet espace et garde celui de la même URL dans un autre espace", () => {
  visiter("https://a.fr/", "A", "texte vu dans A", { espaceId: "A", date: "2026-10-02T00:00:00Z" });
  visiter("https://a.fr/", "A", "texte vu dans B", { espaceId: "B", date: "2026-10-01T00:00:00Z" });
  h.rendrePrive("A");
  expect(h.texteRetenu("https://a.fr/")!.texte).toBe("texte vu dans B");
  expect(h.recents().find((v) => v.espaceId === "A")!.retenu).toBe(false);
});

test("rechercherPourAgent trouve « eclair » dans le texte, le titre et l'URL, sans casse ni accents", () => {
  visiter("https://patisserie.fr/1", "Recettes", "Un Éclair au café");
  visiter("https://patisserie.fr/2", "L'ÉCLAIR parfait", "chocolat");
  visiter("https://eclair.fr/", "Accueil", "rien");
  expect(h.rechercherPourAgent({ requete: "eclair" }).map((r) => r.url).sort()).toEqual(["https://eclair.fr/", "https://patisserie.fr/1", "https://patisserie.fr/2"]);
});

test("rechercherPourAgent : une URL par résultat, faite des seules visites non privées", () => {
  visiter("https://a.fr/", "Titre A", "un texte sur les éclairs", { espaceId: "A", date: "2026-10-01T00:00:00Z" });
  h.noter({ url: "https://a.fr/", titre: "Titre A", espaceId: "A", prive: false, date: date("2026-10-03T00:00:00Z") });
  h.noter({ url: "https://a.fr/", titre: "Titre B", espaceId: "B", prive: false, date: date("2026-10-02T00:00:00Z") });
  h.noter({ url: "https://a.fr/", titre: "Secret", espaceId: "P", prive: true, date: date("2026-10-09T00:00:00Z") });
  h.noter({ url: "https://secret.fr/eclairs", titre: "Éclairs secrets", espaceId: "P", prive: true });
  expect(h.rechercherPourAgent({ requete: "éclairs" })).toEqual([
    { url: "https://a.fr/", titre: "Titre A", derniereVisite: "2026-10-03T00:00:00.000Z", visites: 3, extrait: "un texte sur les éclairs" },
  ]);
});

test("rechercherPourAgent ne rend jamais le texte d'une ligne privée", () => {
  visiter("https://a.fr/", "A", "mot de passe xyzzy", { espaceId: "P" });
  h.noter({ url: "https://a.fr/", titre: "A", espaceId: "P", prive: true }); // l'espace est devenu privé sans rendrePrive
  h.noter({ url: "https://a.fr/", titre: "A", espaceId: "B", prive: false });
  expect(h.rechercherPourAgent({ requete: "xyzzy" })).toEqual([]);
  expect(h.rechercherPourAgent({ requete: "a.fr" })).toMatchObject([{ url: "https://a.fr/", extrait: "", visites: 1 }]);
  expect(h.texteRetenu("https://a.fr/")).toBeNull();
});

test("rechercherPourAgent respecte depuis et jusqua", () => {
  for (const j of ["01", "05", "09"]) visiter(`https://${j}.fr/`, `page ${j}`, "commun", { date: `2026-10-${j}T00:00:00Z` });
  const r = h.rechercherPourAgent({ requete: "commun", depuis: date("2026-10-02T00:00:00Z"), jusqua: date("2026-10-06T00:00:00Z") });
  expect(r.map((x) => x.url)).toEqual(["https://05.fr/"]);
});

test("rechercherPourAgent rend 20 résultats par défaut et jamais plus de 50", () => {
  for (let i = 0; i < 60; i++) h.noter({ url: `https://a.fr/${i}`, titre: "page", espaceId: "A", prive: false });
  expect(h.rechercherPourAgent({ requete: "page" })).toHaveLength(20);
  expect(h.rechercherPourAgent({ requete: "page", limite: 500 })).toHaveLength(50);
});

test("rechercherPourAgent rend un extrait d'environ 300 caractères autour du mot trouvé", () => {
  const avant = "Lorem ipsum dolor sit amet. ".repeat(100);
  visiter("https://a.fr/", "A", `${avant} le mot introuvable est ici. ${avant}`);
  const [r] = h.rechercherPourAgent({ requete: "introuvable" });
  expect(r!.extrait).toContain("introuvable");
  expect(r!.extrait.length).toBeGreaterThan(200);
  expect(r!.extrait.length).toBeLessThan(400);
});

test("une visite sans texte se trouve par titre ou URL, avec un extrait vide", () => {
  h.noter({ url: "https://github.com/sveltejs/svelte", titre: "Svelte • Cybernétique", espaceId: "A", prive: false });
  expect(h.rechercherPourAgent({ requete: "CYBERNETIQUE" })).toMatchObject([{ url: "https://github.com/sveltejs/svelte", extrait: "" }]);
  expect(h.rechercherPourAgent({ requete: "LTEJS/SV" })).toMatchObject([{ titre: "Svelte • Cybernétique", extrait: "" }]);
});

test("classement : les textes trouvés par bm25 d'abord, puis les titres et URL seuls, du plus récent au plus ancien", () => {
  h.noter({ url: "https://titre-ancien.fr/", titre: "rust", espaceId: "A", prive: false, date: date("2026-10-01T00:00:00Z") });
  h.noter({ url: "https://titre-recent.fr/", titre: "rust", espaceId: "A", prive: false, date: date("2026-10-08T00:00:00Z") });
  visiter("https://peu.fr/", "Peu", `rust ${"autre chose ".repeat(200)}`, { date: "2026-10-09T00:00:00Z" });
  visiter("https://beaucoup.fr/", "Beaucoup", "rust rust rust rust", { date: "2026-10-02T00:00:00Z" });
  expect(h.rechercherPourAgent({ requete: "rust" }).map((r) => r.url)).toEqual(["https://beaucoup.fr/", "https://peu.fr/", "https://titre-recent.fr/", "https://titre-ancien.fr/"]);
});

test("une requête avec de la syntaxe FTS (guillemets, opérateurs) est cherchée telle quelle, sans erreur", () => {
  visiter("https://a.fr/", "A", "le NEAR de la tour");
  for (const q of ['"', "NEAR(", "a* OR", "titre:x", "-", "(((", 'é"é']) expect(() => h.rechercherPourAgent({ requete: q })).not.toThrow();
  expect(h.rechercherPourAgent({ requete: "NEAR" }).map((r) => r.url)).toEqual(["https://a.fr/"]);
});

test("une requête vide rend les visites non privées les plus récentes", () => {
  h.noter({ url: "https://a.fr/", titre: "A", espaceId: "A", prive: false, date: date("2026-10-01T00:00:00Z") });
  h.noter({ url: "https://b.fr/", titre: "B", espaceId: "A", prive: false, date: date("2026-10-02T00:00:00Z") });
  h.noter({ url: "https://p.fr/", titre: "P", espaceId: "P", prive: true, date: date("2026-10-03T00:00:00Z") });
  expect(h.rechercherPourAgent({ requete: "  " }).map((r) => r.url)).toEqual(["https://b.fr/", "https://a.fr/"]);
});

test("le texte retenu survit à la réouverture du fichier", () => {
  visiter("https://a.fr/", "A", "persistant");
  h.fermer();
  h = new Historique(chemin);
  expect(h.rechercherPourAgent({ requete: "persistant" }).map((r) => r.url)).toEqual(["https://a.fr/"]);
});

test("après fermer, les méthodes du texte retenu ne lèvent pas d'erreur", () => {
  h.fermer();
  expect(() => h.retenir({ url: "https://a.fr/", titre: "A", espaceId: "A", texte: "t" })).not.toThrow();
  expect(() => h.purger()).not.toThrow();
  expect(h.rechercherPourAgent({ requete: "t" })).toEqual([]);
  expect(h.texteRetenu("https://a.fr/")).toBeNull();
});
