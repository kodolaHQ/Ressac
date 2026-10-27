// Résumés et masquage pour les outils de développement de l'agent : fonctions pures.

export const LONGUEUR_MAX = 2000;

const MASQUE = "«masqué»";
const EN_TETES_SECRETS = new Set(["cookie", "set-cookie", "authorization", "proxy-authorization"]);
const PARAMETRE_SECRET = /token|key|secret|password|auth|session|sig/i;

/** Coupe une chaîne trop longue et signale la coupe. */
export function tronquer(s: string, max = LONGUEUR_MAX): string {
  return s.length <= max ? s : `${s.slice(0, max)}… [tronqué]`;
}

/** Masque les en-têtes qui portent des données de connexion. */
export function masquerEnTetes(h: Record<string, string>): Record<string, string> {
  const r: Record<string, string> = {};
  for (const [nom, valeur] of Object.entries(h)) {
    r[nom] = EN_TETES_SECRETS.has(nom.toLowerCase()) ? MASQUE : valeur;
  }
  return r;
}

/** Masque, dans une suite `nom=valeur&…`, les valeurs dont le nom est sensible. */
function masquerPaires(texte: string): string {
  return texte.replace(/(^|[?&])([^=&?]*)=([^&]*)/g, (tout, sep: string, nom: string) => {
    let lu = nom;
    try {
      lu = decodeURIComponent(nom);
    } catch {
      // nom mal encodé : on le compare tel quel
    }
    return PARAMETRE_SECRET.test(lu) ? `${sep}${nom}=${MASQUE}` : tout;
  });
}

/** Masque la valeur des paramètres sensibles (requête et fragment), sans reformater le reste de l'URL. */
export function masquerUrl(url: string): string {
  try {
    new URL(url);
  } catch {
    return url;
  }
  const iFragment = url.indexOf("#");
  const avant = iFragment < 0 ? url : url.slice(0, iFragment);
  const fragment = iFragment < 0 ? "" : url.slice(iFragment + 1);
  const iRequete = avant.indexOf("?");
  const base = iRequete < 0 ? avant : avant.slice(0, iRequete);
  const requete = iRequete < 0 ? "" : masquerPaires(avant.slice(iRequete));
  return base + requete + (iFragment < 0 ? "" : `#${masquerPaires(fragment)}`);
}

export interface ProfilCpu {
  nodes: {
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number };
    children?: number[];
  }[];
  samples: number[];
  timeDeltas: number[];
  startTime: number;
  endTime: number;
}

const arrondi = (x: number): string => String(Math.round(x * 10) / 10);

/** Les n fonctions qui occupent le plus le processeur, puis les métriques de la page. */
export function resumerProfil(p: ProfilCpu, metriques: Record<string, number>, n = 15): string {
  const parNoeud = new Map<number, number>();
  // timeDeltas[i] est l'écart avant l'échantillon i : l'échantillon i occupe l'intervalle qui le suit.
  let horodatage = p.startTime;
  p.samples.forEach((id, i) => {
    horodatage += p.timeDeltas[i] ?? 0;
    const suivant = i + 1 < p.samples.length ? horodatage + (p.timeDeltas[i + 1] ?? 0) : p.endTime;
    parNoeud.set(id, (parNoeud.get(id) ?? 0) + Math.max(0, suivant - horodatage));
  });
  const total = [...parNoeud.values()].reduce((a, b) => a + b, 0);
  const lignes = p.nodes
    .map((noeud) => ({ noeud, us: parNoeud.get(noeud.id) ?? 0 }))
    .filter((e) => e.us > 0)
    .sort((a, b) => b.us - a.us)
    .slice(0, n)
    .map(({ noeud, us }) => {
      const { functionName, url, lineNumber } = noeud.callFrame;
      const lieu = url ? ` (${url}:${lineNumber + 1})` : "";
      const pct = total > 0 ? (us / total) * 100 : 0;
      return `${functionName || "(anonyme)"}${lieu} — ${arrondi(us / 1000)} ms, ${arrondi(pct)} %`;
    });
  const m = metriques;
  const extra: string[] = [];
  if (m.Nodes !== undefined) extra.push(`Nodes : ${m.Nodes}`);
  if (m.JSHeapUsedSize !== undefined) extra.push(`JSHeapUsedSize : ${arrondi(m.JSHeapUsedSize / 1024 / 1024)} Mo`);
  if (m.LayoutCount !== undefined) extra.push(`LayoutCount : ${m.LayoutCount}`);
  if (m.ScriptDuration !== undefined) extra.push(`ScriptDuration : ${arrondi(m.ScriptDuration * 1000)} ms`);
  if (m.TaskDuration !== undefined) extra.push(`TaskDuration : ${arrondi(m.TaskDuration * 1000)} ms`);
  return [...lignes, ...extra].join("\n");
}

