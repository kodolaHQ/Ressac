// Interpréteur des workflows : tourne dans le conteneur `atelier`, appelé par recolteur.mjs.
//
// Contrat d'un module de bloc (`blocs/<type>.mjs`) :
//   export default {
//     parElement: "non" | "option" | "toujours",
//     async executer(ctx),             // mode simple : rend { sortie, memoire? }
//     async traiterElement(ctx),       // par élément : rend la valeur rangée sous `champ` dans ctx.element
//     async finaliser(liste, ctx),     // facultatif, par élément : rend { sortie } à partir de la liste enrichie
//   }
// ctx = { entree, parametres, config, memoire, webaios, journal, dossier, remplir, partiel, element? }
//   - `memoire` : ce que le bloc a retenu la fois d'avant (null sinon) ; `executer` rend la nouvelle dans `memoire`.
//     Par élément, la mémoire du bloc est celle de `reutiliser`, tenue par l'interpréteur.
//   - `journal(texte)` : une ligne rattachée au bloc. `webaios.journal(...)` va en plus sur stderr.
//   - `remplir(gabarit, { url, texteMax })` remplit avec l'élément en cours (en mode simple : l'entrée) et la config ;
//     une valeur absente lève ValeurAbsente : en mode simple la sortie est null, par élément l'élément reste sans
//     champ ; dans les deux cas, une ligne de journal et pas d'erreur.
//   - `partiel(raison?)` : en mode simple, le bloc finira « partiel » (par exemple un flux sur plusieurs en échec).
// La boucle par élément (deux à la fois, budget de temps, `siErreur`, `reutiliser`) est celle de l'interpréteur.
import { ValeurAbsente, lireChemin, remplir } from "./gabarits.mjs";
import { creerWebaios, formater } from "./webaios.mjs";
import code from "./blocs/code.mjs";
import listeDedoublonner from "./blocs/liste-dedoublonner.mjs";
import listeGarder from "./blocs/liste-garder.mjs";
import listeNouveaux from "./blocs/liste-nouveaux.mjs";
import sortie from "./blocs/sortie.mjs";

/** Les blocs livrés avec le moteur, par type. Aucun moyen d'en charger d'autres depuis le conteneur. */
export const BLOCS_LIVRES = Object.freeze({
  "liste.nouveaux": listeNouveaux,
  "liste.dedoublonner": listeDedoublonner,
  "liste.garder": listeGarder,
  code,
  sortie,
});

/** Passé ce temps depuis `debut`, plus aucun élément n'est lancé (le conteneur est arrêté à 180 s). */
export const LIMITE_GLOBALE_MS = 150_000;
const ELEMENTS_EN_PARALLELE = 2;
/** Valeurs gardées par `reutiliser`, par bloc (les plus anciennes oubliées au-delà). */
export const REUTILISES_MAX_OCTETS = 2 * 1024 * 1024;
/** Toute la mémoire envoyée au noyau (son fichier est refusé au-delà de 3 Mo, une ligne au-delà de 4 Mo). */
export const MEMOIRE_MAX_OCTETS = 2.5 * 1024 * 1024;
const LIGNE_MAX = 4 * 1024 * 1024;
const TEXTE_TRACE_MAX = 2000;

