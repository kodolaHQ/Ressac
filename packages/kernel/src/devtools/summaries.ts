// Summaries and masking for the agent's dev tools: pure functions.

export const LENGTH_MAX = 2000;

const MASK = "«masqué»";
const SECRET_HEADERS = new Set(["cookie", "set-cookie", "authorization", "proxy-authorization"]);
const SECRET_PARAM = /token|key|secret|password|auth|session|sig/i;

/** Cuts a string that is too long and reports the cut. */
export function truncate(s: string, max = LENGTH_MAX): string {
  return s.length <= max ? s : `${s.slice(0, max)}… [tronqué]`;
}

/** Masks the headers that carry login data. */
export function maskHeaders(h: Record<string, string>): Record<string, string> {
  const r: Record<string, string> = {};
  for (const [name, value] of Object.entries(h)) {
    r[name] = SECRET_HEADERS.has(name.toLowerCase()) ? MASK : value;
  }
  return r;
}

/** Masks, in a `name=value&…` sequence, the values whose name is sensitive. */
function hidePairs(text: string): string {
  return text.replace(/(^|[?&])([^=&?]*)=([^&]*)/g, (all, sep: string, name: string) => {
    let lu = name;
    try {
      lu = decodeURIComponent(name);
    } catch {
      // badly encoded name: compared as it is
    }
    return SECRET_PARAM.test(lu) ? `${sep}${name}=${MASK}` : all;
  });
}

/** Masks the value of the sensitive params (query and fragment), without reformatting the rest of the URL. */
export function maskUrl(url: string): string {
  try {
    new URL(url);
  } catch {
    return url;
  }
  const iFragment = url.indexOf("#");
  const before = iFragment < 0 ? url : url.slice(0, iFragment);
  const fragment = iFragment < 0 ? "" : url.slice(iFragment + 1);
  const iRequest = before.indexOf("?");
  const base = iRequest < 0 ? before : before.slice(0, iRequest);
  const request = iRequest < 0 ? "" : hidePairs(before.slice(iRequest));
  return base + request + (iFragment < 0 ? "" : `#${hidePairs(fragment)}`);
}