export interface ResumeMemoire {
  total: number;
  parConstructeur: { nom: string; nombre: number; taille: number }[];
}

const TYPES_RETENUS = new Set(["object", "closure", "array", "string", "regexp", "native"]);

/** Lit un `.heapsnapshot` V8 et regroupe les nœuds par nom. */
export function resumerInstantane(json: string): ResumeMemoire {
  const brut = JSON.parse(json) as {
    snapshot: { meta: { node_fields: string[]; node_types: unknown[] } };
    nodes: number[];
    strings: string[];
  };
  const { node_fields: champs, node_types: typesNoeud } = brut.snapshot.meta;
  const iType = champs.indexOf("type");
  const iNom = champs.indexOf("name");
  const iTaille = champs.indexOf("self_size");
  const nomsTypes = (typesNoeud[iType] as string[]) ?? [];
  const pas = champs.length;
  const groupes = new Map<string, { nom: string; nombre: number; taille: number }>();
  let total = 0;
  for (let i = 0; i + pas <= brut.nodes.length; i += pas) {
    const taille = brut.nodes[i + iTaille] ?? 0;
    total += taille;
    if (!TYPES_RETENUS.has(nomsTypes[brut.nodes[i + iType] ?? -1] ?? "")) continue;
    // le nom d'une chaîne est son contenu : on ne le transmet pas
    const nom =
      nomsTypes[brut.nodes[i + iType] ?? -1] === "string"
        ? "(chaîne)"
        : (brut.strings[brut.nodes[i + iNom] ?? -1] ?? "");
    const g = groupes.get(nom) ?? { nom, nombre: 0, taille: 0 };
    g.nombre += 1;
    g.taille += taille;
    groupes.set(nom, g);
  }
  return { total, parConstructeur: [...groupes.values()].sort((a, b) => b.taille - a.taille) };
}

const ko = (octets: number): string => `${arrondi(octets / 1024)} Ko`;

export function texteMemoire(r: ResumeMemoire, n = 20): string {
  const lignes = r.parConstructeur
    .slice(0, n)
    .map((c) => `${c.nom || "(sans nom)"} : ${c.nombre} objets, ${ko(c.taille)}`);
  return [`Total : ${ko(r.total)}`, ...lignes].join("\n");
}

/** Les constructeurs qui ont le plus grossi de `a` à `b` (écarts positifs seulement). */
export function comparerMemoire(a: ResumeMemoire, b: ResumeMemoire, n = 20): string {
  const avant = new Map(a.parConstructeur.map((c) => [c.nom, c]));
  const lignes = b.parConstructeur
    .map((c) => ({
      nom: c.nom,
      dNombre: c.nombre - (avant.get(c.nom)?.nombre ?? 0),
      dTaille: c.taille - (avant.get(c.nom)?.taille ?? 0),
    }))
    .filter((e) => e.dNombre > 0 || e.dTaille > 0)
    .sort((x, y) => y.dTaille - x.dTaille)
    .slice(0, n)
    .map((e) => `${e.nom || "(sans nom)"} +${e.dNombre} (+${ko(e.dTaille)})`);
  const ecart = b.total - a.total;
  return [`Total : ${ecart >= 0 ? "+" : ""}${ko(ecart)}`, ...lignes].join("\n");
}
