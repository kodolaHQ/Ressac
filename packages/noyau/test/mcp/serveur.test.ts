import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PolitiqueAcces } from "../../src/acces/politique.js";
import { TEXTE_PRIVE, type OngletInfo } from "../../src/mcp/pont.js";
import { PontFactice } from "../../src/mcp/pont-factice.js";
import { demarrerServeurMcp, genererJeton, type OutilsApplications } from "../../src/mcp/serveur.js";
import type { Application } from "../../src/applications/gestionnaire.js";

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
  expect(t).toContain("gmail · onglet non partagé ·  · perso");
  expect(t).not.toContain("mail.google.com");
  expect(t).not.toContain("Boîte de réception");
});

test("espace privé : l'onglet est absent de lister_onglets, avec son espace", async () => {
  pont.rendrePrive("gmail", "secret");
  const t = texte(await client.callTool({ name: "lister_onglets", arguments: {} }));
  expect(t).not.toContain("gmail");
  expect(t).not.toContain("secret");
  expect(t).toContain("github · onglet non partagé");
});

test("espace privé : lire_onglet, capture_ecran et naviguer répondent TEXTE_PRIVE, sans demande ni appel au pont", async () => {
  pont.rendrePrive("gmail");
  for (const [name, args] of [
    ["lire_onglet", { id: "gmail" }],
    ["capture_ecran", { id: "gmail" }],
    ["naviguer", { id: "gmail", url: "https://exemple.test" }],
  ] as const) {
    const r = await client.callTool({ name, arguments: args });
    expect(texte(r)).toBe(TEXTE_PRIVE);
    expect(r.isError).toBeFalsy();
  }
  expect(TEXTE_PRIVE).toBe("Cet onglet est dans un espace privé : l'agent n'y a pas accès.");
  expect(demandes()).toBe(0);
  expect(pont.appels.some((a) => ["lireTexte", "capturer", "naviguer"].includes(a.methode))).toBe(false);
});

test("espace privé : même un accès accordé avant ne lit plus l'onglet", async () => {
  politique.interactionUtilisateur(gmail);
  pont.rendrePrive("gmail");
  expect(texte(await client.callTool({ name: "lire_onglet", arguments: { id: "gmail" } }))).toBe(TEXTE_PRIVE);
});

test("espace privé : page_courante sur l'onglet actif privé répond TEXTE_PRIVE, sans demande", async () => {
  politique.interactionUtilisateur(github);
  pont.rendrePrive("github");
  const r = await client.callTool({ name: "page_courante", arguments: {} });
  expect(texte(r)).toBe(TEXTE_PRIVE);
  expect(r.isError).toBeFalsy();
  expect(demandes()).toBe(0);
});

test("espace privé pendant la question : « Autoriser » ne livre pas l'onglet", async () => {
  pont.demanderAutorisation = async (o) => {
    pont.appels.push({ methode: "demanderAutorisation", args: [o.id] });
    pont.rendrePrive("gmail");
    return true;
  };
  expect(texte(await client.callTool({ name: "lire_onglet", arguments: { id: "gmail" } }))).toBe(TEXTE_PRIVE);
  expect(pont.appels.some((a) => a.methode === "lireTexte")).toBe(false);
});

