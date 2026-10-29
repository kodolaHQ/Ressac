import { catalogueBlocs, validerWorkflow, workflowImplicite } from "@webaios/noyau";
import { expect, test } from "vitest";
import type { Brouillon, EditionWorkflow } from "../../src/commun/api";
import { MODELE_CODE, parametresNeufs, placeLibre } from "../../src/renderer/constructeur/ajout";
import { regler, relier } from "../../src/renderer/constructeur/brouillon";
import { creerEdition, Edition, EN_ATTENTE_DU_CHOIX, oublierEditions, type Depot } from "../../src/renderer/constructeur/edition.svelte";

const bloc = (id: string, type: string, parametres: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, parametres });
/** Workflow livré sans positions. */
const livre = (): Brouillon => ({
  version: 1,
  blocs: [bloc("garder", "code", { source: "a.mjs" }), bloc("tri", "ia.trier", { question: "?", texte: "{t}" }), bloc("sortie", "sortie", { vers: "widget" })],
  liens: [
    { de: "garder", vers: "tri" },
    { de: "tri", vers: "sortie" },
  ],
});
const catalogue = (type: string) => catalogueBlocs().find((c) => c.type === type)!;
const attendre = () => new Promise((r) => setTimeout(r, 0));

/** Faux dépôt : un `workflow.json` en mémoire, validé par le vrai validateur ; garde la trace des écritures. */
function faux(initial: unknown, fichiers: Record<string, string> = {}) {
  const etat = {
    disque: structuredClone(initial) as unknown,
    lisible: true,
    introuvable: false,
    fichiers: { ...fichiers },
    /** Erreur de lecture du code ; refus d'écrire le code ; enregistrements suspendus jusqu'à `liberer()`. */
    erreurCode: false as boolean | string[],
    refusCode: false,
    suspendu: false,
  };
  const enAttente: (() => void)[] = [];
  const ecritures: Brouillon[] = [];
  const lecture = (): EditionWorkflow | null => {
    if (etat.introuvable) return null;
    const brut = etat.lisible ? structuredClone(etat.disque) : null;
    const v = brut === null ? { ok: false as const, erreur: "Workflow invalide : JSON coupé" } : validerWorkflow(structuredClone(brut));
    return {
      origine: "fichier",
      brut,
      validation: v.ok ? { ok: true } : { ok: false, erreur: v.erreur, ...(v.bloc ? { bloc: v.bloc } : {}) },
      avertissements: [],
      widget: { nom: "Essai", compte: [], publiques: [], config: {} },
    };
  };
  const depot: Depot = {
    lire: async () => lecture(),
    enregistrer: async (_id, b) => {
      if (etat.suspendu) await new Promise<void>((ok) => enAttente.push(ok));
      const v = validerWorkflow(structuredClone(b));
      if (!v.ok) return { ok: false, erreur: v.erreur, ...(v.bloc ? { bloc: v.bloc } : {}), avertissements: [] };
      ecritures.push(structuredClone(b));
      etat.disque = structuredClone(b);
      return { ok: true, ecrit: true, memoireEffacee: [], avertissements: [] };
    },
    lireCode: async (_id, nom) => (etat.erreurCode === true || (Array.isArray(etat.erreurCode) && etat.erreurCode.includes(nom)) ? { erreur: "Fichier illisible" } : nom in etat.fichiers ? { texte: etat.fichiers[nom]! } : { absent: true }),
    enregistrerCode: async (_id, nom, texte) => {
      if (etat.refusCode) return { ok: false, erreur: "Écriture impossible" };
      etat.fichiers[nom] = texte;
      return { ok: true };
    },
  };
  const liberer = () => {
    etat.suspendu = false;
    for (const ok of enAttente.splice(0)) ok();
  };
  return { depot, etat, ecritures, liberer };
}

async function ouverte(f: ReturnType<typeof faux>): Promise<Edition> {
  const e = new Edition("essai", f.depot);
  await e.ouvrir();
  return e;
}

test("ouvrir un workflow livré sans positions le dispose en colonnes et n'écrit rien", async () => {
  const f = faux(livre());
  const e = await ouverte(f);
  expect(e.chargement).toBe("pret");
  expect(e.etatEnregistrement).toBe("enregistre");
  expect(e.positions).toEqual({ garder: { x: 0, y: 0 }, tri: { x: 260, y: 0 }, sortie: { x: 520, y: 0 } });
  e.reorganiser();
  await e.relire();
  await attendre();
  expect(f.ecritures).toEqual([]);
});

