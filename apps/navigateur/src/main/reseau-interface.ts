import type { Session } from "electron";
import { createServer, type Server } from "node:net";
import { SCHEMA_ICONE, urlIcone } from "../commun/icone";

/**
 * La session de l'interface (pages des fenêtres, pastilles, et donc les affichages des widgets, qui en sont des cadres)
 * ne sort jamais sur le réseau : tout passe par un « proxy » local qui ferme chaque connexion. Filet sous la CSP et le
 * preload des widgets : même un WebRTC qui leur échapperait (TURN en TCP, qui ignore la CSP) n'atteint aucun serveur,
 * ni ne fait résoudre un nom. Les favicons, seule chose que l'interface chargeait du web, passent par `webaios-icone:`.
 *
 * `<-loopback>` retire l'exception implicite de Chromium pour 127.0.0.1 et localhost ; seul le serveur de développement
 * de l'interface (electron-vite) reste joignable, à son adresse exacte.
 */
export function reglesContournement(urlDev: string | undefined): string {
  const regles = ["<-loopback>"];
  if (urlDev) {
    try {
      const u = new URL(urlDev);
      if (u.port) regles.push(`${u.hostname}:${u.port}`);
    } catch {
      // adresse de développement illisible : rien n'est contourné
    }
  }
  return regles.join(";");
}

/** Écoute sur 127.0.0.1 et ferme toute connexion sans rien lire : rien de ce qui y arrive ne va plus loin. */
export async function trouNoir(): Promise<{ port: number; fermer(): void }> {
  const serveur: Server = createServer((s) => s.destroy());
  serveur.on("error", (e) => console.error("[webaios] filet réseau de l'interface :", e));
  await new Promise<void>((ok, ko) => {
    serveur.once("error", ko);
    serveur.listen(0, "127.0.0.1", () => ok());
  });
  serveur.unref();
  const adresse = serveur.address();
  if (!adresse || typeof adresse === "string") throw new Error("adresse du filet réseau illisible");
  return { port: adresse.port, fermer: () => serveur.close() };
}

/** Coupe le réseau de la session de l'interface ; à attendre avant d'ouvrir une fenêtre. */
export async function couperReseauInterface(s: Session, urlDev: string | undefined): Promise<void> {
  const { port } = await trouNoir();
  await s.setProxy({ mode: "fixed_servers", proxyRules: `http://127.0.0.1:${port}`, proxyBypassRules: reglesContournement(urlDev) });
}

export { SCHEMA_ICONE, urlIcone };
/** Taille au plus d'un favicon servi à l'interface. */
const TAILLE_ICONE = 512 * 1024;


/** Le favicon demandé par une URL `webaios-icone:`, http(s) seulement ; null sinon. */
export function cibleIcone(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${SCHEMA_ICONE}:`) return null;
  const cible = u.searchParams.get("u");
  if (!cible || !/^https?:\/\//i.test(cible)) return null;
  try {
    new URL(cible);
  } catch {
    return null;
  }
  return cible;
}

type Chercher = (url: string, init: { signal: AbortSignal; credentials: "omit" }) => Promise<Response>;

/**
 * Répond à une URL `webaios-icone:` en allant chercher le favicon hors de la session de l'interface (`chercher` : une
 * session à part, sans cookies du profil), comme l'interface le faisait elle-même avant : le site voit l'adresse IP de
 * L'utilisateur, rien d'autre. L'interface ne s'en sert que dans un <img> : un contenu qui n'est pas une image n'y affiche rien.
 */
export async function repondreIcone(chercher: Chercher, url: string): Promise<Response> {
  const cible = cibleIcone(url);
  if (!cible) return new Response("", { status: 404 });
  const arret = new AbortController();
  const minuterie = setTimeout(() => arret.abort(), 5000);
  try {
    const r = await chercher(cible, { signal: arret.signal, credentials: "omit" });
    const type = r.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!r.ok || !r.body) return new Response("", { status: 404 });
    const morceaux: Uint8Array[] = [];
    let taille = 0;
    const lecteur = r.body.getReader();
    for (;;) {
      const { done, value } = await lecteur.read();
      if (done) break;
      taille += value.length;
      if (taille > TAILLE_ICONE) {
        await lecteur.cancel().catch(() => {});
        return new Response("", { status: 404 });
      }
      morceaux.push(value);
    }
    return new Response(Buffer.concat(morceaux), {
      headers: { "Content-Type": type.startsWith("image/") ? type : "application/octet-stream" },
    });
  } catch {
    return new Response("", { status: 404 });
  } finally {
    clearTimeout(minuterie);
  }
}
