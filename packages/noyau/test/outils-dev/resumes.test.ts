import { describe, expect, it } from "vitest";
import {
  comparerMemoire,
  LONGUEUR_MAX,
  masquerEnTetes,
  masquerUrl,
  resumerInstantane,
  resumerProfil,
  texteMemoire,
  tronquer,
  type ProfilCpu,
} from "../../src/outils-dev/resumes.js";

describe("tronquer", () => {
  it("garde les chaînes courtes", () => {
    expect(tronquer("salut")).toBe("salut");
  });
  it("coupe les chaînes longues avec le suffixe", () => {
    const r = tronquer("a".repeat(LONGUEUR_MAX + 10));
    expect(r).toBe("a".repeat(LONGUEUR_MAX) + "… [tronqué]");
    expect(tronquer("abcdef", 3)).toBe("abc… [tronqué]");
  });
});

describe("masquerEnTetes", () => {
  it("masque les quatre en-têtes sans tenir compte de la casse", () => {
    const r = masquerEnTetes({
      Cookie: "a=1",
      "Set-Cookie": "b=2",
      AUTHORIZATION: "Bearer x",
      "proxy-authorization": "y",
      Accept: "text/html",
    });
    expect(r).toEqual({
      Cookie: "«masqué»",
      "Set-Cookie": "«masqué»",
      AUTHORIZATION: "«masqué»",
      "proxy-authorization": "«masqué»",
      Accept: "text/html",
    });
  });
});

describe("masquerUrl", () => {
  it("masque la valeur des paramètres sensibles", () => {
    expect(masquerUrl("https://x.fr/p?access_token=abc&q=chat")).toBe(
      "https://x.fr/p?access_token=«masqué»&q=chat",
    );
  });
  it("masque aussi les paramètres du fragment", () => {
    expect(masquerUrl("https://x/cb#access_token=abc&state=1")).toBe(
      "https://x/cb#access_token=«masqué»&state=1",
    );
  });
  it("laisse une URL invalide telle quelle", () => {
    expect(masquerUrl("pas une url")).toBe("pas une url");
  });
  it("laisse intacte une URL sans paramètre sensible", () => {
    expect(masquerUrl("https://x.fr/p?q=chat")).toBe("https://x.fr/p?q=chat");
  });
});

const profil: ProfilCpu = {
  nodes: [
    { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1 }, children: [2, 3] },
    { id: 2, callFrame: { functionName: "calculer", url: "http://x/a.js", lineNumber: 3 } },
    { id: 3, callFrame: { functionName: "", url: "http://x/b.js", lineNumber: 7 } },
  ],
  samples: [2, 2, 3, 1],
  timeDeltas: [10000, 20000, 5000, 5000],
  startTime: 0,
  endTime: 40000,
};

describe("resumerProfil", () => {
  it("nomme d'abord la fonction la plus coûteuse, avec ses ms", () => {
    const t = resumerProfil(profil, {
      Nodes: 120,
      JSHeapUsedSize: 5 * 1024 * 1024,
      LayoutCount: 4,
      ScriptDuration: 0.0123,
      TaskDuration: 0.5,
    });
    const lignes = t.split("\n");
    expect(lignes[0]).toContain("calculer");
    expect(lignes[0]).toContain("25 ms");
    expect(lignes[0]).toContain("83.3");
    expect(t).toContain("(anonyme)");
    expect(t).toContain("Nodes : 120");
    expect(t).toContain("JSHeapUsedSize : 5 Mo");
    expect(t).toContain("LayoutCount : 4");
    expect(t).toContain("ScriptDuration : 12.3 ms");
    expect(t).toContain("TaskDuration : 500 ms");
  });
  it("limite à n fonctions", () => {
    const t = resumerProfil(profil, {}, 1);
    expect(t).not.toContain("(anonyme)");
    expect(t.split("\n")).toHaveLength(1);
  });
  it("charge chaque échantillon de l'intervalle qui le suit", () => {
    // écarts inégaux : l'ancien calcul (écart avant) donnerait 31 ms à l'anonyme et 2 ms à « calculer »
    const t = resumerProfil({ ...profil, samples: [3, 2, 3], timeDeltas: [1000, 2000, 30000], endTime: 38000 }, {});
    expect(t.split("\n")[0]).toContain("calculer (http://x/a.js:4) — 30 ms");
    expect(t).toContain("(anonyme) (http://x/b.js:8) — 7 ms");
  });
});