test("le premier déplacement enregistre la position affichée de tous les blocs ; un déplacement nul n'écrit rien", async () => {
  const f = faux(livre());
  const e = await ouverte(f);
  e.deplacer({ ...e.positions });
  await attendre();
  expect(f.ecritures).toEqual([]);
  e.deplacer({ ...e.positions, tri: { x: 300, y: 40 } });
  await attendre();
  expect(f.ecritures).toHaveLength(1);
  expect(Object.fromEntries(f.ecritures[0]!.blocs.map((b) => [b.id, b.position]))).toEqual({
    garder: { x: 0, y: 0 },
    tri: { x: 300, y: 40 },
    sortie: { x: 520, y: 0 },
  });
  expect(e.positions.sortie).toEqual({ x: 520, y: 0 });
});

test("un bloc neuf non relié est « non enregistré : entrée manquante » ; relié, il s'enregistre ; ⌘Z revient et réenregistre", async () => {
  const f = faux(livre());
  const e = await ouverte(f);
  const id = await e.ajouter(catalogue("liste.dedoublonner"), { x: 0, y: 300 });
  await attendre();
  expect(id).toBe("liste-dedoublonner");
  expect(e.etatEnregistrement).toMatchObject({ invalide: expect.stringContaining("entrée manquante"), bloc: id });
  expect(e.validation).toMatchObject({ ok: false, bloc: id });
  expect(f.ecritures).toEqual([]);
  e.modifier((b) => relier(b, "garder", id));
  await attendre();
  expect(e.etatEnregistrement).toBe("enregistre");
  expect(f.ecritures.at(-1)!.blocs.find((b) => b.id === id)!.parametres).toEqual({ cles: ["url"] });
  e.annuler();
  await attendre();
  expect(e.etatEnregistrement).toMatchObject({ invalide: expect.stringContaining("entrée manquante") });
  expect(f.ecritures).toHaveLength(1);
  e.annuler();
  await attendre();
  expect(e.etatEnregistrement).toBe("enregistre");
  expect(f.ecritures.at(-1)!.blocs.map((b) => b.id)).toEqual(["garder", "tri", "sortie"]);
  // Les positions affichées ne sautent pas en revenant au workflow sans disposition.
  expect(e.positions.tri).toEqual({ x: 260, y: 0 });
  e.retablir();
  expect(e.brouillon!.blocs.map((b) => b.id)).toContain(id);
});

test("un bloc code neuf reçoit son fichier modèle (jamais un fichier existant) avant d'être enregistré", async () => {
  const f = faux(livre(), { "code.mjs": "// de l'agent" });
  const e = await ouverte(f);
  const id = await e.ajouter(catalogue("code"), { x: 0, y: 300 });
  await attendre();
  expect(id).toBe("code");
  expect(f.etat.fichiers["code.mjs"]).toBe("// de l'agent");
  expect(f.etat.fichiers["code-2.mjs"]).toBe(MODELE_CODE);
  expect(f.ecritures.at(-1)!.blocs.find((b) => b.id === "code")!.parametres).toEqual({ source: "code-2.mjs" });
  expect(e.etatEnregistrement).toBe("enregistre");
});

test("relire : l'écho d'un enregistrement est ignoré ; une version de l'agent est adoptée sans rien écrire", async () => {
  const f = faux(livre());
  const e = await ouverte(f);
  e.deplacer({ ...e.positions, tri: { x: 300, y: 40 } });
  await e.relire();
  await attendre();
  expect(e.bandeau).toBeNull();
  const agent = structuredClone(f.etat.disque) as Brouillon;
  agent.blocs[0]!.parametres = { source: "b.mjs" };
  f.etat.disque = agent;
  await e.relire();
  expect(e.bandeau).toBeNull();
  expect(e.brouillon!.blocs[0]!.parametres).toEqual({ source: "b.mjs" });
  expect(f.ecritures).toHaveLength(1);
});

test("relire avec un brouillon invalide propose la version de l'agent ; prendre ou garder", async () => {
  const f = faux(livre());
  const e = await ouverte(f);
  await e.ajouter(catalogue("liste.garder"), { x: 0, y: 300 });
  await attendre();
  const agent = livre();
  agent.blocs[0]!.parametres = { source: "b.mjs" };
  f.etat.disque = agent;
  await e.relire();
  expect(e.bandeau).toBe("proposer");
  expect(e.brouillon!.blocs.map((b) => b.id)).toContain("liste-garder");
  e.garderLaMienne();
  expect(e.bandeau).toBeNull();
  await e.relire();
  expect(e.bandeau).toBeNull();
  agent.blocs[0]!.parametres = { source: "c.mjs" };
  f.etat.disque = structuredClone(agent);
  await e.relire();
  expect(e.bandeau).toBe("proposer");
  e.prendreVersionDisque();
  expect(e.bandeau).toBeNull();
  expect(e.brouillon!.blocs.map((b) => b.id)).toEqual(["garder", "tri", "sortie"]);
  expect(e.etatEnregistrement).toBe("enregistre");
  await attendre();
  expect(f.ecritures).toEqual([]);
});

