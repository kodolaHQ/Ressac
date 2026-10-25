import { afterEach, beforeEach, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PolitiqueAcces } from "../../src/acces/politique.js";
import type { OngletInfo } from "../../src/mcp/pont.js";
import { PontFactice } from "../../src/mcp/pont-factice.js";
import { demarrerServeurMcp, genererJeton } from "../../src/mcp/serveur.js";

const github: OngletInfo = { id: "github", titre: "sveltejs/svelte", url: "https://github.com/sveltejs/svelte", espace: "perso" };
const gmail: OngletInfo = { id: "gmail", titre: "Gmail — Boîte de réception", url: "https://mail.google.com/mail/u/0/", espace: "perso" };

let serveur: Awaited<ReturnType<typeof demarrerServeurMcp>>;
let client: Client;
let pont: PontFactice;
let politique: PolitiqueAcces;
const jeton = genererJeton();

async function demarrer(autoriser: boolean) {
  pont = new PontFactice([github, gmail], { actif: "github", autoriser });
  politique = new PolitiqueAcces();
  serveur = await demarrerServeurMcp({ pont, politique, jeton });
  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${serveur.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${jeton}` } },
    }),
  );
}
const texte = (r: Awaited<ReturnType<Client["callTool"]>>) =>
  (r.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
const demandes = () => pont.appels.filter((a) => a.methode === "demanderAutorisation").length;

beforeEach(() => demarrer(false));
afterEach(async () => {
  await client.close();
  await serveur.arreter();
});

test("genererJeton : 64 caractères hexadécimaux, différents à chaque appel", () => {
  expect(genererJeton()).toMatch(/^[0-9a-f]{64}$/);
  expect(genererJeton()).not.toBe(genererJeton());
});

test("urlConteneur passe par host.docker.internal", () => {
  expect(serveur.urlConteneur).toBe(`http://host.docker.internal:${serveur.port}/mcp`);
});

test("sans jeton ou avec un mauvais jeton → 401", async () => {
  const url = `http://127.0.0.1:${serveur.port}/mcp`;
  const corps = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const entetes = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  expect((await fetch(url, { method: "POST", headers: entetes, body: corps })).status).toBe(401);
  expect(
    (await fetch(url, { method: "POST", headers: { ...entetes, Authorization: "Bearer faux" }, body: corps })).status,
  ).toBe(401);
});

test("liste exactement les 6 outils", async () => {
  expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
    "capture_ecran", "lire_onglet", "lister_onglets", "naviguer", "ouvrir_onglet", "page_courante",
  ]);
});

test("page_courante après interaction → contenu, sans demande d'autorisation", async () => {
  politique.interactionUtilisateur(github);
  const r = await client.callTool({ name: "page_courante", arguments: {} });
  expect(texte(r)).toContain("https://github.com/sveltejs/svelte");
  expect(texte(r)).toContain("Texte de sveltejs/svelte");
  expect(demandes()).toBe(0);
});

test("page_courante sans interaction → demande, refus → réponse normale", async () => {
  const r = await client.callTool({ name: "page_courante", arguments: {} });
  expect(r.isError).toBeFalsy();
  expect(texte(r)).toBe("Accès refusé par l'utilisateur à cet onglet.");
  expect(demandes()).toBe(1);
});

test("lire_onglet sur Gmail : demande, refus → réponse normale", async () => {
  const r = await client.callTool({ name: "lire_onglet", arguments: { id: "gmail" } });
  expect(r.isError).toBeFalsy();
  expect(texte(r)).toBe("Accès refusé par l'utilisateur à cet onglet.");
  expect(pont.appels.some((a) => a.methode === "lireTexte")).toBe(false);
});

test("demande acceptée → accès mémorisé (pas de seconde demande)", async () => {
  await client.close();
  await serveur.arreter();
  await demarrer(true);
  expect(texte(await client.callTool({ name: "lire_onglet", arguments: { id: "gmail" } }))).toContain("Texte de Gmail");
  await client.callTool({ name: "lire_onglet", arguments: { id: "gmail" } });
  expect(demandes()).toBe(1);
});

test("lister_onglets masque les onglets inaccessibles", async () => {
  politique.interactionUtilisateur(github);
  const t = texte(await client.callTool({ name: "lister_onglets", arguments: {} }));
  expect(t).toContain("github · sveltejs/svelte · https://github.com/sveltejs/svelte · perso");
  expect(t).toContain("gmail · onglet privé ·  · perso");
  expect(t).not.toContain("mail.google.com");
  expect(t).not.toContain("Boîte de réception");
});

test("ouvrir_onglet puis lire_onglet sur cet onglet → pas de demande", async () => {
  const id = texte(await client.callTool({ name: "ouvrir_onglet", arguments: { url: "http://localhost:5170" } }));
  expect(pont.appels.at(-1)).toEqual({ methode: "ouvrirOnglet", args: ["http://localhost:5170", undefined] });
  const r = await client.callTool({ name: "lire_onglet", arguments: { id: id.trim() } });
  expect(texte(r)).toContain("localhost:5170");
  expect(demandes()).toBe(0);
});

test("naviguer et capture_ecran exigent l'accès", async () => {
  const refus = await client.callTool({ name: "naviguer", arguments: { id: "gmail", url: "https://evil.test" } });
  expect(texte(refus)).toBe("Accès refusé par l'utilisateur à cet onglet.");
  expect(pont.appels.some((a) => a.methode === "naviguer")).toBe(false);
  politique.interactionUtilisateur(github);
  const img = await client.callTool({ name: "capture_ecran", arguments: { id: "github" } });
  expect((img.content as { type: string }[])[0]!.type).toBe("image");
});

test("id inconnu → isError, serveur toujours fonctionnel", async () => {
  const r = await client.callTool({ name: "lire_onglet", arguments: { id: "nope" } });
  expect(r.isError).toBe(true);
  expect(texte(r)).toBe("Onglet introuvable : nope");
  expect((await client.callTool({ name: "lister_onglets", arguments: {} })).isError).toBeFalsy();
});

test("ouvrir_onglet et naviguer refusent les URL non http(s)", async () => {
  expect((await client.callTool({ name: "ouvrir_onglet", arguments: { url: "file:///etc/passwd" } })).isError).toBe(true);
  politique.interactionUtilisateur(github);
  expect(
    (await client.callTool({ name: "naviguer", arguments: { id: "github", url: "javascript:alert(1)" } })).isError,
  ).toBe(true);
  expect(pont.appels.some((a) => a.methode === "ouvrirOnglet" || a.methode === "naviguer")).toBe(false);
});

test("sans onglet actif → Aucun onglet actif.", async () => {
  await client.close();
  await serveur.arreter();
  pont = new PontFactice([], { actif: null, autoriser: true });
  serveur = await demarrerServeurMcp({ pont, politique: new PolitiqueAcces(), jeton });
  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${serveur.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${jeton}` } },
    }),
  );
  expect(texte(await client.callTool({ name: "page_courante", arguments: {} }))).toBe("Aucun onglet actif.");
});
