import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch, state } from "./firefox";
import type { Marionette } from "./marionette";
import { click, waitUi } from "./ui";

// Helpers of the external MCP and Review e2e, ported from Electron's externes.spec.ts:16-47 and relecture.spec.ts:17-50.

/** A temporary project folder named `nom` (the project's name), outside any data folder, its real path. */
export function projectDir(nom: string): string {
  const d = join(mkdtempSync(join(tmpdir(), "webaios-externe-")), nom);
  mkdirSync(d);
  return realpathSync(d);
}

export const LINES = Array.from({ length: 30 }, (_, i) => `ligne ${i + 1}`);
export const writeAppJs = (dir: string, lignes: string[]) => writeFileSync(join(dir, "app.js"), lignes.join("\n") + "\n");
/** LINES with lines `n` (1-based) modified. */
export const modified = (...n: number[]) => LINES.map((l, i) => (n.includes(i + 1) ? `${l} modifiée` : l));

/** The Applications page of the first window, with its « Projets externes » section. */
export async function openApplications(m: Marionette): Promise<void> {
  await dispatch(m, { type: "ouvrirApplications", fenetreId: (await state(m)).fenetres[0]!.id });
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"projets-externes\"]')");
}

const COMMAND = /http:\/\/127\.0\.0\.1:(\d+)\/mcp-externe --header "Authorization: Bearer ([0-9a-f]{64})"/;

/** « Brancher un Claude Code » (named `nom` if given), then the command shown, read with Electron's regex. */
export async function connectClient(m: Marionette, nom?: string): Promise<{ commande: string; port: number; jeton: string }> {
  await waitUi(m, "return doc.querySelector('[data-testid=\"brancher-externe\"]')?.disabled === false", [], 15_000);
  await click(m, '[data-testid="brancher-externe"]');
  if (nom !== undefined)
    await waitUi(
      m,
      `const i = doc.querySelector('[data-testid="nom-brancher"]');
       if (!i) return false;
       i.value = arguments[0];
       i.dispatchEvent(new ui.Event("input", { bubbles: true }));
       return true;`,
      [nom],
    );
  await click(m, '[data-testid="valider-brancher"]');
  const commande = await waitUi<string>(m, "return doc.querySelector('[data-testid=\"commande-branchement\"]')?.textContent ?? null");
  const r = COMMAND.exec(commande);
  if (!r) throw new Error(`no connection command in: ${commande}`);
  return { commande, port: Number(r[1]), jeton: r[2]! };
}

export async function mcpClient(port: number, jeton: string): Promise<Client> {
  const c = new Client({ name: "essai", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp-externe`), { requestInit: { headers: { Authorization: `Bearer ${jeton}` } } }));
  return c;
}

export const textOf = (r: unknown): string => ((r as { content: { type: string; text?: string }[] }).content ?? []).map((x) => x.text ?? "").join("\n");

/** The review repository's `relu` ref of a project, under `<dataDir>/design/relecture/`. */
export const reviewedRef = (dataDir: string, projet: string) => join(dataDir, "design", "relecture", `${projet}.git`, "refs", "webaios", "relu");

/**
 * Connects a client and declares a project folder holding `app.js` (LINES) and `logo.bin`, then waits for its line and
 * its first review snapshot (unless `snapshot` is false: no git).
 */
export async function declareProject(
  m: Marionette,
  o: { dataDir: string; nom?: string; ports?: number[]; snapshot?: boolean },
): Promise<{ dossier: string; id: string; port: number; jeton: string; client: Client }> {
  const dossier = projectDir(o.nom ?? "mon-site");
  writeAppJs(dossier, LINES);
  writeFileSync(join(dossier, "logo.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const { port, jeton } = await connectClient(m);
  const client = await mcpClient(port, jeton);
  await client.callTool({ name: "declarer_projet", arguments: { dossier, ports: o.ports ?? [18765] } });
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"projet-externe\"]')", [], 15_000);
  const id = createHash("sha256").update(dossier).digest("hex").slice(0, 16);
  for (const deadline = Date.now() + 15_000; o.snapshot !== false && !existsSync(reviewedRef(o.dataDir, `ext-${id}`)); await new Promise((r) => setTimeout(r, 100)))
    if (Date.now() > deadline) throw new Error(`no first review snapshot of ext-${id}`);
  return { dossier, id, port, jeton, client };
}

/** The status of a raw POST to `/mcp-externe` (node:http: any Host header goes out as given, which fetch does not promise). */
export function rawStatus(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((ok, ko) => {
    const req = request({ host: "127.0.0.1", port, path: "/mcp-externe", method: "POST", headers: { "Content-Type": "application/json", ...headers } }, (res) => {
      res.resume();
      ok(res.statusCode ?? 0);
    });
    req.on("error", ko);
    req.end("{}");
  });
}

/** The notifications the host wrote to WEBAIOS_TEST_NOTIFICATIONS, in order. */
export function readNotifications(file: string): { titre: string; texte: string }[] {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