test("relire : JSON coupé → bandeau « illisible » sans toucher au canevas ; widget introuvable un instant → canevas gardé", async () => {
  const f = faux(livre());
  const e = await ouverte(f);
  const avant = e.brouillon;
  f.etat.lisible = false;
  await e.relire();
  expect(e.bandeau).toBe("illisible");
  expect(e.brouillon).toBe(avant);
  f.etat.lisible = true;
  f.etat.introuvable = true;
  await e.relire();
  expect(e.brouillon).toBe(avant);
  expect(e.chargement).toBe("pret");
  f.etat.introuvable = false;
  await e.relire();
  expect(e.bandeau).toBeNull();
});

test("à la première ouverture : introuvable, ou illisible avec l'erreur", async () => {
  const absent = faux(livre());
  absent.etat.introuvable = true;
  expect((await ouverte(absent)).chargement).toBe("introuvable");
  const coupe = faux(livre());
  coupe.etat.lisible = false;
  expect((await ouverte(coupe)).chargement).toEqual({ illisible: "Workflow invalide : JSON coupé" });
});

test("le workflow implicite (Gmail) s'ouvre disposé, sans écriture", async () => {
  const f = faux(workflowImplicite());
  const e = await ouverte(f);
  expect(e.positions).toEqual({ recolte: { x: 0, y: 0 }, sortie: { x: 260, y: 0 } });
  e.deplacer({ ...e.positions });
  e.modifier((b) => relier(b, "sortie", "recolte"));
  await attendre();
  expect(f.ecritures).toEqual([]);
});

test("une édition par widget dans la fenêtre", () => {
  const { depot } = faux(livre());
  expect(creerEdition("w1", depot)).toBe(creerEdition("w1", depot));
  expect(creerEdition("w1", depot)).not.toBe(creerEdition("w2", depot));
});

test("paramètres neufs : valeurs neutres des champs requis, pas d'adresse inventée", () => {
  expect(parametresNeufs(catalogue("liste.garder"))).toEqual({ nombre: 10 });
  expect(parametresNeufs(catalogue("liste.nouveaux"))).toEqual({ cle: "url" });
  expect(parametresNeufs(catalogue("ia.trier"))).toEqual({ question: "Est-ce intéressant ?", texte: "{titre}" });
  expect(parametresNeufs(catalogue("source.page"))).toEqual({});
});

test("placeLibre décale sous les blocs affichés", () => {
  expect(placeLibre({ x: 10, y: 0 }, [])).toEqual({ x: 10, y: 0 });
  expect(placeLibre({ x: 10, y: 0 }, [{ x: 0, y: 0 }, { x: 0, y: 110 }])).toEqual({ x: 10, y: 220 });
});

// Fix round 1 (revue de la tâche 9)

/** Brouillon invalide (bloc non relié), puis l'agent change `garder` sur le disque : le bandeau propose sa version. */
async function avecBandeau() {
  const f = faux(livre());
  const e = await ouverte(f);
  const id = await e.ajouter(catalogue("liste.garder"), { x: 0, y: 300 });
  await attendre();
  const agent = livre();
  agent.blocs[0]!.parametres = { source: "b.mjs" };
  f.etat.disque = agent;
  await e.relire();
  expect(e.bandeau).toBe("proposer");
  return { f, e, id };
}

test("I1 : un geste pendant le bandeau n'écrit rien et le bandeau reste ; « Garder la mienne » envoie le brouillon", async () => {
  const { f, e, id } = await avecBandeau();
  e.modifier((b) => relier(b, "garder", id));
  await attendre();
  expect(f.ecritures).toEqual([]);
  expect(e.bandeau).toBe("proposer");
  expect(e.etatEnregistrement).toEqual({ invalide: EN_ATTENTE_DU_CHOIX });
  expect((f.etat.disque as Brouillon).blocs[0]!.parametres).toEqual({ source: "b.mjs" });
  e.garderLaMienne();
  await attendre();
  expect(e.bandeau).toBeNull();
  expect(f.ecritures).toHaveLength(1);
  expect(f.ecritures[0]!.liens).toContainEqual({ de: "garder", vers: id });
  expect(f.ecritures[0]!.blocs[0]!.parametres).toEqual({ source: "a.mjs" });
  expect(e.etatEnregistrement).toBe("enregistre");
});

