// Interpréteur des workflows : tourne dans le conteneur `atelier`, appelé par recolteur.mjs.
//
// Contrat d'un module de bloc (`blocs/<type>.mjs`) :
//   export default {
//     parElement: "non" | "option" | "toujours",
//     async executer(ctx),             // mode simple : rend { sortie, memoire? }
//     async traiterElement(ctx),       // par élément : rend la valeur rangée sous `champ` dans ctx.element
//     async finaliser(liste, ctx),     // facultatif, par élément : rend { sortie } à partir de la liste enrichie
//     echecSiTousEchouent: true,       // facultatif, par élément : le bloc échoue si aucun élément lancé n'a réussi
//   }
// ctx = { entree, parametres, config, memoire, maintenant, webaios, journal, dossier, remplir, partiel, element? }
//   - `maintenant` : l'heure ISO de `debut`, la date de ce que le bloc retient cette fois.
//   - `memoire` : ce que le bloc a retenu la fois d'avant (null sinon) ; `executer` rend la nouvelle dans `memoire`.
//     Par élément, la mémoire du bloc est celle de `reutiliser`, tenue par l'interpréteur.
//   - `journal(texte)` : une ligne rattachée au bloc. `webaios.journal(...)` va en plus sur stderr.
//   - `remplir(gabarit, { url, texteMax })` remplit avec l'élément en cours (en mode simple : l'entrée) et la config ;
//     une valeur absente lève ValeurAbsente : en mode simple la sortie est null, par élément l'élément reste sans
//     champ ; dans les deux cas, une ligne de journal et pas d'erreur.
//   - par élément, un ElementNonLance (erreurs.mjs) laisse l'élément sans champ et le bloc « partiel », sans jamais
//     compter comme un échec ; en mode simple, c'est une erreur ordinaire. Après le premier, plus aucun élément n'est
//     lancé (sauf ceux que `reutiliser` reprend) : une ligne de journal pour le premier, une pour tous les suivants.
//   - `partiel(raison?)` : en mode simple, le bloc finira « partiel » (par exemple un flux sur plusieurs en échec).
// La boucle par élément (deux à la fois, budget de temps, `siErreur`, `reutiliser`) est celle de l'interpréteur.
import { ElementNonLance } from "./erreurs.mjs";
import { ValeurAbsente, lireChemin, remplir } from "./gabarits.mjs";
import { creerWebaios, formater } from "./webaios.mjs";
import code from "./blocs/code.mjs";
import iaRediger from "./blocs/ia-rediger.mjs";
import iaTrier from "./blocs/ia-trier.mjs";
import listeDedoublonner from "./blocs/liste-dedoublonner.mjs";
import listeGarder from "./blocs/liste-garder.mjs";
import listeNouveaux, { JOUR_MS, enCle } from "./blocs/liste-nouveaux.mjs";
import sortie from "./blocs/sortie.mjs";
import sourceFlux from "./blocs/source-flux.mjs";
import sourcePage from "./blocs/source-page.mjs";
import sourceRecuperer from "./blocs/source-recuperer.mjs";
import webChercher from "./blocs/web-chercher.mjs";

/** Les blocs livrés avec le moteur, par type. Aucun moyen d'en charger d'autres depuis le conteneur. */
export const BLOCS_LIVRES = Object.freeze({
  "source.page": sourcePage,
  "source.flux": sourceFlux,
  "source.recuperer": sourceRecuperer,
  "web.chercher": webChercher,
  "liste.nouveaux": listeNouveaux,
  "liste.dedoublonner": listeDedoublonner,
  "liste.garder": listeGarder,
  "ia.trier": iaTrier,
  "ia.rediger": iaRediger,
  code,
  sortie,
});

/** Passé ce temps depuis `debut`, plus aucun élément n'est lancé (le conteneur est arrêté à 180 s). */
export const LIMITE_GLOBALE_MS = 150_000;
/** Exécution progressive : la mémoire est envoyée au noyau au plus une fois par cet écart (recopié de src/workflows/executer.ts). */
export const ECART_MEMOIRE_MS = 30_000;

/**
 * Passé cette heure, plus aucun élément n'est lancé : `limiteMs` de la ligne `debut` (la durée déclarée du widget),
 * LIMITE_GLOBALE_MS sans elle, comptés depuis la réception de `debut`.
 */
