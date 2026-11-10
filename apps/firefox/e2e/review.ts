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

// Helpers of the external MCP and Review e2e.

/** A temporary project folder named `nom` (the project's name), outside any data folder, its real path. */
export function projectDir(name: string): string {
  const d = join(mkdtempSync(join(tmpdir(), "webaios-externe-")), name);
  mkdirSync(d);
  return realpathSync(d);
}

export const LINES = Array.from({ length: 30 }, (_, i) => `ligne ${i + 1}`);
export const writeAppJs = (dir: string, lines: string[]) => writeFileSync(join(dir, "app.js"), lines.join("\n") + "\n");
/** LINES with lines `n` (1-based) modified. */
export const modified = (...n: number[]) => LINES.map((l, i) => (n.includes(i + 1) ? `${l} modifiée` : l));

/** The Applications page of the first window, with its « Projets externes » section. */
export async function openApplications(m: Marionette): Promise<void> {
  await dispatch(m, { type: "openApps", windowId: (await state(m)).windows[0]!.id });
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"external-projects\"]')");
}

const COMMAND = /http:\/\/127\.0\.0\.1:(\d+)\/mcp-external --header "Authorization: Bearer ([0-9a-f]{64})"/;

/** « Brancher un Claude Code » (named `nom` if given), then the command shown, read with a regex. */
export async function connectClient(m: Marionette, name?: string): Promise<{ command: string; port: number; token: string }> {
  await waitUi(m, "return doc.querySelector('[data-testid=\"connect-external\"]')?.disabled === false", [], 15_000);
  await click(m, '[data-testid="connect-external"]');
  if (name !== undefined)
    await waitUi(
      m,
      `const i = doc.querySelector('[data-testid="connect-name"]');
       if (!i) return false;
       i.value = arguments[0];
       i.dispatchEvent(new ui.Event("input", { bubbles: true }));
       return true;`,
      [name],
    );
  await click(m, '[data-testid="confirm-connect"]');
  const command = await waitUi<string>(m, "return doc.querySelector('[data-testid=\"connect-command\"]')?.textContent ?? null");
  const r = COMMAND.exec(command);
  if (!r) throw new Error(`no connection command in: ${command}`);
  return { command: command, port: Number(r[1]), token: r[2]! };
}

export async function mcpClient(port: number, token: string): Promise<Client> {
  const c = new Client({ name: "essai", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp-external`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
}

export const textOf = (r: unknown): string => ((r as { content: { type: string; text?: string }[] }).content ?? []).map((x) => x.text ?? "").join("\n");

/** The review repository's `relu` ref of a project, under `<dataDir>/design/review/`. */
export const reviewedRef = (dataDir: string, project: string) => join(dataDir, "design", "review", `${project}.git`, "refs", "webaios", "relu");

/**
 * Connects a client and declares a project folder holding `app.js` (LINES) and `logo.bin`, then waits for its line and
 * its first review snapshot (unless `snapshot` is false: no git).
 */
export async function declareProject(
  m: Marionette,
  o: { dataDir: string; name?: string; ports?: number[]; snapshot?: boolean },
): Promise<{ folder: string; id: string; port: number; token: string; client: Client }> {
  const folder = projectDir(o.name ?? "mon-site");
  writeAppJs(folder, LINES);
  writeFileSync(join(folder, "logo.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const { port, token: token } = await connectClient(m);
  const client = await mcpClient(port, token);
  await client.callTool({ name: "declare_project", arguments: { folder: folder, ports: o.ports ?? [18765] } });
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"external-project\"]')", [], 15_000);
  const id = createHash("sha256").update(folder).digest("hex").slice(0, 16);
  for (const deadline = Date.now() + 15_000; o.snapshot !== false && !existsSync(reviewedRef(o.dataDir, `ext-${id}`)); await new Promise((r) => setTimeout(r, 100)))
    if (Date.now() > deadline) throw new Error(`no first review snapshot of ext-${id}`);
  return { folder: folder, id, port, token: token, client };
}

/** The status of a raw POST to `/mcp-external` (node:http: any Host header goes out as given, which fetch does not promise). */
export function rawStatus(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((ok, ko) => {
    const req = request({ host: "127.0.0.1", port, path: "/mcp-external", method: "POST", headers: { "Content-Type": "application/json", ...headers } }, (res) => {
      res.resume();
      ok(res.statusCode ?? 0);
    });
    req.on("error", ko);
    req.end("{}");
  });
}

/** The notifications the host wrote to WEBAIOS_TEST_NOTIFICATIONS, in order. */
export function readNotifications(file: string): { title: string; text: string }[] {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}


/**
 * « Rafraîchir » on the Review page, once it is enabled again: the button stays disabled while the previous comparison loads, and a click on it then does nothing.
 * Returns once the new comparison is shown (enabled again): before that the page still shows the old one, and the
 * page's other buttons (« Envoyer… », « Marquer comme relu ») stay disabled, so a click on them does nothing.
 */
export async function refreshReview(m: Marionette): Promise<void> {
  const sel = '[data-testid="review-page"] button';
  const enabled = "return [...doc.querySelectorAll(arguments[0])].some((b) => b.textContent.includes('Rafraîchir') && !b.disabled)";
  await waitUi(m, enabled, [sel], 15_000);
  await click(m, sel, { text: "Rafraîchir" });
  await waitUi(m, enabled, [sel], 15_000);
}
