// Workflow interpreter: runs in the `atelier` container, called by recolteur.mjs.
//
// Contract of a block module (`blocs/<type>.mjs`):
//   export default {
//     parElement: "non" | "option" | "toujours",
//     async executer(ctx),             // simple mode: returns { sortie, memoire? }
//     async traiterElement(ctx),       // per item: returns the value stored under `champ` in ctx.element
//     async finaliser(liste, ctx),     // optional, per item: returns { sortie } from the enriched list
//     echecSiTousEchouent: true,       // optional, per item: the block fails if no item that was run succeeded
//   }
// ctx = { entree, parametres, config, memoire, maintenant, webaios, journal, dossier, remplir, partiel, element?, saisie? }
//   - `saisie` (action run with a text only): that text; also `webaios.saisie` for the agent's code, and
//     `{saisie}` in the templates.
//   - `maintenant`: the ISO time of `debut`, the date of what the block keeps this time.
//   - `memoire`: what the block kept last time (null otherwise); `executer` returns the new one in `memoire`.
//     Per item, the block's memory is that of `reutiliser`, held by the interpreter.
//   - `journal(texte)`: a line attached to the block. `webaios.journal(...)` also goes to stderr.
//   - `remplir(gabarit, { url, texteMax })` fills in with the current item (in simple mode: the input) and the config;
//     an absent value throws ValeurAbsente: in simple mode the output is null, per item the item stays without a
//     field; in both cases, a log line and no error.
//   - per item, an ElementNonLance (erreurs.mjs) leaves the item without a field and the block "partiel", never
//     counting as a failure; in simple mode, it is an ordinary error. After the first one, no item is
//     run any more (except those `reutiliser` takes back): one log line for the first, one for all the following.
//   - `partiel(raison?)`: in simple mode, the block will end "partiel" (for example one feed out of several failing).
// The per-item loop (two at a time, time budget, `siErreur`, `reutiliser`) is the interpreter's.
// In the as-it-goes chain, `ctx.entree` is the chain's input (not the output of the previous block): a chainable
// module does not read it in `traiterElement`.
import { ElementNonLance } from "./erreurs.mjs";
import { ValeurAbsente, lireChemin, remplir } from "./gabarits.mjs";
import { creerWebaios, formater } from "./webaios.mjs";
import code from "./blocs/code.mjs";
import iaRediger from "./blocs/ia-rediger.mjs";
import iaTrier from "./blocs/ia-trier.mjs";
import listeDedoublonner from "./blocs/liste-dedoublonner.mjs";
import listeGarder from "./blocs/liste-garder.mjs";
import listeNouveaux, { CLES_MAX, JOUR_MS, enCle } from "./blocs/liste-nouveaux.mjs";
import sortie from "./blocs/sortie.mjs";
import sourceFlux from "./blocs/source-flux.mjs";
import sourcePage from "./blocs/source-page.mjs";
import sourceRecuperer from "./blocs/source-recuperer.mjs";
import webChercher from "./blocs/web-chercher.mjs";

/** The blocks shipped with the engine, by type. No way to load others from the container. */
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

/** After this time since `debut`, no item is run any more (the container is stopped at 180 s). */
export const LIMITE_GLOBALE_MS = 150_000;
/** Progressive run: the memory is sent to the kernel at most once per this interval (copied from src/workflows/executer.ts). */
export const ECART_MEMOIRE_MS = 30_000;
/** As it goes: at most one `publication` line per this interval (copied from src/workflows/executer.ts). */
export const ECART_PUBLICATIONS_MS = 5000;
/** Action: at most one `avancement` line per block per this interval, the last one always (copied from src/workflows/executer.ts). */
export const ECART_AVANCEMENT_MS = 1000;
/**
 * As it goes: a larger publication (in JSON) is not sent, the kernel would ignore it (copied from
 * TAILLE_MAX_DONNEES, src/workflows/protocole.ts).
 */
export const TAILLE_MAX_DONNEES = 2 * 1024 * 1024;

/**
 * After this time, no item is run any more: `limiteMs` of the `debut` line (the widget's declared duration),
 * LIMITE_GLOBALE_MS without it, counted from the reception of `debut`.
 */