test("I1 : un geste pendant le bandeau, puis « Prendre sa version » : le brouillon retenu est abandonné", async () => {
  const { f, e, id } = await avecBandeau();
  e.modifier((b) => relier(b, "garder", id));
  e.prendreVersionDisque();
  await attendre();
  expect(f.ecritures).toEqual([]);
  expect(e.bandeau).toBeNull();
  expect(e.brouillon!.blocs[0]!.parametres).toEqual({ source: "b.mjs" });
  expect(e.brouillon!.blocs.map((b) => b.id)).not.toContain(id);
  expect(e.etatEnregistrement).toBe("enregistre");
});

test("I2 : ⌘Z après le premier déplacement d'un workflow sans disposition remet le bloc à sa place", async () => {
  const f = faux(livre());
  const e = await ouverte(f);
  e.deplacer({ ...e.positions, tri: { x: 300, y: 40 } });
  await attendre();
  e.annuler();
  await attendre();
  expect(e.positions.tri).toEqual({ x: 260, y: 0 });
  expect((f.etat.disque as Brouillon).blocs.find((b) => b.id === "tri")!.position).toEqual({ x: 0, y: 0 });
  e.retablir();
  expect(e.positions.tri).toEqual({ x: 300, y: 40 });
});

test("M2 : relire pendant un enregistrement en vol ignore l'écho du brouillon envoyé", async () => {
  const f = faux(livre());
  const e = await ouverte(f);
  f.etat.suspendu = true;
  e.deplacer({ ...e.positions, tri: { x: 300, y: 40 } });
  await attendre();
  // Un second geste attend son tour pendant que le premier est en vol.
  e.deplacer({ ...e.positions, tri: { x: 320, y: 60 } });
  // Le disque porte déjà le premier brouillon (écrit, réponse pas encore reçue).
  const enVol = structuredClone(e.brouillon!);
  enVol.blocs.find((b) => b.id === "tri")!.position = { x: 300, y: 40 };
  f.etat.disque = enVol;
  await e.relire();
  expect(e.bandeau).toBeNull();
  expect(e.positions.tri).toEqual({ x: 320, y: 60 });
  f.liberer();
  await attendre();
  await attendre();
  expect(e.etatEnregistrement).toBe("enregistre");
});

test("M3 : l'édition d'un widget parti de l'accueil est oubliée ; un id réutilisé repart de zéro", () => {
  const { depot } = faux(livre());
  const a = creerEdition("parti", depot);
  const b = creerEdition("reste", depot);
  oublierEditions(["reste"]);
  expect(creerEdition("parti", depot)).not.toBe(a);
  expect(creerEdition("reste", depot)).toBe(b);
});

test("M4 : sans nom de fichier libre (lecture en erreur) ou sans écriture du modèle, le bloc Code n'est pas ajouté", async () => {
  const f = faux(livre());
  const e = await ouverte(f);
  f.etat.erreurCode = true;
  expect(await e.ajouter(catalogue("code"), { x: 0, y: 300 })).toBe("");
  expect(e.brouillon!.blocs.map((b) => b.id)).toEqual(["garder", "tri", "sortie"]);
  expect(e.etatEnregistrement).toEqual({ erreur: "aucun nom de fichier libre pour le bloc Code" });
  f.etat.erreurCode = false;
  f.etat.refusCode = true;
  expect(await e.ajouter(catalogue("code"), { x: 0, y: 300 })).toBe("");
  expect(e.brouillon!.blocs.map((b) => b.id)).toEqual(["garder", "tri", "sortie"]);
  expect(e.etatEnregistrement).toEqual({ erreur: "Écriture impossible" });
  await attendre();
  expect(f.ecritures).toEqual([]);
  expect(Object.keys(f.etat.fichiers)).toEqual([]);
});

// Fix round 2