const message = (e) => String(e?.message ?? e);
const tronquer = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const estObjet = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Clé de `reutiliser` d'un élément ; null si absente. */
function cleReutilisee(element, chemin) {
  const v = lireChemin(element, chemin);
  if (v === undefined || v === null || v === "") return null;
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

const taille = (v) => Buffer.byteLength(JSON.stringify(v));

/** Valeurs gardées par `reutiliser`, de la plus ancienne à la plus récente, bornées à REUTILISES_MAX_OCTETS. */
function borner(reutilises) {
  const entrees = [...reutilises];
  const tailles = entrees.map((e) => taille(e) + 1);
  let total = tailles.reduce((a, b) => a + b, 0);
  let debut = 0;
  while (total > REUTILISES_MAX_OCTETS && debut < entrees.length) total -= tailles[debut++];
  return entrees.slice(debut);
}

/**
 * Borne toute la mémoire à MEMOIRE_MAX_OCTETS : oublie les plus anciennes valeurs de `reutiliser`, en commençant
 * toujours par le bloc qui en garde le plus, puis, s'il le faut encore, les plus anciennes clés de `liste.nouveaux`.
 */
function bornerMemoire(memoire) {
  let total = taille(memoire);
  const listes = (garder) =>
    Object.values(memoire)
      .map((m) => garder(m))
      .filter(Boolean)
      .map((liste) => {
        const tailles = liste.map((e) => taille(e) + 1);
        return { liste, tailles, total: tailles.reduce((a, b) => a + b, 0) };
      });
  const phases = [
    (m) => (Array.isArray(m.valeur?.reutilises) ? m.valeur.reutilises : null),
    (m) => (m.type === "liste.nouveaux" && Array.isArray(m.valeur) ? m.valeur : null),
  ];
  for (const garder of phases) {
    const blocs = listes(garder);
    while (total > MEMOIRE_MAX_OCTETS) {
      const plus = blocs.filter((b) => b.liste.length > 0).reduce((a, b) => (!a || b.total > a.total ? b : a), null);
      if (!plus) break;
      const t = plus.tailles.shift();
      plus.liste.shift();
      plus.total -= t;
      total -= t;
    }
  }
  return memoire;
}

function lireReutilises(memoire) {
  const entrees = Array.isArray(memoire?.reutilises) ? memoire.reutilises : [];
  return new Map(entrees.filter((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === "string"));
}

/** Boucle par élément : rend { statut, sortie, memoire? } ou lève l'erreur du bloc. */
async function parElement(module, ctx, { echeance, horloge }) {
  const { entree, parametres, journal } = ctx;
  if (!Array.isArray(entree)) throw new Error("liste attendue en entrée");
  const { champ, reutiliser, budgetSecondes } = parametres;
  const siErreur = parametres.siErreur ?? "sauter";
  const limite = Math.min(echeance, budgetSecondes ? horloge() + budgetSecondes * 1000 : Infinity);
  const reutilises = reutiliser ? lireReutilises(ctx.memoire) : null;
  const ranger = (cle, valeur) => {
    reutilises.delete(cle);
    reutilises.set(cle, valeur);
  };

  const resultat = entree.slice();
  let suivant = 0;
  let echecs = 0;
  let reussis = 0;
  let premiereErreur = null;
  let erreurBloc = null;

  async function traiter(i) {
    const element = entree[i];
    if (!estObjet(element)) throw new Error("l'élément n'est pas un objet");
    const cle = reutilises ? cleReutilisee(element, reutiliser) : null;
    if (cle !== null && reutilises.has(cle)) {
      const valeur = reutilises.get(cle);
      ranger(cle, valeur);
      resultat[i] = { ...element, [champ]: valeur };
      reussis++;
      return;
    }
    const valeur = await module.traiterElement({
      ...ctx,
      element,
      remplir: (gabarit, options) => remplirOuLever(gabarit, element, ctx.config, options),
    });
    if (valeur === undefined) throw new Error("aucune valeur rendue");
    resultat[i] = { ...element, [champ]: valeur };
    reussis++;
    if (cle !== null) ranger(cle, valeur);
  }

  async function ouvrier() {
    while (!erreurBloc && suivant < entree.length && horloge() < limite) {
      const i = suivant++;
      try {
        await traiter(i);
      } catch (e) {
        if (e instanceof ValeurAbsente) {
          journal(`élément ${i + 1} : ${e.message}`);
          continue;
        }
        echecs++;
        premiereErreur ??= e;
        journal(`élément ${i + 1} : ${message(e)}`);
        if (siErreur === "echouer") erreurBloc ??= e;
      }
    }
  }
  await Promise.all(Array.from({ length: ELEMENTS_EN_PARALLELE }, ouvrier));

  if (erreurBloc) throw erreurBloc;
  // Parmi les éléments lancés, aucun réussi et au moins un en échec : le bloc a échoué. Les éléments non lancés
  // (temps) ou sans valeur de gabarit ne comptent pas comme réussis.
  if (echecs > 0 && reussis === 0) {
    throw new Error(`Tous les éléments ont échoué (${message(premiereErreur)})`);
  }
  const nonLances = entree.length - suivant;
  if (nonLances > 0) journal(`temps écoulé : ${nonLances} élément(s) non lancé(s)`);
  const sortie = module.finaliser ? (await module.finaliser(resultat, ctx))?.sortie : resultat;
  return {
    statut: echecs > 0 || nonLances > 0 ? "partiel" : "reussi",
    sortie,
    ...(reutilises ? { memoire: { reutilises: borner(reutilises) } } : {}),
  };
}

function remplirOuLever(gabarit, element, config, options) {
  const r = remplir(gabarit, { element, config }, options);
  if ("absente" in r) throw new ValeurAbsente(r.absente);
  return r;
}

/**
 * Exécute un workflow validé par le noyau (`{ blocs, liens, ordre }`), bloc par bloc dans `ordre`. Envoie par
 * `tracer` le début et la fin de chaque bloc et ses lignes de journal. Rend les données (la sortie du bloc `sortie`)
 * et la mémoire des blocs du workflow ; lève l'erreur du premier bloc échoué (les suivants ne sont pas lancés).
 */
export async function executerWorkflow({
  workflow,
  config = null,
  memoire = {},
  maintenant,
  precedent = null,
  dossier,
  appeler,
  tracer,
  blocs = BLOCS_LIVRES,
  horloge = Date.now,
  echeance = horloge() + LIMITE_GLOBALE_MS,
  versErreur = (texte) => process.stderr.write(texte + "\n"),
}) {
  const parId = new Map(workflow.blocs.map((b) => [b.id, b]));
  const predecesseurs = new Map(workflow.blocs.map((b) => [b.id, []]));
  for (const { de, vers } of workflow.liens) {
    const p = predecesseurs.get(vers);
    if (p && !p.includes(de)) p.push(de);
  }
  const sorties = new Map();
  const nouvelleMemoire = new Map();
  let donnees = null;

  for (const id of workflow.ordre) {
    const bloc = parId.get(id);
    const preds = predecesseurs.get(id);
    const entree = preds.length === 0 ? null : preds.length === 1 ? sorties.get(preds[0]) : Object.fromEntries(preds.map((p) => [p, sorties.get(p)]));
    tracer({ t: "bloc", id, etape: "debut" });
    const journal = (texte) => tracer({ t: "journal", bloc: id, texte: tronquer(String(texte), TEXTE_TRACE_MAX) });
    let r;
    try {
      r = await executerBloc(bloc, entree, {
        blocs,
        config,
        dossier,
        echeance,
        horloge,
        journal,
        memoire: memoire[id]?.type === bloc.type ? memoire[id].valeur : null,
        webaios: creerWebaios({
          appeler,
          config,
          precedent,
          maintenant,
          journal: (...a) => {
            const texte = formater(...a);
            versErreur(texte);
            journal(texte);
          },
        }),
      });
    } catch (e) {
      tracer({ t: "bloc", id, etape: "fin", statut: "echoue", erreur: tronquer(message(e), TEXTE_TRACE_MAX) });
      throw e instanceof Error ? e : new Error(message(e));
    }
    sorties.set(id, r.sortie);
    if (r.memoire !== undefined) nouvelleMemoire.set(id, r.memoire);
    if (bloc.type === "sortie") donnees = r.sortie;
    const fin = { t: "bloc", id, etape: "fin", statut: r.statut, sortie: r.sortie };
    if (Buffer.byteLength(JSON.stringify(fin)) > LIGNE_MAX) {
      tracer({ t: "bloc", id, etape: "fin", statut: r.statut, sortieTropGrosse: true });
    } else tracer(fin);
  }

  // Seulement les blocs du workflow, avec leur type : la nouvelle valeur, sinon l'ancienne si le type n'a pas changé.
  const memoireFinale = {};
  for (const b of workflow.blocs) {
    if (nouvelleMemoire.has(b.id)) memoireFinale[b.id] = { type: b.type, valeur: nouvelleMemoire.get(b.id) };
    else if (memoire[b.id]?.type === b.type) memoireFinale[b.id] = memoire[b.id];
  }
  return { donnees, memoire: bornerMemoire(memoireFinale) };
}

/** Un bloc : rend { statut, sortie (JSON), memoire? } ou lève son erreur. */
async function executerBloc(bloc, entree, o) {
  const module = Object.hasOwn(o.blocs, bloc.type) ? o.blocs[bloc.type] : undefined;
  if (!module) throw new Error(`type inconnu dans le conteneur : ${bloc.type}`);
  const parametres = bloc.parametres ?? {};
  let partiel = false;
  const ctx = {
    entree,
    parametres,
    config: o.config,
    memoire: o.memoire,
    webaios: o.webaios,
    journal: o.journal,
    dossier: o.dossier,
    remplir: (gabarit, options) => remplirOuLever(gabarit, entree, o.config, options),
    partiel: (raison) => {
      partiel = true;
      if (raison) o.journal(raison);
    },
  };
  const elementParElement = module.parElement === "toujours" || (module.parElement === "option" && parametres.parElement === true);
  let r;
  if (elementParElement) r = await parElement(module, ctx, { echeance: o.echeance, horloge: o.horloge });
  else {
    try {
      const rendu = await module.executer(ctx);
      r = { statut: partiel ? "partiel" : "reussi", sortie: rendu?.sortie, ...(rendu?.memoire !== undefined ? { memoire: rendu.memoire } : {}) };
    } catch (e) {
      if (!(e instanceof ValeurAbsente)) throw e;
      o.journal(e.message);
      r = { statut: "reussi", sortie: null };
    }
  }
  // Ce qui circule entre les blocs est du JSON (copié : un bloc ne modifie pas la sortie d'un autre).
  let json;
  try {
    json = JSON.stringify(r.sortie);
  } catch {
    json = undefined;
  }
  if (json === undefined) throw new Error(`le bloc ${bloc.id} doit rendre du JSON`);
  return { ...r, sortie: JSON.parse(json) };
}
