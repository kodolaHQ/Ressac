import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { PolitiqueAcces } from "../acces/politique.js";
import { OngletIntrouvable, type OngletInfo, type PontNavigateur } from "./pont.js";

export const TEXTE_REFUS = "Accès refusé par l'utilisateur à cet onglet.";
const LIBELLE_PRIVE = "onglet privé";

export function genererJeton(): string {
  return randomBytes(32).toString("hex");
}

type Resultat = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean };
const texte = (text: string, isError = false): Resultat => ({ content: [{ type: "text", text }], ...(isError ? { isError } : {}) });

function urlWeb(url: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function creerServeurOutils(pont: PontNavigateur, politique: PolitiqueAcces): McpServer {
  const serveur = new McpServer({ name: "webaios", version: "0.1.0" });

  async function onglet(id: string): Promise<OngletInfo> {
    const o = (await pont.listerOnglets()).find((x) => x.id === id);
    if (!o) throw new OngletIntrouvable(id);
    return o;
  }

  /** Vérifie l'accès ; à défaut, demande à l'utilisateur et mémorise un oui. */
  async function acces(o: OngletInfo): Promise<boolean> {
    if (politique.peutLire(o)) return true;
    if (!(await pont.demanderAutorisation(o))) return false;
    politique.accorder(o);
    return true;
  }

  async function contenu(o: OngletInfo): Promise<Resultat> {
    if (!(await acces(o))) return texte(TEXTE_REFUS);
    const { texte: corps, selection } = await pont.lireTexte(o.id);
    return texte([`Titre : ${o.titre}`, `URL : ${o.url}`, ...(selection ? [`Sélection : ${selection}`] : []), "", corps].join("\n"));
  }

  /** Transforme une erreur de pont en erreur d'outil lisible plutôt qu'en plantage. */
  const proteger =
    <A>(f: (a: A) => Promise<Resultat>) =>
    async (a: A): Promise<Resultat> => {
      try {
        return await f(a);
      } catch (e) {
        return texte(e instanceof OngletIntrouvable ? e.message : `Erreur : ${(e as Error).message}`, true);
      }
    };

  serveur.registerTool(
    "page_courante",
    { description: "URL, titre, texte principal et sélection de l'onglet que l'utilisateur regarde." },
    proteger(async () => {
      const o = await pont.ongletActif();
      return o ? contenu(o) : texte("Aucun onglet actif.");
    }),
  );

  serveur.registerTool(
    "lister_onglets",
    { description: "Onglets ouverts : id · titre · url · espace. Un onglet non partagé apparaît comme « onglet privé »." },
    proteger(async () => {
      const lignes = (await pont.listerOnglets()).map((o) =>
        politique.peutLire(o)
          ? `${o.id} · ${o.titre} · ${o.url} · ${o.espace}`
          : `${o.id} · ${LIBELLE_PRIVE} ·  · ${o.espace}`,
      );
      return texte(lignes.join("\n") || "Aucun onglet ouvert.");
    }),
  );

  serveur.registerTool(
    "lire_onglet",
    { description: "Texte principal d'un onglet donné.", inputSchema: { id: z.string() } },
    proteger(async ({ id }) => contenu(await onglet(id))),
  );

  serveur.registerTool(
    "ouvrir_onglet",
    {
      description: "Ouvre un onglet (par exemple une démo http://localhost:5170) et renvoie son id.",
      inputSchema: { url: z.string(), espace: z.string().optional() },
    },
    proteger(async ({ url, espace }) => {
      if (!urlWeb(url)) return texte(`URL refusée (http ou https uniquement) : ${url}`, true);
      const o = await pont.ouvrirOnglet(url, espace);
      politique.ongletOuvertParAgent(o);
      return texte(o.id);
    }),
  );

  serveur.registerTool(
    "naviguer",
    { description: "Change l'URL d'un onglet, ou recharge une démo.", inputSchema: { id: z.string(), url: z.string() } },
    proteger(async ({ id, url }) => {
      if (!urlWeb(url)) return texte(`URL refusée (http ou https uniquement) : ${url}`, true);
      if (!(await acces(await onglet(id)))) return texte(TEXTE_REFUS);
      await pont.naviguer(id, url);
      politique.navigationParAgent(id, url);
      return texte(`Onglet ${id} → ${url}`);
    }),
  );

  serveur.registerTool(
    "capture_ecran",
    { description: "Capture d'écran PNG d'un onglet.", inputSchema: { id: z.string() } },
    proteger(async ({ id }) => {
      if (!(await acces(await onglet(id)))) return texte(TEXTE_REFUS);
      const png = await pont.capturer(id);
      return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
    }),
  );

  return serveur;
}

function jetonValide(req: IncomingMessage, attendu: Buffer): boolean {
  const recu = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /, ""));
  return recu.length === attendu.length && timingSafeEqual(recu, attendu);
}

export async function demarrerServeurMcp(o: {
  pont: PontNavigateur;
  politique: PolitiqueAcces;
  jeton: string;
  hote?: string;
  port?: number;
}): Promise<{ port: number; urlConteneur: string; arreter(): Promise<void> }> {
  const attendu = Buffer.from(o.jeton);

  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!jetonValide(req, attendu)) return res.writeHead(401).end();
    if (new URL(req.url ?? "/", "http://x").pathname !== "/mcp") return res.writeHead(404).end();
    // Mode sans état : un serveur et un transport neufs par requête.
    const serveur = creerServeurOutils(o.pont, o.politique);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void serveur.close();
    });
    try {
      await serveur.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  await new Promise<void>((ok, ko) => {
    http.once("error", ko);
    http.listen(o.port ?? 0, o.hote ?? "127.0.0.1", ok);
  });
  const port = (http.address() as AddressInfo).port;
  return {
    port,
    urlConteneur: `http://host.docker.internal:${port}/mcp`,
    arreter: () =>
      new Promise<void>((ok) => {
        http.closeAllConnections();
        http.close(() => ok());
      }),
  };
}
