import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { BUILTIN_COMPONENTS, type ComponentDefinition } from "./catalog.js";

// The agent's components: `<dossier>/<nom>/composant.json` + `composant.html`. Nothing is run here; errors are
// fixed texts (the system's message would quote Mac paths).

export const COMPONENT_HTML_MAX = 256 * 1024;
const JSON_MAX = 64 * 1024;
const MAX_ERROR = 300;
export const PROPERTY_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const NAME = /^[a-z0-9-]{1,40}$/;

export const ComponentDeclaration = z
  .object({
    name: z.string().regex(NAME),
    description: z.string().min(1).max(300),
    properties: z
      .record(
        z.string().regex(PROPERTY_NAME),
        z.object({
          kind: z.enum(["reference", "champ", "texte", "nombre", "case"]),
          description: z.string().min(1).max(200),
          required: z.boolean().default(false),
        }).strict(),
      )
      .refine((r) => Object.keys(r).length <= 12, "12 propriétés au plus"),
  })
  .strict();
export type ComponentDeclaration = z.infer<typeof ComponentDeclaration>;

const BUILTIN_NAMES = new Set(BUILTIN_COMPONENTS.map((c) => c.name));

async function readTextFile(file: string, name: string, max: number, absent: string): Promise<{ text: string } | { error: string }> {
  let s;
  try {
    s = await lstat(file);
  } catch {
    return { error: absent };
  }
  if (!s.isFile()) return { error: `${name} n'est pas un fichier ordinaire` };
  if (s.size > max) return { error: `${name} dépasse ${max / 1024} Ko` };
  try {
    return { text: await readFile(file, "utf8") };
  } catch {
    return { error: `${name} illisible` };
  }
}

async function readOne(folder: string, name: string): Promise<ComponentDefinition | string> {
  const json = await readTextFile(join(folder, name, "composant.json"), "composant.json", JSON_MAX, "composant.json absent");
  if ("error" in json) return json.error;
  let raw: unknown;
  try {
    raw = JSON.parse(json.text);
  } catch {
    return "composant.json illisible (pas du JSON valide)";
  }
  // zod silently ignores a « __proto__ » key: we look at the raw keys beforehand.
  const props = (raw as { properties?: unknown } | null)?.properties;
  if (props && typeof props === "object" && Object.keys(props).some((k) => !PROPERTY_NAME.test(k))) {
    return "composant.json invalide : proprietes : nom de propriété non valide";
  }
  const r = ComponentDeclaration.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0]!;
    const t = `composant.json invalide : ${[...i.path, i.message].join(" : ")}`;
    return t.length > MAX_ERROR ? t.slice(0, MAX_ERROR - 1) + "…" : t;
  }
  const d = r.data;
  if (d.name !== name) return "composant.json : le nom doit être celui du dossier";
  if (BUILTIN_NAMES.has(d.name)) return "composant.json : ce nom est celui d'un composant intégré";
  const html = await readTextFile(join(folder, name, "composant.html"), "composant.html", COMPONENT_HTML_MAX, "composant.html absent");
  if ("error" in html) return html.error;
  return { name: d.name, description: d.description, properties: d.properties, origin: "agent" };
}

/** The agent's components, sorted by name; a broken component is reported, it does not prevent reading the others. */
export async function readAgentComponents(folder: string): Promise<{ valid: ComponentDefinition[]; invalids: { name: string; error: string }[] }> {
  let names: string[];
  try {
    // `isDirectory` is false for a symbolic link: a link to a folder is ignored.
    names = (await readdir(folder, { withFileTypes: true })).filter((e) => e.isDirectory() && NAME.test(e.name)).map((e) => e.name).sort();
  } catch {
    return { valid: [], invalids: [] };
  }
  const valid: ComponentDefinition[] = [];
  const invalid: { name: string; error: string }[] = [];
  for (const name of names) {
    const r = await readOne(folder, name);
    if (typeof r === "string") invalid.push({ name: name, error: r });
    else valid.push(r);
  }
  return { valid: valid, invalids: invalid };
}