test("N1 : un brouillon en file derrière un enregistrement en vol est retenu si le bandeau apparaît entre-temps", async () => {
  const f = faux(livre());
  const e = await ouverte(f);
  f.etat.suspendu = true;
  e.deplacer({ ...e.positions, tri: { x: 300, y: 40 } });
  await attendre();
  e.deplacer({ ...e.positions, tri: { x: 320, y: 60 } });
  const agent = livre();
  agent.blocs[0]!.parametres = { source: "b.mjs" };
  f.etat.disque = agent;
  await e.relire();
  expect(e.bandeau).toBe("proposer");
  f.liberer();
  await attendre();
  await attendre();
  // Seul le brouillon déjà en vol est parti ; celui en file attend le choix.
  expect(f.ecritures).toHaveLength(1);
  expect(f.ecritures[0]!.blocs.find((b) => b.id === "tri")!.position).toEqual({ x: 300, y: 40 });
  expect(e.bandeau).toBe("proposer");
  expect(e.etatEnregistrement).toEqual({ invalide: EN_ATTENTE_DU_CHOIX });
  // Prendre sa version abandonne aussi le brouillon en file.
  e.prendreVersionDisque();
  await attendre();
  expect(f.ecritures).toHaveLength(1);
  expect(e.brouillon!.blocs[0]!.parametres).toEqual({ source: "b.mjs" });
});

test("N2 : un enregistrement qui aboutit pendant le bandeau laisse l'en-tête sur l'attente du choix", async () => {
  const f = faux(livre());
  const e = await ouverte(f);
  f.etat.suspendu = true;
  e.deplacer({ ...e.positions, tri: { x: 300, y: 40 } });
  await attendre();
  const agent = livre();
  agent.blocs[0]!.parametres = { source: "b.mjs" };
  f.etat.disque = agent;
  await e.relire();
  expect(e.bandeau).toBe("proposer");
  f.liberer();
  await attendre();
  await attendre();
  expect(e.bandeau).toBe("proposer");
  expect(e.etatEnregistrement).toEqual({ invalide: EN_ATTENTE_DU_CHOIX });
});

test("N1 : une erreur de lecture sur le premier nom arrête la recherche (jamais un nom suivant au hasard)", async () => {
  const f = faux(livre());
  const e = await ouverte(f);
  f.etat.erreurCode = ["code.mjs"];
  expect(await e.ajouter(catalogue("code"), { x: 0, y: 300 })).toBe("");
  expect(e.brouillon!.blocs.map((b) => b.id)).toEqual(["garder", "tri", "sortie"]);
  expect(Object.keys(f.etat.fichiers)).toEqual([]);
});

test("N2 : « Prendre sa version » avant la fin d'un enregistrement en vol abandonne aussi le brouillon en file", async () => {
  const f = faux(livre());
  const e = await ouverte(f);
  f.etat.suspendu = true;
  e.deplacer({ ...e.positions, tri: { x: 300, y: 40 } });
  await attendre();
  e.deplacer({ ...e.positions, tri: { x: 320, y: 60 } });
  const agent = livre();
  agent.blocs[0]!.parametres = { source: "b.mjs" };
  f.etat.disque = agent;
  await e.relire();
  e.prendreVersionDisque();
  f.liberer();
  await attendre();
  await attendre();
  expect(f.ecritures).toHaveLength(1);
  expect(f.ecritures[0]!.blocs.find((b) => b.id === "tri")!.position).toEqual({ x: 300, y: 40 });
});

test("T10 : les frappes d'un même champ (même clé de fusion) font une seule entrée d'historique", async () => {
  const f = faux(livre());
  const e = await ouverte(f);
  const seuil = (s: number) => (b: Brouillon) => regler(b, "tri", { ...b.blocs.find((x) => x.id === "tri")!.parametres, seuil: s });
  e.modifier(seuil(0.6), "tri/seuil/1");
  await attendre();
  e.modifier(seuil(0.7), "tri/seuil/1");
  await attendre();
  expect(f.ecritures.at(-1)!.blocs.find((b) => b.id === "tri")!.parametres.seuil).toBe(0.7);
  // Une autre séance du même champ est une autre entrée.
  e.modifier(seuil(0.8), "tri/seuil/2");
  await attendre();
  e.annuler();
  expect(e.brouillon!.blocs.find((b) => b.id === "tri")!.parametres.seuil).toBe(0.7);
  e.annuler();
  expect(e.brouillon!.blocs.find((b) => b.id === "tri")!.parametres.seuil).toBeUndefined();
  // Après un annuler, la même clé ne fusionne plus avec l'état d'avant.
  e.modifier(seuil(0.9), "tri/seuil/2");
  e.annuler();
  expect(e.brouillon!.blocs.find((b) => b.id === "tri")!.parametres.seuil).toBeUndefined();
});