test("ouvrir_onglet puis lire_onglet sur cet onglet → pas de demande", async () => {
  const id = texte(await client.callTool({ name: "ouvrir_onglet", arguments: { url: "http://localhost:5280" } }));
  expect(pont.appels.at(-1)).toEqual({ methode: "ouvrirOnglet", args: ["http://localhost:5280", undefined] });
  const r = await client.callTool({ name: "lire_onglet", arguments: { id: id.trim() } });
  expect(texte(r)).toContain("localhost:5280");
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

test("ouvrir_onglet sur un site extérieur puis lire_onglet → demande d'autorisation", async () => {
  const id = texte(await client.callTool({ name: "ouvrir_onglet", arguments: { url: "https://mail.google.com" } })).trim();
  const r = await client.callTool({ name: "lire_onglet", arguments: { id } });
  expect(texte(r)).toBe("Accès refusé par l'utilisateur à cet onglet.");
  expect(demandes()).toBe(1);
});

test("deux lectures simultanées d'un onglet privé → une seule demande", async () => {
  let liberer!: (v: boolean) => void;
  pont.demanderAutorisation = async (o) => {
    pont.appels.push({ methode: "demanderAutorisation", args: [o.id] });
    return new Promise<boolean>((ok) => (liberer = ok));
  };
  const a = client.callTool({ name: "lire_onglet", arguments: { id: "gmail" } });
  const b = client.callTool({ name: "lire_onglet", arguments: { id: "gmail" } });
  await new Promise((r) => setTimeout(r, 100));
  liberer(true);
  const [ra, rb] = await Promise.all([a, b]);
  expect(texte(ra)).toContain("Texte de Gmail");
  expect(texte(rb)).toContain("Texte de Gmail");
  expect(demandes()).toBe(1);
});

test("la navigation du navigateur pendant naviguer (did-navigate) ne retire pas l'accès à la démo", async () => {
  const id = texte(await client.callTool({ name: "ouvrir_onglet", arguments: { url: "http://localhost:5280" } })).trim();
  const naviguerOrigine = pont.naviguer.bind(pont);
  pont.naviguer = async (i, url) => {
    politique.ongletNavigue(i, url); // Electron signale la navigation avant que naviguer() ne se termine
    await naviguerOrigine(i, url);
  };
  await client.callTool({ name: "naviguer", arguments: { id, url: "http://localhost:5281" } });
  const r = await client.callTool({ name: "lire_onglet", arguments: { id } });
  expect(texte(r)).toContain("localhost:5281");
  expect(demandes()).toBe(0);
});

test("onglet passé à un autre site pendant la question : « Autoriser » ne livre pas le nouveau site", async () => {
  await client.close();
  await serveur.arreter();
  await demarrer(true);
  const demander = pont.demanderAutorisation.bind(pont);
  pont.demanderAutorisation = async (o) => {
    await pont.naviguer("gmail", "https://banque.example/comptes"); // L'utilisateur change de site avant de répondre
    return demander(o);
  };
  const r = await client.callTool({ name: "lire_onglet", arguments: { id: "gmail" } });
  expect(texte(r)).toBe("Accès refusé par l'utilisateur à cet onglet.");
  expect(pont.appels.some((a) => a.methode === "lireTexte")).toBe(false);
});

// --- Outils des applications ---

const appTodo: OngletInfo = { id: "app:todo", titre: "Todo", url: "http://localhost:5280/", espace: "perso", application: "todo" };

function appFactice(r: Partial<Application>, appels: string[] = []): OutilsApplications {
  return {
    lancer: async (d) => (appels.push(`lancer ${d}`), { dossier: d, nom: d, type: "application", creeLe: "", etat: "en-marche", ...r }),
    arreter: async (d) => void appels.push(`arreter ${d}`),
    journal: async (d) => (appels.push(`journal ${d}`), "ligne 1\nligne 2"),
  };
}

/** Relance le serveur avec des outils d'applications et un pont donné. */
async function avecApplications(applications: OutilsApplications, onglets: OngletInfo[], delaiOngletAppMs = 100) {
  await client.close();
  await serveur.arreter();
  pont = new PontFactice(onglets, { actif: null, autoriser: false });
  politique = new PolitiqueAcces();
  serveur = await demarrerServeurMcp({ pont, politique, jeton, applications, delaiOngletAppMs });
  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${serveur.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${jeton}` } },
    }),
  );
}

test("lancer_application : port et onglet, accès accordé", async () => {
  await avecApplications(appFactice({ etat: "en-marche", port: 5280 }), [appTodo]);
  const r = await client.callTool({ name: "lancer_application", arguments: { dossier: "todo" } });
  expect(texte(r)).toBe("Application todo en marche sur http://localhost:5280 (onglet app:todo).");
  expect(texte(await client.callTool({ name: "lire_onglet", arguments: { id: "app:todo" } }))).toContain("Texte de Todo");
  expect(demandes()).toBe(0);
});

test("lancer_application : sans onglet après le délai, texte sans onglet et aucun accès accordé", async () => {
  await avecApplications(appFactice({ etat: "en-marche", port: 5280 }), [], 50);
  const r = await client.callTool({ name: "lancer_application", arguments: { dossier: "todo" } });
  expect(texte(r)).toBe("Application todo en marche sur http://localhost:5280.");
  expect(r.isError).toBeFalsy();
});

test("lancer_application : relance sur un autre port, l'accès vise le nouveau port, pas l'ancien encore affiché", async () => {
  await avecApplications(appFactice({ etat: "en-marche", port: 5281 }), [appTodo], 2000);
  // La fenêtre existe déjà, sur l'ancien port (5280), et ne se recharge qu'au troisième coup d'œil.
  let vues = 0;
  const nouvelle = { ...appTodo, url: "http://localhost:5281/" };
  vi.spyOn(pont, "listerOnglets").mockImplementation(async () => (++vues < 3 ? [appTodo] : [nouvelle]));
  const r = await client.callTool({ name: "lancer_application", arguments: { dossier: "todo" } });
  expect(texte(r)).toBe("Application todo en marche sur http://localhost:5281 (onglet app:todo).");
  vues = 10; // rechargée sur le nouveau port, quoi qu'il arrive
  expect(texte(await client.callTool({ name: "lire_onglet", arguments: { id: "app:todo" } }))).toContain("Texte de Todo");
  expect(demandes()).toBe(0);
});

test("lancer_application : fenêtre restée sur l'ancien port après le délai, aucun accès accordé", async () => {
  await avecApplications(appFactice({ etat: "en-marche", port: 5281 }), [appTodo], 50);
  const r = await client.callTool({ name: "lancer_application", arguments: { dossier: "todo" } });
  expect(texte(r)).toBe("Application todo en marche sur http://localhost:5281.");
  expect(texte(await client.callTool({ name: "lire_onglet", arguments: { id: "app:todo" } }))).toBe("Accès refusé par l'utilisateur à cet onglet.");
});

test("naviguer une fenêtre d'appli vers un autre site : onglet ouvert, la fenêtre et son accès restent", async () => {
  await avecApplications(appFactice({ etat: "en-marche", port: 5280 }), [appTodo]);
  await client.callTool({ name: "lancer_application", arguments: { dossier: "todo" } });
  const r = await client.callTool({ name: "naviguer", arguments: { id: "app:todo", url: "https://exemple.test/" } });
  const ouvert = pont.appels.find((a) => a.methode === "ouvrirOnglet");
  expect(ouvert?.args[0]).toBe("https://exemple.test/");
  expect(pont.appels.some((a) => a.methode === "naviguer")).toBe(false);
  expect(texte(r)).toMatch(/^L'application ne quitte pas son adresse : https:\/\/exemple\.test\/ ouvert dans l'onglet \S+\.$/);
  expect(texte(await client.callTool({ name: "lire_onglet", arguments: { id: "app:todo" } }))).toContain("Texte de Todo");
  // Sur sa propre origine, la fenêtre navigue.
  await client.callTool({ name: "naviguer", arguments: { id: "app:todo", url: "http://localhost:5280/autre" } });
  expect(pont.appels.find((a) => a.methode === "naviguer")?.args).toEqual(["app:todo", "http://localhost:5280/autre"]);
  expect(demandes()).toBe(0);
});

test("lancer_application en erreur : texte d'erreur et journal, erreur: true", async () => {
  await avecApplications(appFactice({ etat: "erreur", erreur: "port occupé" }), []);
  const r = await client.callTool({ name: "lancer_application", arguments: { dossier: "todo" } });
  expect(r.isError).toBe(true);
  expect(texte(r)).toBe("Application todo en erreur : port occupé");
});

test("arreter_application", async () => {
  const appels: string[] = [];
  await avecApplications(appFactice({}, appels), []);
  expect(texte(await client.callTool({ name: "arreter_application", arguments: { dossier: "todo" } }))).toBe("Application todo arrêtée.");
  expect(appels).toEqual(["arreter todo"]);
});

test("journal_application", async () => {
  await avecApplications(appFactice({}), []);
  expect(texte(await client.callTool({ name: "journal_application", arguments: { dossier: "todo" } }))).toBe("ligne 1\nligne 2");
  await avecApplications({ ...appFactice({}), journal: async () => "" }, []);
  expect(texte(await client.callTool({ name: "journal_application", arguments: { dossier: "todo" } }))).toBe("Journal vide.");
});

test("sans applications : les outils n'existent pas", async () => {
  const noms = (await client.listTools()).tools.map((t) => t.name);
  expect(noms).not.toContain("lancer_application");
  expect(noms).not.toContain("arreter_application");
  expect(noms).not.toContain("journal_application");
});