/** Instantané V8 minimal : 6 champs par nœud. */
function instantane(noeuds: [string, string, number][]): string {
  const strings: string[] = [];
  const types = ["hidden", "array", "string", "object", "code", "closure", "regexp", "number", "native"];
  const plat: number[] = [];
  noeuds.forEach(([type, nom, taille], i) => {
    let idx = strings.indexOf(nom);
    if (idx < 0) idx = strings.push(nom) - 1;
    plat.push(types.indexOf(type), idx, i + 1, taille, 0, 0);
  });
  return JSON.stringify({
    snapshot: {
      meta: {
        node_fields: ["type", "name", "id", "self_size", "edge_count", "trace_node_id"],
        node_types: [types, "string", "number", "number", "number", "number"],
      },
    },
    nodes: plat,
    strings,
  });
}

describe("résumé mémoire", () => {
  const a = resumerInstantane(
    instantane([
      ["object", "Fuite", 100],
      ["object", "Fuite", 50],
      ["object", "Autre", 30],
      ["code", "Code", 999],
    ]),
  );
  it("regroupe par constructeur et ignore les types hors liste", () => {
    expect(a.total).toBe(1179);
    expect(a.parConstructeur[0]).toEqual({ nom: "Fuite", nombre: 2, taille: 150 });
    expect(a.parConstructeur.map((c) => c.nom)).not.toContain("Code");
  });
  it("ne transmet pas le contenu des chaînes", () => {
    const r = resumerInstantane(
      instantane([
        ["string", "mot-de-passe-secret", 10],
        ["string", "autre contenu", 20],
      ]),
    );
    expect(r.parConstructeur).toEqual([{ nom: "(chaîne)", nombre: 2, taille: 30 }]);
  });
  it("texteMemoire liste les constructeurs", () => {
    expect(texteMemoire(a)).toContain("Fuite");
  });
  it("comparerMemoire signale la croissance", () => {
    const b = resumerInstantane(
      instantane([
        ...Array.from({ length: 5 }, () => ["object", "Fuite", 100] as [string, string, number]),
        ["object", "Autre", 30],
      ]),
    );
    const t = comparerMemoire(a, b);
    expect(t).toContain("Fuite +3");
    expect(t).not.toContain("Autre");
  });
});

const recensement = (objets: Record<string, [number, number]>, total: number): string =>
  JSON.stringify({
    format: "webaios-firefox-census",
    total,
    parConstructeur: Object.entries(objets).map(([nom, [nombre, taille]]) => ({ nom, nombre, taille })),
  });

describe("recensement Firefox", () => {
  it("resumerInstantane lit un recensement Firefox : total et constructeurs triés par taille", () => {
    const r = resumerInstantane(
      recensement({ Function: [10, 500], Object: [40, 4000], Array: [5, 900], strings: [20, 2000] }, 9000),
    );
    expect(r.total).toBe(9000);
    expect(r.parConstructeur.map((c) => c.nom)).toEqual(["Object", "strings", "Array", "Function"]);
    expect(r.parConstructeur[0]).toEqual({ nom: "Object", nombre: 40, taille: 4000 });
  });
  it("comparerMemoire sur deux recensements Firefox : le type qui grossit est en tête", () => {
    const a = resumerInstantane(recensement({ Object: [40, 4000], Array: [5, 900] }, 5000));
    const b = resumerInstantane(recensement({ Object: [400, 40000], Array: [5, 900] }, 41000));
    const t = comparerMemoire(a, b);
    expect(t.split("\n")[1]).toContain("Object +360");
    expect(t).not.toContain("Array");
  });
});
