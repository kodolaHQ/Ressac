import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Application } from "../applications/gestionnaire.js";
import type { DroitDev, PolitiqueAcces } from "../acces/politique.js";
import { enregistrerOutilsDev, type FichiersProfils } from "./outils-dev.js";
import { OngletIntrouvable, type OngletInfo, type OutilsDevNavigateur, type PontNavigateur } from "./pont.js";

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

function origineDe(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Ce que le noyau fournit pour piloter les applications (le gestionnaire, côté navigateur). */
export interface OutilsApplications {
  lancer(dossier: string): Promise<Application>;
  arreter(dossier: string): Promise<void>;
  journal(dossier: string): Promise<string>;
}

/** Temps laissé à la fenêtre d'une application pour apparaître après le lancement. */
const DELAI_ONGLET_APP_MS = 5000;

/** Demandes d'autorisation en attente, par onglet : partagées entre requêtes pour ne poser la question qu'une fois. */
type DemandesEnCours = Map<string, Promise<boolean>>;

/** Agent affiché sur la carte de consentement, profils bruts et demandes en cours des outils de développement. */
interface OptionsOutilsDev {
  agent: string;
  /** Outils de développement réservés à ce noyau ; à défaut, ceux du pont. */
  outils?: OutilsDevNavigateur;
  profils: FichiersProfils;
  demandes: Map<string, Promise<DroitDev[]>>;
}

const PROFILS_ABSENTS: FichiersProfils = {
  ecrireProfil: () => Promise.reject(new Error("Enregistrement des profils indisponible.")),
  lireProfil: () => Promise.reject(new Error("Lecture des profils indisponible.")),
  supprimerProfil: () => Promise.resolve(),
};

function creerServeurOutils(
  pont: PontNavigateur,
  politique: PolitiqueAcces,
  demandes: DemandesEnCours,
  applications?: OutilsApplications,
  delaiOngletAppMs = DELAI_ONGLET_APP_MS,
  dev?: OptionsOutilsDev,
): McpServer {
  const serveur = new McpServer({ name: "webaios", version: "0.1.0" });

  async function onglet(id: string): Promise<OngletInfo> {
    const o = (await pont.listerOnglets()).find((x) => x.id === id);
    if (!o) throw new OngletIntrouvable(id);
    return o;
  }

  /** Vérifie l'accès ; à défaut, demande à l'utilisateur et mémorise un oui. */
  async function acces(o: OngletInfo): Promise<boolean> {
    if (politique.peutLire(o)) return true;
    let demande = demandes.get(o.id);
    if (!demande) {
      demande = pont
        .demanderAutorisation(o)
        .then((oui) => {
          if (oui) politique.accorder(o);
          return oui;
        })
        .finally(() => demandes.delete(o.id));
      demandes.set(o.id, demande);
    }
    if (!(await demande)) return false;
    // L'utilisateur a pu changer de site pendant la question : son accord porte sur le site qu'il a vu.
    return politique.peutLire(await onglet(o.id));
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
      description: "Ouvre un onglet (par exemple une démo http://localhost:5280) et renvoie son id.",
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
      const o = await onglet(id);
      if (!(await acces(o))) return texte(TEXTE_REFUS);
      // La fenêtre d'une appli ne quitte jamais son origine (elle n'a pas de barre d'adresse) : un autre site s'ouvre
      // dans un onglet, comme avec ouvrir_onglet, et l'agent garde l'accès à la fenêtre.
      if (o.application && origineDe(url) !== origineDe(o.url)) {
        const nouveau = await pont.ouvrirOnglet(url);
        politique.ongletOuvertParAgent(nouveau);
        return texte(`L'application ne quitte pas son adresse : ${url} ouvert dans l'onglet ${nouveau.id}.`);
      }
      // Avant pont.naviguer : le navigateur peut signaler la navigation (ongletNavigue) avant qu'elle
      // ne se termine, et l'agent ne doit pas perdre l'accès à sa propre démo.
      politique.navigationParAgent(id, url);
      await pont.naviguer(id, url);
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

  if (applications) {
    const dossier = z.string();
    serveur.registerTool(
      "lancer_application",
      {
        description: "Lance le projet /workspace/projets/<dossier> d'après son webaios.json et ouvre sa fenêtre pour l'utilisateur.",
        inputSchema: { dossier },
      },
      proteger(async ({ dossier }) => {
        const app = await applications.lancer(dossier);
        if (app.etat === "erreur") return texte(`Application ${dossier} en erreur : ${app.erreur ?? "inconnue"}`, true);
        const url = `http://localhost:${app.port}`;
        // La fenêtre s'ouvre juste après le lancement : on l'attend un peu, sans bloquer si elle ne vient pas. Relancée sur
        // un autre port, elle montre encore l'ancien le temps de se recharger : l'accès ne vise que le nouveau.
        const surLePort = (o: OngletInfo) => origineDe(o.url) === url;
        const fin = Date.now() + delaiOngletAppMs;
        let fenetre: OngletInfo | undefined;
        for (;;) {
          fenetre = (await pont.listerOnglets()).find((x) => x.application === dossier && surLePort(x));
          if (fenetre || Date.now() >= fin) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        if (!fenetre) return texte(`Application ${dossier} en marche sur ${url}.`);
        politique.ongletOuvertParAgent(fenetre);
        return texte(`Application ${dossier} en marche sur ${url} (onglet ${fenetre.id}).`);
      }),
    );

    serveur.registerTool(
      "arreter_application",
      { description: "Arrête une application lancée par lancer_application.", inputSchema: { dossier } },
      proteger(async ({ dossier }) => {
        await applications.arreter(dossier);
        return texte(`Application ${dossier} arrêtée.`);
      }),
    );

    serveur.registerTool(
      "journal_application",
      { description: "Journal d'une application : à lire quand elle est en erreur.", inputSchema: { dossier } },
      proteger(async ({ dossier }) => texte((await applications.journal(dossier)) || "Journal vide.")),
    );
  }

  if (pont.outilsDev && dev) {
    enregistrerOutilsDev(serveur, {
      pont,
      politique,
      agent: dev.agent,
      demandes: dev.demandes,
      ...(dev.outils ? { outils: dev.outils } : {}),
      ...dev.profils,
    });
  }

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
  applications?: OutilsApplications;
  /** Attente de la fenêtre d'une application après son lancement (réglable pour les tests). */
  delaiOngletAppMs?: number;
  /** Nom de l'agent, affiché sur la carte de consentement des outils de développement. */
  agent?: string;
  /** Écriture et lecture des profils bruts des outils de développement. */
  profils?: FichiersProfils;
  /** Outils de développement réservés à ce noyau (voir OutilsDevNavigateur.proprietaire). */
  outilsDev?: OutilsDevNavigateur;
}): Promise<{ port: number; urlConteneur: string; arreter(): Promise<void> }> {
  const attendu = Buffer.from(o.jeton);
  const demandes: DemandesEnCours = new Map();
  const dev: OptionsOutilsDev = {
    agent: o.agent ?? "L'agent",
    profils: o.profils ?? PROFILS_ABSENTS,
    demandes: new Map(),
    ...(o.outilsDev ? { outils: o.outilsDev } : {}),
  };

  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!jetonValide(req, attendu)) return res.writeHead(401).end();
    if (new URL(req.url ?? "/", "http://x").pathname !== "/mcp") return res.writeHead(404).end();
    // Mode sans état : un serveur et un transport neufs par requête.
    const serveur = creerServeurOutils(o.pont, o.politique, demandes, o.applications, o.delaiOngletAppMs, dev);
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
