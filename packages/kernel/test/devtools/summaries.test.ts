import { describe, expect, it } from "vitest";
import {
  compareMemory,
  LENGTH_MAX,
  maskHeaders,
  maskUrl,
  summarizeSnapshot,
  summarizeProfile,
  memoryText,
  truncate,
  type CpuProfile,
} from "../../src/devtools/summaries.js";

describe("tronquer", () => {
  it("keeps short strings", () => {
    expect(truncate("salut")).toBe("salut");
  });
  it("cuts long strings with the suffix", () => {
    const r = truncate("a".repeat(LENGTH_MAX + 10));
    expect(r).toBe("a".repeat(LENGTH_MAX) + "… [tronqué]");
    expect(truncate("abcdef", 3)).toBe("abc… [tronqué]");
  });
});

describe("maskHeaders", () => {
  it("masks the four headers regardless of case", () => {
    const r = maskHeaders({
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
  it("masks the value of sensitive parameters", () => {
    expect(maskUrl("https://x.fr/p?access_token=abc&q=chat")).toBe(
      "https://x.fr/p?access_token=«masqué»&q=chat",
    );
  });
  it("also masks the fragment's parameters", () => {
    expect(maskUrl("https://x/cb#access_token=abc&state=1")).toBe(
      "https://x/cb#access_token=«masqué»&state=1",
    );
  });
  it("leaves an invalid URL as is", () => {
    expect(maskUrl("pas une url")).toBe("pas une url");
  });
  it("leaves a URL without a sensitive parameter intact", () => {
    expect(maskUrl("https://x.fr/p?q=chat")).toBe("https://x.fr/p?q=chat");
  });
});

const profile: CpuProfile = {
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

describe("summarizeProfile", () => {
  it("names the most expensive function first, with its ms", () => {
    const t = summarizeProfile(profile, {
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
  it("limits to n functions", () => {
    const t = summarizeProfile(profile, {}, 1);
    expect(t).not.toContain("(anonyme)");
    expect(t.split("\n")).toHaveLength(1);
  });
  it("charges each sample to the interval that follows it", () => {
    // uneven gaps: the old computation (gap before) would give 31 ms to the anonymous one and 2 ms to « calculer »
    const t = summarizeProfile({ ...profile, samples: [3, 2, 3], timeDeltas: [1000, 2000, 30000], endTime: 38000 }, {});
    expect(t.split("\n")[0]).toContain("calculer (http://x/a.js:4) — 30 ms");
    expect(t).toContain("(anonyme) (http://x/b.js:8) — 7 ms");
  });
});

/** Minimal V8 snapshot: 6 fields per node. */
function snapshot(nodes: [string, string, number][]): string {
  const strings: string[] = [];
  const types = ["hidden", "array", "string", "object", "code", "closure", "regexp", "number", "native"];
  const flat: number[] = [];
  nodes.forEach(([type, name, size], i) => {
    let idx = strings.indexOf(name);
    if (idx < 0) idx = strings.push(name) - 1;
    flat.push(types.indexOf(type), idx, i + 1, size, 0, 0);
  });
  return JSON.stringify({
    snapshot: {
      meta: {
        node_fields: ["type", "name", "id", "self_size", "edge_count", "trace_node_id"],
        node_types: [types, "string", "number", "number", "number", "number"],
      },
    },
    nodes: flat,
    strings,
  });
}

describe("memory summary", () => {
  const a = summarizeSnapshot(
    snapshot([
      ["object", "Fuite", 100],
      ["object", "Fuite", 50],
      ["object", "Autre", 30],
      ["code", "Code", 999],
    ]),
  );
  it("groups by constructor and ignores types outside the list", () => {
    expect(a.total).toBe(1179);
    expect(a.parConstructeur[0]).toEqual({ nom: "Fuite", nombre: 2, taille: 150 });
    expect(a.parConstructeur.map((c) => c.nom)).not.toContain("Code");
  });
  it("does not pass on the content of strings", () => {
    const r = summarizeSnapshot(
      snapshot([
        ["string", "mot-de-passe-secret", 10],
        ["string", "autre contenu", 20],
      ]),
    );
    expect(r.parConstructeur).toEqual([{ nom: "(chaîne)", nombre: 2, taille: 30 }]);
  });
  it("memoryText lists the constructors", () => {
    expect(memoryText(a)).toContain("Fuite");
  });
  it("compareMemory flags the growth", () => {
    const b = summarizeSnapshot(
      snapshot([
        ...Array.from({ length: 5 }, () => ["object", "Fuite", 100] as [string, string, number]),
        ["object", "Autre", 30],
      ]),
    );
    const t = compareMemory(a, b);
    expect(t).toContain("Fuite +3");
    expect(t).not.toContain("Autre");
  });
});

const census = (objects: Record<string, [number, number]>, total: number): string =>
  JSON.stringify({
    format: "webaios-firefox-census",
    total,
    parConstructeur: Object.entries(objects).map(([name, [count, size]]) => ({ nom: name, nombre: count, taille: size })),
  });

describe("recensement Firefox", () => {
  it("summarizeSnapshot reads a Firefox census: total and constructors sorted by size", () => {
    const r = summarizeSnapshot(
      census({ Function: [10, 500], Object: [40, 4000], Array: [5, 900], strings: [20, 2000] }, 9000),
    );
    expect(r.total).toBe(9000);
    expect(r.parConstructeur.map((c) => c.nom)).toEqual(["Object", "strings", "Array", "Function"]);
    expect(r.parConstructeur[0]).toEqual({ nom: "Object", nombre: 40, taille: 4000 });
  });
  it("compareMemory on two Firefox censuses: the type that grows comes first", () => {
    const a = summarizeSnapshot(census({ Object: [40, 4000], Array: [5, 900] }, 5000));
    const b = summarizeSnapshot(census({ Object: [400, 40000], Array: [5, 900] }, 41000));
    const t = compareMemory(a, b);
    expect(t.split("\n")[1]).toContain("Object +360");
    expect(t).not.toContain("Array");
  });
});