/** The http(s) URLs of a free text (console message, stack), masked as by `masquerUrl`. */
export function hideUrlsInText(text: string): string {
  return text.replace(/https?:\/\/[^\s"'`<>()[\]{}]+/gi, (url) => maskUrl(url));
}

export interface CpuProfile {
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

const rounded = (x: number): string => String(Math.round(x * 10) / 10);

/** The n functions that occupy the processor the most, then the page's metrics. */
export function summarizeProfile(p: CpuProfile, metrics: Record<string, number>, n = 15): string {
  const byNode = new Map<number, number>();
  // timeDeltas[i] is the gap before sample i: sample i occupies the interval that follows it.
  let timestamp = p.startTime;
  p.samples.forEach((id, i) => {
    timestamp += p.timeDeltas[i] ?? 0;
    const next = i + 1 < p.samples.length ? timestamp + (p.timeDeltas[i + 1] ?? 0) : p.endTime;
    byNode.set(id, (byNode.get(id) ?? 0) + Math.max(0, next - timestamp));
  });
  const total = [...byNode.values()].reduce((a, b) => a + b, 0);
  const lignes = p.nodes
    .map((node) => ({ noeud: node, us: byNode.get(node.id) ?? 0 }))
    .filter((e) => e.us > 0)
    .sort((a, b) => b.us - a.us)
    .slice(0, n)
    .map(({ noeud: node, us }) => {
      const { functionName, url, lineNumber } = node.callFrame;
      const where = url ? ` (${url}:${lineNumber + 1})` : "";
      const pct = total > 0 ? (us / total) * 100 : 0;
      return `${functionName || "(anonyme)"}${where} — ${rounded(us / 1000)} ms, ${rounded(pct)} %`;
    });
  const m = metrics;
  const extra: string[] = [];
  if (m.Nodes !== undefined) extra.push(`Nodes : ${m.Nodes}`);
  if (m.JSHeapUsedSize !== undefined) extra.push(`JSHeapUsedSize : ${rounded(m.JSHeapUsedSize / 1024 / 1024)} Mo`);
  if (m.LayoutCount !== undefined) extra.push(`LayoutCount : ${m.LayoutCount}`);
  if (m.ScriptDuration !== undefined) extra.push(`ScriptDuration : ${rounded(m.ScriptDuration * 1000)} ms`);
  if (m.TaskDuration !== undefined) extra.push(`TaskDuration : ${rounded(m.TaskDuration * 1000)} ms`);
  return [...lignes, ...extra].join("\n");
}

export interface MemorySummary {
  total: number;
  parConstructeur: { nom: string; nombre: number; taille: number }[];
}

const KEPT_TYPES = new Set(["object", "closure", "array", "string", "regexp", "native"]);

/** Firefox census, already converted by the caller; entries are object classes, not JS constructors. */
export interface FirefoxSnapshot extends MemorySummary {
  format: "webaios-firefox-census";
}

/** Reads a V8 `.heapsnapshot` (or a Firefox census) and groups the nodes by name. */
export function summarizeSnapshot(json: string): MemorySummary {
  const parse = JSON.parse(json) as { format?: string };
  if (parse.format === "webaios-firefox-census") {
    const { total, parConstructeur: byBuilder } = parse as FirefoxSnapshot;
    return { total, parConstructeur: [...byBuilder].sort((a, b) => b.taille - a.taille) };
  }
  const raw = parse as unknown as {
    snapshot: { meta: { node_fields: string[]; node_types: unknown[] } };
    nodes: number[];
    strings: string[];
  };
  const { node_fields: champs, node_types: nodeTypes } = raw.snapshot.meta;
  const iType = champs.indexOf("type");
  const iName = champs.indexOf("name");
  const iSize = champs.indexOf("self_size");
  const typeNames = (nodeTypes[iType] as string[]) ?? [];
  const step = champs.length;
  const groups = new Map<string, { nom: string; nombre: number; taille: number }>();
  let total = 0;
  for (let i = 0; i + step <= raw.nodes.length; i += step) {
    const size = raw.nodes[i + iSize] ?? 0;
    total += size;
    if (!KEPT_TYPES.has(typeNames[raw.nodes[i + iType] ?? -1] ?? "")) continue;
    // a string's name is its content: it is not passed on
    const name =
      typeNames[raw.nodes[i + iType] ?? -1] === "string"
        ? "(chaîne)"
        : (raw.strings[raw.nodes[i + iName] ?? -1] ?? "");
    const g = groups.get(name) ?? { nom: name, nombre: 0, taille: 0 };
    g.nombre += 1;
    g.taille += size;
    groups.set(name, g);
  }
  return { total, parConstructeur: [...groups.values()].sort((a, b) => b.taille - a.taille) };
}

const ko = (bytes: number): string => `${rounded(bytes / 1024)} Ko`;

export function memoryText(r: MemorySummary, n = 20): string {
  const lignes = r.parConstructeur
    .slice(0, n)
    .map((c) => `${c.nom || "(sans nom)"} : ${c.nombre} objets, ${ko(c.taille)}`);
  return [`Total : ${ko(r.total)}`, ...lignes].join("\n");
}

/** The constructors that grew the most from `a` to `b` (positive gaps only). */
export function compareMemory(a: MemorySummary, b: MemorySummary, n = 20): string {
  const before = new Map(a.parConstructeur.map((c) => [c.nom, c]));
  const lignes = b.parConstructeur
    .map((c) => ({
      nom: c.nom,
      dNombre: c.nombre - (before.get(c.nom)?.nombre ?? 0),
      dTaille: c.taille - (before.get(c.nom)?.taille ?? 0),
    }))
    .filter((e) => e.dNombre > 0 || e.dTaille > 0)
    .sort((x, y) => y.dTaille - x.dTaille)
    .slice(0, n)
    .map((e) => `${e.nom || "(sans nom)"} +${e.dNombre} (+${ko(e.dTaille)})`);
  const gap = b.total - a.total;
  return [`Total : ${gap >= 0 ? "+" : ""}${ko(gap)}`, ...lignes].join("\n");
}