export function echeanceDe(debut, recuA) {
  const limite = debut?.limiteMs;
  return recuA + (typeof limite === "number" && Number.isFinite(limite) && limite > 0 ? limite : LIMITE_GLOBALE_MS);
}
const ELEMENTS_EN_PARALLELE = 2;
/** Valeurs gardées par `reutiliser`, par bloc (les plus anciennes oubliées au-delà). */
export const REUTILISES_MAX_OCTETS = 2 * 1024 * 1024;
/**
 * Toute la mémoire envoyée au noyau, sous le plafond de son fichier (MEMOIRE_MAX_OCTETS, 3 Mo, dans
 * src/workflows/memoire.ts : au-delà, le noyau la refuse et garde l'ancienne) et d'une ligne (4 Mo).
 */
export const MEMOIRE_ENVOYEE_MAX_OCTETS = 2.5 * 1024 * 1024;
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

/**
 * Valeurs gardées par `reutiliser` (`[cle, valeur, dateIso]`), de la plus ancienne à la plus récente, bornées à
 * REUTILISES_MAX_OCTETS.
 */
function borner(reutilises) {
  const entrees = [...reutilises].map(([cle, { valeur, date }]) => [cle, valeur, date]);
  const tailles = entrees.map((e) => taille(e) + 1);
  let total = tailles.reduce((a, b) => a + b, 0);
  let debut = 0;
  while (total > REUTILISES_MAX_OCTETS && debut < entrees.length) total -= tailles[debut++];
  return entrees.slice(debut);
}

/**
 * Borne toute la mémoire à MEMOIRE_ENVOYEE_MAX_OCTETS : oublie les plus anciennes valeurs de `reutiliser`, en commençant
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
    while (total > MEMOIRE_ENVOYEE_MAX_OCTETS) {
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

/**
 * Valeurs de `reutiliser` lues de la mémoire : clé → { valeur, date }. Une ancienne paire `[cle, valeur]` (sans date) est
 * datée de `maintenant` ; avec `garderJours`, une valeur calculée il y a plus longtemps est oubliée (elle sera recalculée).
 */
function lireReutilises(memoire, maintenant, garderJours) {
  const entrees = Array.isArray(memoire?.reutilises) ? memoire.reutilises : [];
  const limite = garderJours === undefined ? -Infinity : Date.parse(maintenant) - garderJours * JOUR_MS;
  const reutilises = new Map();
  for (const e of entrees) {
    if (!Array.isArray(e) || (e.length !== 2 && e.length !== 3) || typeof e[0] !== "string") continue;
    const date = typeof e[2] === "string" && !Number.isNaN(Date.parse(e[2])) ? e[2] : maintenant;
    if (Date.parse(date) < limite) continue;
    reutilises.set(e[0], { valeur: e[1], date });
  }
  return reutilises;
}

