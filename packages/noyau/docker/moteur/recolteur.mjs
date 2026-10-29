// Récolteur : tourne dans le conteneur `atelier` (sans réseau), JavaScript pur, sans dépendance.
// Canal unique avec le noyau : une ligne JSON par message sur stdin / stdout.
// Usage : node recolteur.mjs <dossier du widget>
//
// Le noyau envoie `debut` (avec son `workflow` : pour un widget qui n'a que `recolte.mjs`, le workflow implicite
// récolte → sortie), puis la ligne `memoire` ; le workflow est exécuté par l'interpréteur (traces `bloc` et
// `journal`, `memoire` juste avant `fin`).
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { LIMITE_GLOBALE_MS, executerWorkflow } from "./interpreteur.mjs";
import { formater } from "./webaios.mjs";

const LIGNE_MAX = 4 * 1024 * 1024;
const sortie = process.stdout;

// Tout ce que le widget affiche va sur stderr : stdout est réservé au protocole.
const versErreur = (...a) => process.stderr.write(formater(...a) + "\n");
console.log = console.info = console.debug = versErreur;

function envoyer(message) {
  const ligne = JSON.stringify(message);
  if (Buffer.byteLength(ligne) > LIGNE_MAX) throw new Error("message trop gros (4 Mo maximum)");
  sortie.write(ligne + "\n");
}

function terminer(message, code) {
  sortie.write(JSON.stringify(message) + "\n", () => process.exit(code));
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const enAttente = new Map();
let compteur = 0;
let debut;
let debutRecuA;
let signalerDebut;
const debutRecu = new Promise((ok) => (signalerDebut = ok));
let memoire;
let signalerMemoire;
const memoireRecue = new Promise((ok) => (signalerMemoire = ok));

rl.on("line", (ligne) => {
  if (!ligne.trim()) return;
  if (Buffer.byteLength(ligne) > LIGNE_MAX) {
    const n = /"n"\s*:\s*(\d+)/.exec(ligne.slice(0, 256));
    const attente = n && enAttente.get(Number(n[1]));
    if (attente) {
      enAttente.delete(Number(n[1]));
      attente.ko(new Error("Réponse trop grande (4 Mo maximum)"));
    } else {
      terminer({ t: "echec", erreur: "Réponse trop grande (4 Mo maximum)" }, 1);
    }
    return;
  }
  let m;
  try {
    m = JSON.parse(ligne);
  } catch {
    return;
  }
  if (m.t === "debut" && !debut) {
    debut = m;
    debutRecuA = Date.now();
    signalerDebut();
  } else if (m.t === "memoire" && debut && memoire === undefined) {
    memoire = m.memoire !== null && typeof m.memoire === "object" && !Array.isArray(m.memoire) ? m.memoire : {};
    signalerMemoire();
  } else if (m.t === "reponse" && enAttente.has(m.n)) {
    const { ok, ko } = enAttente.get(m.n);
    enAttente.delete(m.n);
    if (typeof m.erreur === "string") ko(new Error(m.erreur));
    else ok(m.ok);
  }
});
rl.on("close", () => {
  for (const { ko } of enAttente.values()) ko(new Error("le noyau a fermé le canal"));
  enAttente.clear();
});

function appeler(f, a) {
  const n = ++compteur;
  return new Promise((ok, ko) => {
    enAttente.set(n, { ok, ko });
    try {
      envoyer({ t: "appel", n, f, a });
    } catch (e) {
      enAttente.delete(n);
      ko(e);
    }
  });
}

async function principal() {
  const dossier = resolve(process.argv[2] ?? "/widget");
  await debutRecu;
  if (!debut.workflow) throw new Error("debut sans workflow");
  await memoireRecue;
  const r = await executerWorkflow({
    workflow: debut.workflow,
    config: debut.config ?? null,
    memoire,
    maintenant: debut.maintenant ?? new Date().toISOString(),
    precedent: debut.precedent ?? null,
    dossier,
    appeler,
    tracer: envoyer,
    echeance: debutRecuA + LIMITE_GLOBALE_MS,
    versErreur,
  });
  try {
    envoyer({ t: "memoire", memoire: r.memoire });
  } catch (e) {
    // Trop grosse pour une ligne : le noyau garde l'ancienne.
    versErreur(`mémoire non envoyée : ${e.message}`);
  }
  envoyer({ t: "fin", donnees: r.donnees });
  sortie.write("", () => process.exit(0));
}

principal().catch((e) => terminer({ t: "echec", erreur: String(e?.message ?? e) }, 1));
