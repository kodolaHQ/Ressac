import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_MODELS, DISPLAYS_SHIPPED, HARVESTS_SHIPPED, OLD_AGENTS } from "../workspace/initialize.js";
import { inside, kind, readNoFollow, rel, type Ctx } from "./json.js";
import { ACTOR_MESSAGES, ENGINE_API, ENGINE_FIELDS, FILES, FRAME_MESSAGES } from "./names.js";

export const REPORT_FILE = "migration-anglais.md";

const CODE = /\.(mjs|js|html|css)$/;
const CODE_MAX = 1024 * 1024;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Old API names the agent's code may still use: they are listed by name, the code itself is never copied. */
const OLD_NAMES = [
  ...Object.keys(ENGINE_API).filter((k) => k.includes(".")),
  ...Object.keys(FRAME_MESSAGES).filter((k) => k.includes("webaios")),
  ...Object.keys(ACTOR_MESSAGES).filter((k) => k.startsWith("__webaios")),
  ...Object.keys(ENGINE_FIELDS).filter((k) => k.length > 1).map((k) => `.${k}`),
  ".donnees",
  ".taille",
  ...["recolte.mjs", "affichage.html", "exemple.json"].filter((k) => k in FILES),
];
const PATTERN = new RegExp(OLD_NAMES.map((n) => `${escape(n)}(?![A-Za-z0-9_])`).join("|"), "g");

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const SHIPPED_CODE = new Set([...Object.values(DISPLAYS_SHIPPED), ...Object.values(HARVESTS_SHIPPED)].flatMap((s) => [...s]));

async function codeFiles(folder: string, depth = 0): Promise<string[]> {
  if (depth > 8 || (await kind(folder)) !== "dir") return [];
  const out: string[] = [];
  for (const e of await readdir(folder, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(folder, e.name);
    if (e.isDirectory()) out.push(...(await codeFiles(p, depth + 1)));
    else if (e.isFile() && CODE.test(e.name)) out.push(p);
  }
  return out;
}

/** The agent's code files that name old formats or APIs (starter files left as shipped excluded: initSpace replaces them). */
async function oldCode(ctx: Ctx): Promise<{ path: string; names: string[] }[]> {
  const found: { path: string; names: string[] }[] = [];
  for (const sub of ["home/widgets", "actions", "sites", "components", "extensions"]) {
    const folder = join(ctx.workspace, sub);
    if (!(await inside(ctx, join(folder, "x")))) continue;
    for (const f of await codeFiles(folder)) {
      let b: Buffer;
      try {
        b = await readNoFollow(f);
      } catch {
        continue;
      }
      if (b.length > CODE_MAX || SHIPPED_CODE.has(sha(b))) continue;
      const names = [...new Set(b.toString().match(PATTERN) ?? [])].sort();
      if (names.length) found.push({ path: rel(ctx, f), names });
    }
  }
  return found;
}

/** AGENTS.md edited by the user: neither the current template nor a shipped one, so initSpace leaves it. */
async function agentsEdited(ctx: Ctx): Promise<boolean> {
  try {
    const h = sha(await readNoFollow(join(ctx.workspace, "AGENTS.md")));
    return !OLD_AGENTS.has(h) && h !== sha(await readFile(join(DEFAULT_MODELS, "AGENTS.md")));
  } catch {
    return false;
  }
}

const list = (l: string[]) => l.map((x) => `- \`${x}\``).join("\n");

/** `<dataDir>/migration-anglais.md`, in French: paths and names only, never a page's or a file's content. */
export async function writeReport(ctx: Ctx, verifyFailures: { path: string; error: string }[]): Promise<string> {
  const code = await oldCode(ctx);
  const parts = [
    `# Passage des données aux noms anglais (${ctx.now.toISOString()})`,
    "Les dossiers et fichiers JSON de WebAiOs ont été renommés en anglais. La copie complète d'avant est à côté du dossier des données (`<données>.avant-anglais-<horodatage>`).",
  ];
  if (code.length) {
    parts.push(
      "## Code de l'agent à corriger",
      "Le code écrit par l'agent n'est pas réécrit. Ces fichiers utilisent encore d'anciens noms : demande à l'agent de les corriger (la section « Anciens noms » d'AGENTS.md donne la correspondance).",
      code.map((c) => `- \`${c.path}\` : ${c.names.map((n) => `\`${n}\``).join(", ")}`).join("\n"),
    );
  }
  if (await agentsEdited(ctx)) {
    parts.push("## AGENTS.md", "Ton `workspace/AGENTS.md` a été modifié : il est laissé tel quel et cite encore les anciens noms. Le modèle à jour est dans le paquet de WebAiOs (`modeles/AGENTS.md`).");
  }
  if (ctx.resign.length) {
    parts.push(
      "## Extensions de l'agent à signer de nouveau",
      "Leur version signée contient les anciens gardes, qui ne fonctionnent plus : elles sont marquées à signer de nouveau. L'agent doit les signer de nouveau : WebAiOs les renvoie à AMO, avec ta clé, au prochain démarrage où elles sont actives, comme après un changement de leur source.",
      list(ctx.resign),
    );
  }
  if (ctx.unreadable.length) parts.push("## Fichiers illisibles, laissés tels quels", list(ctx.unreadable));
  if (ctx.conflicts.length) parts.push("## Anciens fichiers laissés (le nouveau nom existe déjà)", list(ctx.conflicts));
  if (verifyFailures.length) {
    parts.push("## Fichiers migrés que WebAiOs ne relit pas", verifyFailures.map((f) => `- \`${rel(ctx, f.path)}\` : ${f.error}`).join("\n"));
  }
  if (ctx.dockerErrors.length) parts.push("## Docker", "L'ancien conteneur ou l'ancienne image n'a pas pu être retiré :", ctx.dockerErrors.map((e) => `- ${e}`).join("\n"));
  parts.push(
    "## MCP externe",
    "Le serveur des remarques s'appelle maintenant `webaios-remarks` (adresse `/mcp-external`). Dans tes autres projets, refais la commande `claude mcp add` que WebAiOs affiche quand tu branches un projet.",
  );
  const file = join(ctx.dataDir, REPORT_FILE);
  await writeFile(file, parts.join("\n\n") + "\n");
  return file;
}