/** Boucle par élément : rend { statut, sortie, memoire? } ou lève l'erreur du bloc. */
async function parElement(module, ctx, { echeance, horloge, apresElement, exposerMemoire }) {
  const { entree, parametres, journal } = ctx;
  if (!Array.isArray(entree)) throw new Error("liste attendue en entrée");
  const { champ, reutiliser, budgetSecondes } = parametres;
  const siErreur = parametres.siErreur ?? "sauter";
  const limite = Math.min(echeance, budgetSecondes ? horloge() + budgetSecondes * 1000 : Infinity);
  const reutilises = reutiliser ? lireReutilises(ctx.memoire, ctx.maintenant, parametres.garderJours) : null;
  // Exécution progressive : ce que le bloc a déjà appris fait partie de la mémoire envoyée en cours de route.
  if (reutilises && exposerMemoire) exposerMemoire(() => ({ reutilises: borner(reutilises) }));
  // Une valeur reprise garde la date de son calcul (sa fiabilité est revue après garderJours) mais devient la plus
  // récente pour les plafonds de taille.
  const ranger = (cle, entree) => {
    reutilises.delete(cle);
    reutilises.set(cle, entree);
  };
  // Calculs en cours par clé de `reutiliser` : un élément de même clé attend celui-là plutôt que d'en lancer un second.
  const enCours = new Map();

  // Un élément sans valeur cette fois (échec, non lancé, valeur absente) sort sans `champ`, même s'il en avait un :
  // une ancienne valeur ne passe jamais pour celle de ce bloc (ia.trier ne trie pas sur une ancienne note).
  const sansChamp = (element) => {
    if (!estObjet(element) || !Object.hasOwn(element, champ)) return element;
    const { [champ]: _ancienne, ...reste } = element;
    return reste;
  };
  const resultat = entree.map(sansChamp);
  let suivant = 0;
  let echecs = 0;
  let reussis = 0;
  let refuses = 0;
  // Premier refus du noyau (plafond, recherches arrêtées) : il vaut pour toute l'exécution, plus rien n'est lancé.
  let refusNoyau = null;
  let premiereErreur = null;
  let erreurBloc = null;
  // Indices des éléments en échec ou refusés par le noyau (les non lancés faute de temps sont ajoutés à la fin).
  const enEchec = new Set();

  async function traiter(i) {
    const element = entree[i];
    if (!estObjet(element)) throw new Error("l'élément n'est pas un objet");
    const cle = reutilises ? cleReutilisee(element, reutiliser) : null;
    if (cle !== null && reutilises.has(cle)) {
      const reprise = reutilises.get(cle);
      ranger(cle, reprise);
      resultat[i] = { ...element, [champ]: reprise.valeur };
      reussis++;
      return;
    }
    if (cle !== null && enCours.has(cle)) {
      // Le même calcul est en cours pour un autre élément : sa valeur, ou, s'il échoue, un calcul à soi.
      try {
        const valeur = await enCours.get(cle);
        resultat[i] = { ...element, [champ]: valeur };
        reussis++;
        return;
      } catch (e) {
        // Refusé par le noyau : celui-ci le serait aussi, inutile de redemander.
        if (e instanceof ElementNonLance) throw e;
        // Son erreur est comptée chez lui ; celui-ci tente à son tour.
      }
    }
    if (refusNoyau !== null) throw new ElementNonLance(refusNoyau);
    const calcul = (async () => {
      const valeur = await module.traiterElement({
        ...ctx,
        element,
        remplir: (gabarit, options) => remplirOuLever(gabarit, element, ctx.config, options),
      });
      if (valeur === undefined) throw new Error("aucune valeur rendue");
      return valeur;
    })();
    if (cle !== null) enCours.set(cle, calcul);
    let valeur;
    try {
      valeur = await calcul;
    } finally {
      if (cle !== null && enCours.get(cle) === calcul) enCours.delete(cle);
    }
    resultat[i] = { ...element, [champ]: valeur };
    reussis++;
    if (cle !== null) ranger(cle, { valeur, date: ctx.maintenant });
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
        if (e instanceof ElementNonLance) {
          // Refusé par le noyau (plafond de recherches…) : non lancé, jamais un échec. Une ligne pour le premier, les
          // suivants sont comptés ensemble à la fin.
          refuses++;
          enEchec.add(i);
          if (refusNoyau === null) {
            refusNoyau = e.message;
            journal(`élément ${i + 1} : ${e.message}`);
          }
          continue;
        }
        echecs++;
        enEchec.add(i);
        premiereErreur ??= e;
        journal(`élément ${i + 1} : ${message(e)}`);
        if (siErreur === "echouer") erreurBloc ??= e;
      } finally {
        apresElement?.();
      }
    }
  }
  await Promise.all(Array.from({ length: ELEMENTS_EN_PARALLELE }, ouvrier));

  if (erreurBloc) throw erreurBloc;
  // Pour un bloc qui le demande (ia.trier : sans aucune note, sa sortie vide ne veut rien dire), parmi les éléments
  // lancés, aucun réussi et au moins un en échec : le bloc a échoué. Les éléments non lancés (temps, refusés par le
  // noyau) ou sans valeur de gabarit ne comptent pas comme réussis. Les autres blocs (qui enrichissent) laissent passer
  // les éléments sans leur champ et finissent « partiel ».
  if (module.echecSiTousEchouent === true && echecs > 0 && reussis === 0) {
    throw new Error(`Tous les éléments ont échoué (${message(premiereErreur)})`);
  }
  if (refuses > 1) journal(`${refuses - 1} autre(s) élément(s) non lancé(s)`);
  const nonLances = entree.length - suivant;
  if (nonLances > 0) journal(`temps écoulé : ${nonLances} élément(s) non lancé(s)`);
  for (let i = suivant; i < entree.length; i++) enEchec.add(i);
  const sortie = module.finaliser ? (await module.finaliser(resultat, ctx))?.sortie : resultat;
  return {
    statut: echecs > 0 || nonLances > 0 || refuses > 0 ? "partiel" : "reussi",
    sortie,
    ...(reutilises ? { memoire: { reutilises: borner(reutilises) } } : {}),
    enEchec,
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
 *
 * Avec `rejeu` (`{ relances, sorties }`, un essai du constructeur) : seuls les blocs de `relances` sont lancés et
 * tracés ; la sortie d'un autre bloc est celle de `rejeu.sorties` (reprise de l'exécution d'origine). Un essai ne lit
 * ni ne rend aucune mémoire : `liste.nouveaux` laisse tout passer, `reutiliser` ne reprend rien, la mémoire rendue est
 * vide. Les données sont la sortie du bloc `sortie` s'il est relancé, null sinon.
 *
 * Avec `progressif` (une vraie exécution longue ou au fil de l'eau ; jamais un essai) :
 *   - la mémoire telle qu'elle serait rendue maintenant (`instantaneMemoire`) est envoyée par `tracer` en ligne
 *     `memoire` au plus toutes les ECART_MEMOIRE_MS (vérifié à la fin de chaque élément et de chaque bloc), et avant
 *     de relever l'erreur d'un bloc : ce qui a été appris n'est pas perdu si l'exécution ne finit pas ;
 *   - les nouvelles clés d'un `liste.nouveaux` restent « en suspens » et ne sont retenues que résolues : l'élément a
 *     disparu entre l'entrée et la sortie d'un bloc en aval sans y être en échec (écarté par un tri, `garder`, un
 *     doublon, un bloc `code`), ou le bloc `sortie` a tourné. Un élément en échec ou non lancé (temps, budget, refus
 *     du noyau) dans un bloc par élément en aval garde sa clé hors de la mémoire : il reviendra la fois suivante.
 * Sans `progressif`, rien de cela : toutes les nouvelles clés sont retenues et la mémoire n'est rendue qu'à la fin.
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
  rejeu = null,
  progressif = false,
}) {
  const relances = rejeu ? new Set(Array.isArray(rejeu.relances) ? rejeu.relances : []) : null;
  const reprises = rejeu && estObjet(rejeu.sorties) ? rejeu.sorties : {};
  if (rejeu) memoire = {};
  const enProgression = progressif === true && !rejeu;
  const parId = new Map(workflow.blocs.map((b) => [b.id, b]));
  const predecesseurs = new Map(workflow.blocs.map((b) => [b.id, []]));
  for (const { de, vers } of workflow.liens) {
    const p = predecesseurs.get(vers);
    if (p && !p.includes(de)) p.push(de);
  }
  const sorties = new Map();
  const nouvelleMemoire = new Map();
  // Bloc par élément en cours : ce qu'il a déjà appris (progressif).
  const memoireEnCours = new Map();
  // Par bloc `liste.nouveaux` (progressif) : sa mémoire rendue, ses nouvelles clés en suspens, celles en échec.
  const suivis = new Map();
  const instant = maintenant ?? new Date().toISOString();
  let donnees = null;
  let derniereMemoire = horloge();

  /** La mémoire telle qu'elle serait rendue maintenant : blocs du workflow, avec leur type, bornée. */
  function instantaneMemoire() {
    const m = {};
    for (const b of workflow.blocs) {
      let valeur;
      const suivi = suivis.get(b.id);
      if (suivi) valeur = suivi.memoire.filter((e) => !suivi.enSuspens.has(e[0]));
      else if (nouvelleMemoire.has(b.id)) valeur = nouvelleMemoire.get(b.id);
      else if (memoireEnCours.has(b.id)) valeur = memoireEnCours.get(b.id)();
      else if (memoire[b.id]?.type === b.type) valeur = memoire[b.id].valeur;
      else continue;
      m[b.id] = { type: b.type, valeur: copieBornable(valeur) };
    }
    return bornerMemoire(m);
  }

  function envoyerMemoire() {
    derniereMemoire = horloge();
    try {
      tracer({ t: "memoire", memoire: instantaneMemoire() });
    } catch (e) {
      // Trop grosse pour une ligne : le noyau garde la précédente.
      versErreur(`mémoire non envoyée : ${message(e)}`);
    }
  }

  const verifierMemoire = () => {
    if (horloge() - derniereMemoire >= ECART_MEMOIRE_MS) envoyerMemoire();
  };

  /** Après un bloc réussi : clés en échec chez lui, clés des éléments qu'il a écartés résolues ; toutes après `sortie`. */
  function suivreCles(bloc, entree, r) {
    for (const suivi of suivis.values()) {
      if (suivi.enSuspens.size === 0) continue;
      if (suivi.aval.has(bloc.id)) {
        const cleDe = (element) => (estObjet(element) ? enCle(lireChemin(element, suivi.chemin)) : null);
        if (Array.isArray(entree) && r.enEchec) {
          for (const i of r.enEchec) {
            const cle = cleDe(entree[i]);
            if (cle !== null && suivi.enSuspens.has(cle)) suivi.enEchec.add(cle);
          }
        }
        const restees = new Set(elementsDe(r.sortie).map(cleDe));
        for (const element of elementsDe(entree)) {
          const cle = cleDe(element);
          if (cle !== null && !restees.has(cle) && !suivi.enEchec.has(cle)) suivi.enSuspens.delete(cle);
        }
      }
      if (bloc.type === "sortie") {
        for (const cle of [...suivi.enSuspens]) if (!suivi.enEchec.has(cle)) suivi.enSuspens.delete(cle);
      }
    }
  }

  for (const id of workflow.ordre) {
    if (relances && !relances.has(id)) {
      // Ni lancé ni tracé : sa sortie, s'il en faut une, est celle de l'exécution d'origine.
      if (Object.hasOwn(reprises, id)) sorties.set(id, reprises[id]);
      continue;
    }
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
        maintenant: instant,
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
        ...(enProgression ? { apresElement: verifierMemoire, exposerMemoire: (lire) => memoireEnCours.set(id, lire) } : {}),
      });
    } catch (e) {
      tracer({ t: "bloc", id, etape: "fin", statut: "echoue", erreur: tronquer(message(e), TEXTE_TRACE_MAX) });
      if (enProgression) envoyerMemoire();
      throw e instanceof Error ? e : new Error(message(e));
    }
    memoireEnCours.delete(id);
    sorties.set(id, r.sortie);
    if (r.memoire !== undefined) nouvelleMemoire.set(id, r.memoire);
    if (enProgression) {
      suivreCles(bloc, entree, r);
      if (bloc.type === "liste.nouveaux" && Array.isArray(r.memoire) && Array.isArray(r.nouvelles)) {
        suivis.set(id, {
          chemin: bloc.parametres?.cle,
          memoire: r.memoire,
          enSuspens: new Set(r.nouvelles),
          enEchec: new Set(),
          aval: descendants(workflow, id),
        });
      }
    }
    if (bloc.type === "sortie") donnees = r.sortie;
    const fin = { t: "bloc", id, etape: "fin", statut: r.statut, sortie: r.sortie };
    if (Buffer.byteLength(JSON.stringify(fin)) > LIGNE_MAX) {
      tracer({ t: "bloc", id, etape: "fin", statut: r.statut, sortieTropGrosse: true });
    } else tracer(fin);
    if (enProgression) verifierMemoire();
  }

  if (rejeu) return { donnees, memoire: {} };
  // Seulement les blocs du workflow, avec leur type : la nouvelle valeur, sinon l'ancienne si le type n'a pas changé.
  return { donnees, memoire: instantaneMemoire() };
}