export function echeanceDe(debut, recuA) {
  const limite = debut?.limiteMs;
  return recuA + (typeof limite === "number" && Number.isFinite(limite) && limite > 0 ? limite : LIMITE_GLOBALE_MS);
}
const ELEMENTS_EN_PARALLELE = 2;
/** Values kept by `reutiliser`, per block (the oldest forgotten beyond). */
export const REUTILISES_MAX_OCTETS = 2 * 1024 * 1024;
/**
 * All the memory sent to the kernel, under the cap of its file (MEMOIRE_MAX_OCTETS, 3 MB, in
 * src/workflows/memoire.ts: beyond it, the kernel refuses it and keeps the old one) and of a line (4 MB).
 */
export const MEMOIRE_ENVOYEE_MAX_OCTETS = 2.5 * 1024 * 1024;
const LIGNE_MAX = 4 * 1024 * 1024;
const TEXTE_TRACE_MAX = 2000;

const message = (e) => String(e?.message ?? e);
const tronquer = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const estObjet = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** `reutiliser` key of an item; null if absent. */
function cleReutilisee(element, chemin) {
  const v = lireChemin(element, chemin);
  if (v === undefined || v === null || v === "") return null;
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

const taille = (v) => Buffer.byteLength(JSON.stringify(v));

/**
 * Values kept by `reutiliser` (`[cle, valeur, dateIso]`), from oldest to most recent, bounded to
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
 * Bounds all the memory to MEMOIRE_ENVOYEE_MAX_OCTETS: forgets the oldest `reutiliser` values, always starting
 * with the block that keeps the most, then, if still needed, the oldest keys of `liste.nouveaux`.
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
 * `reutiliser` values read from the memory: key → { valeur, date }. An old `[cle, valeur]` pair (no date) is
 * dated `maintenant`; with `garderJours`, a value computed longer ago is forgotten (it will be recomputed).
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

/**
 * One block per item, item by item: its rules (`reutiliser`, absent value, ElementNonLance, `siErreur`) and
 * its counts. Used by the loop of a single block (`parElement`) and by the as-it-goes chain (`executerChaine`).
 *   - `passer(i, element)`: the item after the block (without `champ` if it has no value this time); an error with
 *     `siErreur: "echouer"` is stored in `erreurBloc`, never thrown;
 *   - `nonLance(i, element)`: the item passes the block without being run in it (time, budget);
 *   - `terminer()`: the final log lines and the status.
 */
function creerEtape(module, ctx, exposerMemoire) {
  const { parametres, journal } = ctx;
  const { champ, reutiliser } = parametres;
  const siErreur = parametres.siErreur ?? "sauter";
  const reutilises = reutiliser ? lireReutilises(ctx.memoire, ctx.maintenant, parametres.garderJours) : null;
  // Progressive run: what the block has already learned is part of the memory sent along the way.
  if (reutilises && exposerMemoire) exposerMemoire(() => ({ reutilises: borner(reutilises) }));
  // A reused value keeps the date of its computation (its reliability is reviewed after garderJours) but becomes the most
  // recent for the size caps.
  const ranger = (cle, entree) => {
    reutilises.delete(cle);
    reutilises.set(cle, entree);
  };
  // Computations in progress by `reutiliser` key: an item with the same key waits for that one rather than launching a second.
  const enCours = new Map();

  const etape = {
    echecs: 0,
    reussis: 0,
    refuses: 0,
    nonLances: 0,
    // First refusal from the kernel (cap, searches stopped): it holds for the whole run, nothing is run any more.
    refusNoyau: null,
    premiereErreur: null,
    erreurBloc: null,
    // Indexes of the items that failed, were refused by the kernel or were not run.
    enEchec: new Set(),
    reutilises,
    // An item without a value this time (failure, not run, absent value) leaves without `champ`, even if it had one:
    // an old value never passes for this block's (ia.trier does not sort on an old score).
    sansChamp(element) {
      if (!estObjet(element) || !Object.hasOwn(element, champ)) return element;
      const { [champ]: _ancienne, ...reste } = element;
      return reste;
    },
    async passer(i, element) {
      try {
        return await traiter(element);
      } catch (e) {
        if (e instanceof ValeurAbsente) {
          journal(`élément ${i + 1} : ${e.message}`);
          return etape.sansChamp(element);
        }
        if (e instanceof ElementNonLance) {
          // Refused by the kernel (search cap…): not run, never a failure. One line for the first, the
          // following ones are counted together at the end.
          etape.refuses++;
          etape.enEchec.add(i);
          if (etape.refusNoyau === null) {
            etape.refusNoyau = e.message;
            journal(`élément ${i + 1} : ${e.message}`);
          }
          return etape.sansChamp(element);
        }
        etape.echecs++;
        etape.enEchec.add(i);
        etape.premiereErreur ??= e;
        journal(`élément ${i + 1} : ${message(e)}`);
        if (siErreur === "echouer") etape.erreurBloc ??= e;
        return etape.sansChamp(element);
      }
    },
    nonLance(i, element) {
      etape.nonLances++;
      etape.enEchec.add(i);
      return etape.sansChamp(element);
    },
    terminer() {
      if (etape.refuses > 1) journal(`${etape.refuses - 1} autre(s) élément(s) non lancé(s)`);
      if (etape.nonLances > 0) journal(`temps écoulé : ${etape.nonLances} élément(s) non lancé(s)`);
      return etape.echecs > 0 || etape.nonLances > 0 || etape.refuses > 0 ? "partiel" : "reussi";
    },
  };

  async function traiter(element) {
    if (!estObjet(element)) throw new Error("l'élément n'est pas un objet");
    const cle = reutilises ? cleReutilisee(element, reutiliser) : null;
    if (cle !== null && reutilises.has(cle)) {
      const reprise = reutilises.get(cle);
      ranger(cle, reprise);
      etape.reussis++;
      return { ...element, [champ]: reprise.valeur };
    }
    if (cle !== null && enCours.has(cle)) {
      // The same computation is in progress for another item: its value, or, if it fails, a computation of its own.
      try {
        const valeur = await enCours.get(cle);
        etape.reussis++;
        return { ...element, [champ]: valeur };
      } catch (e) {
        // Refused by the kernel: this one would be too, no point asking again.
        if (e instanceof ElementNonLance) throw e;
        // Its error is counted on its side; this one tries in its turn.
      }
    }
    if (etape.refusNoyau !== null) throw new ElementNonLance(etape.refusNoyau);
    const calcul = (async () => {
      const valeur = await module.traiterElement({
        ...ctx,
        element,
        remplir: (gabarit, options) => remplirOuLever(gabarit, element, ctx, options),
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
    etape.reussis++;
    if (cle !== null) ranger(cle, { valeur, date: ctx.maintenant });
    return { ...element, [champ]: valeur };
  }

  return etape;
}

/** Deadline of a per-item block: the global deadline, advanced by `budgetSecondes` counted from `depuis`. */
const limiteDe = (parametres, echeance, depuis) =>
  Math.min(echeance, parametres.budgetSecondes ? depuis + parametres.budgetSecondes * 1000 : Infinity);

/**
 * The progress of a per-item block (action): `envoyer(faits, total)` after an item at most every
 * ECART_AVANCEMENT_MS, and always for the last one (`faits = total`); `terminer()` sends the final count if it has not
 * gone yet (items not run, block stopped by an error).
 */
function creerAvancement(total, horloge, envoyer) {
  let faits = 0;
  let envoyes = 0;
  let dernier = null;
  const envoi = () => {
    dernier = horloge();
    envoyes = faits;
    envoyer(faits, total);
  };
  return {
    element() {
      faits++;
      if (faits === total || dernier === null || horloge() - dernier >= ECART_AVANCEMENT_MS) envoi();
    },
    terminer() {
      if (faits !== envoyes) envoi();
    },
  };
}

/** Per-item loop: returns { statut, sortie, memoire?, enEchec } or throws the block's error. */
async function parElement(module, ctx, { echeance, horloge, apresElement, exposerMemoire, surAvancement }) {
  const { entree } = ctx;
  if (!Array.isArray(entree)) throw new Error("liste attendue en entrée");
  const limite = limiteDe(ctx.parametres, echeance, horloge());
  const etape = creerEtape(module, ctx, exposerMemoire);
  const resultat = entree.map(etape.sansChamp);
  const avancement = surAvancement ? creerAvancement(entree.length, horloge, surAvancement) : null;
  let suivant = 0;

  async function ouvrier() {
    while (!etape.erreurBloc && suivant < entree.length && horloge() < limite) {
      const i = suivant++;
      try {
        resultat[i] = await etape.passer(i, entree[i]);
      } finally {
        avancement?.element();
        apresElement?.();
      }
    }
  }
  await Promise.all(Array.from({ length: ELEMENTS_EN_PARALLELE }, ouvrier));
  avancement?.terminer();

  if (etape.erreurBloc) throw etape.erreurBloc;
  // For a block that asks for it (ia.trier: with no score at all, its empty output means nothing), among the items
  // run, none succeeded and at least one failed: the block failed. Items not run (time, refused by the
  // kernel) or without a template value do not count as succeeded. The other blocks (which enrich) let
  // the items through without their field and end "partiel".
  if (module.echecSiTousEchouent === true && etape.echecs > 0 && etape.reussis === 0) {
    throw new Error(`Tous les éléments ont échoué (${message(etape.premiereErreur)})`);
  }
  for (let i = suivant; i < entree.length; i++) etape.nonLance(i, entree[i]);
  const statut = etape.terminer();
  const sortie = module.finaliser ? (await module.finaliser(resultat, ctx))?.sortie : resultat;
  return {
    statut,
    sortie,
    ...(etape.reutilises ? { memoire: { reutilises: borner(etape.reutilises) } } : {}),
    enEchec: etape.enEchec,
  };
}

/** `ctx`: the config and, for an action, the input. */
function remplirOuLever(gabarit, element, { config, saisie }, options) {
  const r = remplir(gabarit, { element, config, saisie }, options);
  if ("absente" in r) throw new ValeurAbsente(r.absente);
  return r;
}

/**
 * Runs a workflow validated by the kernel (`{ blocs, liens, ordre }`), block by block in `ordre`. Sends through
 * `tracer` the start and end of each block and its log lines. Returns the data (the output of the `sortie` block)
 * and the memory of the workflow's blocks; throws the error of the first failed block (the following ones are not run).
 *
 * With `rejeu` (`{ relances, sorties }`, a builder try): only the blocks of `relances` are run and
 * traced; the output of another block is that of `rejeu.sorties` (taken from the original run). A try reads
 * and returns no memory: `liste.nouveaux` lets everything through, `reutiliser` takes nothing back, the returned memory is
 * empty. The data is the output of the `sortie` block if it is rerun, null otherwise.
 *
 * With `progressif` (a real long run or as-it-goes run; never a try):
 *   - the memory as it would be returned now (`instantaneMemoire`) is sent through `tracer` as a `memoire`
 *     line at most every ECART_MEMOIRE_MS (checked at the end of each item and each block), and before
 *     raising a block's error: what was learned is not lost if the run does not finish;
 *   - the new keys of a `liste.nouveaux` stay "pending" and are only kept once resolved: the item
 *     disappeared between the input and the output of a downstream block without failing in it (discarded by a sort, `garder`, a
 *     duplicate, a `code` block), or the `sortie` block ran. An item that failed or was not run (time, budget, kernel
 *     refusal) in a downstream per-item block keeps its key out of the memory: it will come back next time;
 *   - if the output publishes as it goes (`chaineDe` not empty), the chain's blocks run item by item
 *     (`executerChaine`): each finished item resolves its key there, and `memoire` then `publication` lines
 *     show the finished items at most every ECART_PUBLICATIONS_MS.
 * Without `progressif`, none of this: all the new keys are kept and the memory is only returned at the end.
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
  // Action only: the text typed at launch, and the progress of per-item blocks.
  saisie = undefined,
  avancement = false,
}) {
  if (typeof saisie !== "string") saisie = undefined;
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
  // Per-item block in progress: what it has already learned (progressive).
  const memoireEnCours = new Map();
  // Per `liste.nouveaux` block (progressive): its returned memory, its pending new keys, those that failed.
  const suivis = new Map();
  const instant = maintenant ?? new Date().toISOString();
  let donnees = null;
  let derniereMemoire = horloge();

  /** The memory as it would be returned now: the workflow's blocks, with their type, bounded. */
  function instantaneMemoire() {
    const m = {};
    for (const b of workflow.blocs) {
      let valeur;
      const suivi = suivis.get(b.id);
      // Pending keys removed before the cap: they do not take the place of old keys.
      if (suivi) valeur = suivi.memoire.filter((e) => !suivi.enSuspens.has(e[0])).slice(-CLES_MAX);
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
      // Too big for a line: the kernel keeps the previous one.
      versErreur(`mémoire non envoyée : ${message(e)}`);
    }
  }

  const verifierMemoire = () => {
    if (horloge() - derniereMemoire >= ECART_MEMOIRE_MS) envoyerMemoire();
  };

  /**
   * After a successful block, for each tracked `liste.nouveaux` it is downstream of: the keys of its items that failed or
   * were not run become failed (for the whole run, whatever the branch, even if another branch had
   * resolved them); the keys of the items it discarded are resolved. After `sortie`, all those that remain not failed.
   * If a block makes the items lose the key's field (a `code` that reshapes them), it resolves nothing by
   * disappearance; if an item without a key then fails, we no longer know which: the tracking becomes "blind", nothing
   * more is resolved in this run and the keys not yet resolved will come back next time.
   */
  /**
   * An item that failed or was not run downstream of a tracked `liste.nouveaux`: its key (new this time) becomes
   * failed and goes back to pending. Without a key while the field was lost along the way: we no longer know which, the tracking
   * becomes blind.
   */
  function noterEchec(suivi, cle) {
    if (cle === null) {
      if (suivi.clePerdue && !suivi.aveugle) {
        suivi.aveugle = true;
        tracer({
          t: "journal",
          bloc: suivi.id,
          texte: `le champ ${suivi.chemin} n'est plus dans les éléments : un élément en échec n'a pas pu être reconnu, les éléments pas encore résolus reviendront la fois suivante`,
        });
      }
    } else if (suivi.nouvelles.has(cle)) {
      suivi.enEchec.add(cle);
      suivi.enSuspens.add(cle);
    }
  }

  const cleSuivie = (suivi, element) => (estObjet(element) ? enCle(lireChemin(element, suivi.chemin)) : null);

  function suivreCles(bloc, entree, r) {
    for (const suivi of suivis.values()) {
      if (suivi.aval.has(bloc.id)) {
        const cleDe = (element) => cleSuivie(suivi, element);
        const entrees = elementsDe(entree);
        const restees = elementsDe(r.sortie);
        const sansCle = (liste) => liste.filter((e) => cleDe(e) === null).length;
        const perteIci = sansCle(restees) > sansCle(entrees);
        if (perteIci) suivi.clePerdue = true;
        if (Array.isArray(entree) && r.enEchec) {
          for (const i of r.enEchec) noterEchec(suivi, cleDe(entree[i]));
        }
        if (!suivi.aveugle && !perteIci) {
          const clesRestees = new Set(restees.map(cleDe));
          for (const element of entrees) {
            const cle = cleDe(element);
            if (cle !== null && !clesRestees.has(cle) && !suivi.enEchec.has(cle)) suivi.enSuspens.delete(cle);
          }
        }
      }
      if (bloc.type === "sortie" && !suivi.aveugle) {
        for (const cle of [...suivi.enSuspens]) if (!suivi.enEchec.has(cle)) suivi.enSuspens.delete(cle);
      }
    }
  }

  const journalDe = (id) => (texte) => tracer({ t: "journal", bloc: id, texte: tronquer(String(texte), TEXTE_TRACE_MAX) });
  /** What a block receives, besides the input: config, memory, clock, log, `webaios`. */
  const optionsBloc = (id, bloc, journal) => ({
    blocs,
    config,
    saisie,
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
      saisie,
      journal: (...a) => {
        const texte = formater(...a);
        versErreur(texte);
        journal(texte);
      },
    }),
  });

  /** The `fin` trace of a successful or partial block, without the output if it does not fit on a line. */
  function tracerFin(id, statut, sortie) {
    const fin = { t: "bloc", id, etape: "fin", statut, sortie };
    if (Buffer.byteLength(JSON.stringify(fin)) > LIGNE_MAX) {
      tracer({ t: "bloc", id, etape: "fin", statut, sortieTropGrosse: true });
    } else tracer(fin);
  }

  // As it goes: only for a progressive run (never a try).
  const chaine = enProgression ? chaineDe(workflow, blocs) : [];
  const dansLaChaine = new Set(chaine);

  /**
   * The as-it-goes chain: each item of the input goes through all its blocks before being finished, two items
   * at a time, with per block the rules of a per-item block (`creerEtape`). A block's deadline is the start of the
   * chain plus its `budgetSecondes`, bounded by the global deadline; an item that reaches a block after it
   * passes it without its field (not run for this block) and continues. No more items enter the chain after
   * the global deadline.
   *
   * At each finished item: if it failed or was not run in a block, its key becomes failed; otherwise it
   * waits. If ECART_PUBLICATIONS_MS has passed since the last publication (or there has been none yet), the waiting keys
   * are resolved, the `memoire` line goes, then `publication`: a published item is never reprocessed next
   * time, even if the container stops right after, and an item not yet shown is never kept.
   *
   * Traces: `debut` of all the chain's blocks at once, at the start, and their `fin` at the end. The duration kept for
   * each block of the chain is thus that of the whole chain, not the time spent in that block.
   */
  async function executerChaine(entree) {
    const debutChaine = horloge();
    for (const id of chaine) tracer({ t: "bloc", id, etape: "debut" });
    const etapes = chaine.map((id) => {
      const bloc = parId.get(id);
      const journal = journalDe(id);
      const { module, parametres, ctx } = contexteBloc(bloc, entree, optionsBloc(id, bloc, journal));
      return {
        id,
        bloc,
        etape: creerEtape(module, ctx, (lire) => memoireEnCours.set(id, lire)),
        limite: limiteDe(parametres, echeance, debutChaine),
      };
    });

    /** Block `b` fails with `e`, the others in the chain end "partiel"; the memory goes before the error. */
    const echouer = (b, e) => {
      chaine.forEach((id, k) =>
        tracer(
          k === b
            ? { t: "bloc", id, etape: "fin", statut: "echoue", erreur: tronquer(message(e), TEXTE_TRACE_MAX) }
            : { t: "bloc", id, etape: "fin", statut: "partiel" },
        ),
      );
      envoyerMemoire();
      throw e instanceof Error ? e : new Error(message(e));
    };

    if (!Array.isArray(entree)) echouer(0, new Error("liste attendue en entrée"));
    const n = entree.length;
    // The list as after each block.
    const apres = chaine.map(() => new Array(n));
    const termines = new Array(n).fill(false);
    let faits = 0;
    let suivant = 0;
    let erreur = null;
    let dernierePublication = null;
    const suivisAmont = [...suivis.values()].filter((s) => s.aval.has(chaine[0]));

    /** Item `i` through all the blocks; false if it is abandoned (the run fails). */
    async function parcourir(i) {
      let element = entree[i];
      for (let b = 0; b < etapes.length; b++) {
        if (erreur) return false;
        const { id, etape, limite } = etapes[b];
        if (horloge() >= limite) element = etape.nonLance(i, element);
        else {
          element = await etape.passer(i, element);
          if (etape.erreurBloc) {
            erreur ??= { b, e: etape.erreurBloc };
            return false;
          }
        }
        // What circulates between blocks is JSON, copied: a block does not modify what another returned.
        const copie = copieJson(element);
        if (copie === undefined) {
          erreur ??= { b, e: new Error(`le bloc ${id} doit rendre du JSON`) };
          return false;
        }
        apres[b][i] = copie;
        element = structuredClone(copie);
      }
      return true;
    }

    // Items finished without failure whose key waits to be shown: it is only kept at the publication that
    // shows them (or, at the normal end of the chain, by `sortie`). On a run failure or a stop, an item finished
    // but not yet published was never displayed: it stays pending and comes back next time.
    const aResoudre = [];
    let publicationTropGrosseSignalee = false;

    /** Item `i` finished: failed in a block, its key becomes failed right away; otherwise it waits for its publication. */
    function terminerElement(i) {
      if (!etapes.some(({ etape }) => etape.enEchec.has(i))) {
        aResoudre.push(i);
        return;
      }
      for (const suivi of suivisAmont) noterEchec(suivi, cleSuivie(suivi, entree[i]));
    }

    /** The keys of the items the publication will show are resolved, then the memory goes, then the publication. */
    function publier() {
      dernierePublication = horloge();
      const donnees = apres[apres.length - 1].filter((_, i) => termines[i]);
      // Too big for the kernel: nothing is sent or resolved, its items stay waiting (the output will show them).
      if (taille(donnees) > TAILLE_MAX_DONNEES) {
        if (!publicationTropGrosseSignalee) versErreur("publication non envoyée : plus de 2 Mo, les éléments seront montrés à la fin");
        publicationTropGrosseSignalee = true;
        verifierMemoire();
        return;
      }
      for (const i of aResoudre.splice(0)) {
        for (const suivi of suivisAmont) {
          const cle = cleSuivie(suivi, entree[i]);
          if (!suivi.aveugle && cle !== null && !suivi.enEchec.has(cle)) suivi.enSuspens.delete(cle);
        }
      }
      envoyerMemoire();
      try {
        tracer({ t: "publication", donnees, faits, total: n });
      } catch (e) {
        // Too big for a line: the next one, or the output, will replace it.
        versErreur(`publication non envoyée : ${message(e)}`);
      }
    }

    async function ouvrier() {
      while (!erreur && suivant < n && horloge() < echeance) {
        const i = suivant++;
        if (await parcourir(i)) {
          termines[i] = true;
          faits++;
          terminerElement(i);
          if (dernierePublication === null || horloge() - dernierePublication >= ECART_PUBLICATIONS_MS) {
            publier();
            continue;
          }
        }
        verifierMemoire();
      }
    }
    await Promise.all(Array.from({ length: ELEMENTS_EN_PARALLELE }, ouvrier));
    if (erreur) echouer(erreur.b, erreur.e);

    // No more items enter after the global deadline: those pass all the blocks without being run in them.
    for (let i = suivant; i < n; i++) {
      let element = entree[i];
      etapes.forEach(({ etape }, b) => (element = apres[b][i] = etape.nonLance(i, element)));
    }
    etapes.forEach(({ id, bloc, etape }, b) => {
      const statut = etape.terminer();
      memoireEnCours.delete(id);
      if (etape.reutilises) nouvelleMemoire.set(id, { reutilises: borner(etape.reutilises) });
      sorties.set(id, apres[b]);
      suivreCles(bloc, b === 0 ? entree : apres[b - 1], { sortie: apres[b], enEchec: etape.enEchec });
      tracerFin(id, statut, apres[b]);
    });
    verifierMemoire();
  }

  for (const id of workflow.ordre) {
    if (relances && !relances.has(id)) {
      // Neither run nor traced: its output, if one is needed, is that of the original run.
      if (Object.hasOwn(reprises, id)) sorties.set(id, reprises[id]);
      continue;
    }
    const bloc = parId.get(id);
    const preds = predecesseurs.get(id);
    const entree = preds.length === 0 ? null : preds.length === 1 ? sorties.get(preds[0]) : Object.fromEntries(preds.map((p) => [p, sorties.get(p)]));
    if (dansLaChaine.has(id)) {
      // The whole chain at once, at its first block (a contiguous slice of the order).
      if (id === chaine[0]) await executerChaine(entree);
      continue;
    }
    tracer({ t: "bloc", id, etape: "debut" });
    const journal = journalDe(id);
    let r;
    try {
      r = await executerBloc(bloc, entree, {
        ...optionsBloc(id, bloc, journal),
        ...(enProgression ? { apresElement: verifierMemoire, exposerMemoire: (lire) => memoireEnCours.set(id, lire) } : {}),
        ...(avancement === true ? { surAvancement: (faits, total) => tracer({ t: "bloc", id, etape: "avancement", faits, total }) } : {}),
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
      if (bloc.type === "liste.nouveaux" && Array.isArray(r.memoireEntiere) && Array.isArray(r.nouvelles)) {
        suivis.set(id, {
          id,
          chemin: bloc.parametres?.cle,
          memoire: r.memoireEntiere,
          nouvelles: new Set(r.nouvelles),
          enSuspens: new Set(r.nouvelles),
          enEchec: new Set(),
          aval: descendants(workflow, id),
          clePerdue: false,
          aveugle: false,
        });
      }
    }
    if (bloc.type === "sortie") donnees = r.sortie;
    tracerFin(id, r.statut, r.sortie);
    if (enProgression) verifierMemoire();
  }

  if (rejeu) return { donnees, memoire: {} };
  // Only the workflow's blocks, with their type: the new value, otherwise the old one if the type has not changed.
  return { donnees, memoire: instantaneMemoire() };
}

/** The items of an input or an output: the list, or those of the lists of a multi-block input. */
function elementsDe(valeur) {
  if (Array.isArray(valeur)) return valeur;
  if (estObjet(valeur)) return Object.values(valeur).filter(Array.isArray).flat();
  return [];
}

/** The blocks reached from `id` through the links. */
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

/** A block that each item can go through alone: per item optional, without `finaliser` or `echecSiTousEchouent`. */
function chainable(bloc, blocs) {
  const module = Object.hasOwn(blocs, bloc.type) ? blocs[bloc.type] : undefined;
  return (
    module?.parElement === "option" &&
    !module.finaliser &&
    module.echecSiTousEchouent !== true &&
    bloc.parametres?.parElement === true
  );
}

/**
 * The "as it goes" chain, a copy of `chaineAuFilDeLEau` (src/workflows/chaine.ts; a test checks that they
 * agree): the blocks each item goes through alone up to the output, in run order. Empty if the
 * output does not publish as it goes or does not have exactly one predecessor. Going up from the output's predecessor,
 * a block is taken as long as it is chainable and has only one successor (the block taken just before, or the
 * output); we go up through its only predecessor, and stop after it if it has several. Finally, blocks are removed
 * at the start as long as the rest is not a contiguous slice of the order. A try has no chain: it is up to the
 * caller to judge (executerWorkflow only looks for it for a progressive run).
 */
export function chaineDe(workflow, blocs) {
  const parId = new Map(workflow.blocs.map((b) => [b.id, b]));
  const sortieBloc = workflow.blocs.find((b) => b.type === "sortie");
  if (sortieBloc?.parametres?.auFilDeLEau !== true) return [];
  const predecesseurs = new Map(workflow.blocs.map((b) => [b.id, []]));
  const successeurs = new Map(workflow.blocs.map((b) => [b.id, []]));
  for (const { de, vers } of workflow.liens) {
    if (predecesseurs.has(vers) && !predecesseurs.get(vers).includes(de)) predecesseurs.get(vers).push(de);
    if (successeurs.has(de) && !successeurs.get(de).includes(vers)) successeurs.get(de).push(vers);
  }
  const amont = predecesseurs.get(sortieBloc.id);
  if (amont.length !== 1) return [];

  const chaine = [];
  let suivant = sortieBloc.id;
  let courant = amont[0];
  while (courant !== undefined) {
    const b = parId.get(courant);
    if (!b || !chainable(b, blocs)) break;
    const apres = successeurs.get(courant);
    if (apres.length !== 1 || apres[0] !== suivant) break;
    chaine.unshift(courant);
    const avant = predecesseurs.get(courant);
    if (avant.length !== 1) break;
    suivant = courant;
    courant = avant[0];
  }

  while (chaine.length > 0) {
    const debut = workflow.ordre.indexOf(chaine[0]);
    if (chaine.every((id, i) => workflow.ordre[debut + i] === id)) break;
    chaine.shift();
  }
  return chaine;
}

/** Copy of the lists that bornerMemoire shortens in place (the memory in progress is still used after a send). */
function copieBornable(valeur) {
  if (Array.isArray(valeur)) return [...valeur];
  if (estObjet(valeur) && Array.isArray(valeur.reutilises)) return { ...valeur, reutilises: [...valeur.reutilises] };
  return valeur;
}

/** A block's module and the `ctx` it receives (see the contract at the top of the file). */
function contexteBloc(bloc, entree, o) {
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
    ...(o.saisie !== undefined ? { saisie: o.saisie } : {}),
    remplir: (gabarit, options) => remplirOuLever(gabarit, entree, o, options),
    partiel: (raison) => {
      partiel = true;
      if (raison) o.journal(raison);
    },
  };
  return { module, parametres, ctx, estPartiel: () => partiel };
}

/** A value passed through JSON (what circulates between blocks); undefined if it is not one. */
function copieJson(valeur) {
  let json;
  try {
    json = JSON.stringify(valeur);
  } catch {
    return undefined;
  }
  return json === undefined ? undefined : JSON.parse(json);
}

/** A block: returns { statut, sortie (JSON), memoire?, enEchec?, nouvelles?, memoireEntiere? } or throws its error. */
async function executerBloc(bloc, entree, o) {
  const { module, parametres, ctx, estPartiel } = contexteBloc(bloc, entree, o);
  const elementParElement = module.parElement === "toujours" || (module.parElement === "option" && parametres.parElement === true);
  let r;
  if (elementParElement) {
    r = await parElement(module, ctx, {
      echeance: o.echeance,
      horloge: o.horloge,
      apresElement: o.apresElement,
      exposerMemoire: o.exposerMemoire,
      surAvancement: o.surAvancement,
    });
  }
  else {
    try {
      const rendu = await module.executer(ctx);
      r = {
        statut: estPartiel() ? "partiel" : "reussi",
        sortie: rendu?.sortie,
        ...(rendu?.memoire !== undefined ? { memoire: rendu.memoire } : {}),
        // liste.nouveaux: the new keys of this time (pending from a progressive run).
        ...(Array.isArray(rendu?.nouvelles) ? { nouvelles: rendu.nouvelles } : {}),
        ...(Array.isArray(rendu?.memoireEntiere) ? { memoireEntiere: rendu.memoireEntiere } : {}),
      };
    } catch (e) {
      if (!(e instanceof ValeurAbsente)) throw e;
      o.journal(e.message);
      r = { statut: "reussi", sortie: null };
    }
  }
  // What circulates between blocks is JSON (copied: a block does not modify another's output).
  const sortie = copieJson(r.sortie);
  if (sortie === undefined) throw new Error(`le bloc ${bloc.id} doit rendre du JSON`);
  return { ...r, sortie };
}
