// Récolteur : tourne dans le conteneur `atelier` (sans réseau), JavaScript pur, sans dépendance.
// Canal unique avec le noyau : une ligne JSON par message sur stdin / stdout.
// Usage : node recolteur.mjs <dossier du widget>
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const LIGNE_MAX = 4 * 1024 * 1024;
const sortie = process.stdout;

// Tout ce que le widget affiche va sur stderr : stdout est réservé au protocole.
const versErreur = (...a) => process.stderr.write(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n");
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
let signalerDebut;
const debutRecu = new Promise((ok) => (signalerDebut = ok));

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
    signalerDebut();
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

// --- lireFlux : RSS 2.0 et Atom par expressions régulières ---
const ENTITES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", eacute: "é", egrave: "è", agrave: "à", ecirc: "ê", ccedil: "ç", rsquo: "’", lsquo: "‘", hellip: "…", ndash: "–", mdash: "—" };
function decoderEntites(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (tout, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return tout; }
    }
    return ENTITES[e.toLowerCase()] ?? tout;
  });
}
function texteBalise(bloc, nom) {
  const m = new RegExp(`<${nom}(?:\\s[^>]*)?>([\\s\\S]*?)</${nom}>`, "i").exec(bloc);
  if (!m) return "";
  const interne = m[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(interne);
  return (cdata ? cdata[1] : decoderEntites(interne)).trim();
}
function lienBloc(bloc) {
  const liens = [...bloc.matchAll(/<link\b([^>]*?)\/?>/gi)];
  for (const [, attrs] of liens) {
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(attrs);
    const rel = /rel\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (href && (!rel || rel[1] === "alternate")) return decoderEntites(href[1]);
  }
  return texteBalise(bloc, "link");
}
export function analyserFlux(xml) {
  const blocs = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]);
  return blocs.map((b) => ({
    titre: texteBalise(b, "title"),
    url: lienBloc(b),
    date: texteBalise(b, "pubDate") || texteBalise(b, "updated") || texteBalise(b, "published") || texteBalise(b, "dc:date"),
    resume: texteBalise(b, "description") || texteBalise(b, "summary") || texteBalise(b, "content"),
  }));
}

async function trier(elements, { question, texte, seuil = 0.5, parallele = 8 } = {}) {
  const liste = [...elements];
  const notes = new Array(liste.length);
  let suivant = 0;
  async function ouvrier() {
    while (suivant < liste.length) {
      const i = suivant++;
      const r = await appeler("kev", { state: String(texte(liste[i])), questions: { q: { type: "noul", instructions: question } } });
      const p = Number(r?.q?.noul);
      notes[i] = Number.isFinite(p) ? p : 0;
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallele, liste.length)) }, ouvrier));
  return liste
    .map((element, i) => ({ element, p: notes[i] }))
    .filter((x) => x.p >= seuil)
    .sort((a, b) => b.p - a.p);
}

async function principal() {
  const dossier = resolve(process.argv[2] ?? "/widget");
  let config = null;
  try {
    config = JSON.parse(await readFile(join(dossier, "widget.json"), "utf8")).config ?? null;
  } catch {}
  await debutRecu;
  const webaios = {
    config,
    precedent: debut.precedent ?? null,
    maintenant: debut.maintenant ?? new Date().toISOString(),
    lirePage: (url, options = {}) => appeler("lirePage", { url, compte: options.compte }),
    recuperer: (url, options = {}) => appeler("recuperer", { url, format: options.format ?? "texte" }),
    lireFlux: async (url) => analyserFlux(String(await appeler("recuperer", { url, format: "texte" }))),
    kev: (state, questions) => appeler("kev", { state, questions }),
    gemma: (prompt, options = {}) => appeler("gemma", { prompt, images: options.images, json: options.json }),
    trier,
    journal: (...a) => versErreur(...a),
  };
  const module = await import(pathToFileURL(join(dossier, "recolte.mjs")).href);
  const donnees = await module.default(webaios);
  let json;
  try {
    json = JSON.stringify(donnees);
  } catch {
    json = undefined;
  }
  if (json === undefined) throw new Error("la récolte doit rendre du JSON");
  envoyer({ t: "fin", donnees: JSON.parse(json) });
  sortie.write("", () => process.exit(0));
}

principal().catch((e) => terminer({ t: "echec", erreur: String(e?.message ?? e) }, 1));