/** Les éléments d'une entrée ou d'une sortie : la liste, ou ceux des listes d'une entrée à plusieurs blocs. */
function elementsDe(valeur) {
  if (Array.isArray(valeur)) return valeur;
  if (estObjet(valeur)) return Object.values(valeur).filter(Array.isArray).flat();
  return [];
}

/** Les blocs atteints depuis `id` par les liens. */
function descendants(workflow, id) {
  const vus = new Set();
  const aVoir = [id];
  while (aVoir.length) {
    const courant = aVoir.pop();
    for (const { de, vers } of workflow.liens) {
      if (de === courant && !vus.has(vers)) {
        vus.add(vers);
        aVoir.push(vers);
      }
    }
  }
  return vus;
}

/** Copie des listes que bornerMemoire raccourcit sur place (la mémoire en cours sert encore après un envoi). */
function copieBornable(valeur) {
  if (Array.isArray(valeur)) return [...valeur];
  if (estObjet(valeur) && Array.isArray(valeur.reutilises)) return { ...valeur, reutilises: [...valeur.reutilises] };
  return valeur;
}

/** Un bloc : rend { statut, sortie (JSON), memoire?, enEchec?, nouvelles? } ou lève son erreur. */
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
    maintenant: o.maintenant,
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
  if (elementParElement) {
    r = await parElement(module, ctx, {
      echeance: o.echeance,
      horloge: o.horloge,
      apresElement: o.apresElement,
      exposerMemoire: o.exposerMemoire,
    });
  }
  else {
    try {
      const rendu = await module.executer(ctx);
      r = {
        statut: partiel ? "partiel" : "reussi",
        sortie: rendu?.sortie,
        ...(rendu?.memoire !== undefined ? { memoire: rendu.memoire } : {}),
        // liste.nouveaux : les clés nouvelles de cette fois (en suspens d'une exécution progressive).
        ...(Array.isArray(rendu?.nouvelles) ? { nouvelles: rendu.nouvelles } : {}),
      };
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
