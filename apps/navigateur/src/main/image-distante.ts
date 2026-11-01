import { net, type Session } from "electron";

/** Redirections suivies au plus pour une image, chacune revérifiée avant d'être suivie. */
export const REDIRECTIONS_IMAGE = 3;
const DELAI_IMAGE_MS = 10_000;
/** Un type d'image simple (`image/png`) ; un type composé n'est jamais recopié. */
const TYPE_IMAGE = /^image\/[a-z0-9.+-]+$/;

/** Ce que `chargerImage` attend d'une requête (`net.ClientRequest` d'Electron). */
export interface RequeteImage {
  on(evenement: "redirect", rappel: (statut: number, methode: string, vers: string) => void): unknown;
  on(evenement: "response", rappel: (r: ReponseImage) => void): unknown;
  on(evenement: "error" | "abort", rappel: () => void): unknown;
  followRedirect(): void;
  abort(): void;
  end(): void;
}
export interface ReponseImage {
  statusCode: number;
  headers: Record<string, string | string[]>;
  on(evenement: "data", rappel: (morceau: Buffer) => void): unknown;
  on(evenement: "end" | "error" | "aborted", rappel: () => void): unknown;
}
/** Ouvre une requête GET vers `url`, sans suivre les redirections ; `cookies` : ceux de la session sont envoyés. */
export type OuvrirRequete = (url: string, o: { cookies: boolean }) => RequeteImage;
export type ImageLue = { type: string; corps: Buffer };

/**
 * Les requêtes d'une session, redirections en mode « manual » : `session.fetch` rejette à la première redirection dans
 * ce mode (Electron 45), `net.request` émet `redirect`, et la redirection n'est suivie que si `followRedirect` est
 * appelé pendant l'événement.
 */
export function requetesDe(s: Session): OuvrirRequete {
  return (url, o) => net.request({ url, session: s, redirect: "manual", credentials: o.cookies ? "include" : "omit", useSessionCookies: o.cookies }) as unknown as RequeteImage;
}

const premier = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Une image distante : `url` et chaque redirection doivent être `permise` (vérifiée avant de la suivre, sinon la requête
 * est abandonnée), `REDIRECTIONS_IMAGE` au plus ; réponse 2xx `image/<simple>`, `max` octets au plus (annoncés ou lus),
 * en `DELAI_IMAGE_MS`. null sinon.
 */
export function chargerImage(ouvrir: OuvrirRequete, url: string, o: { permise: (url: string) => boolean; cookies: boolean; max: number }): Promise<ImageLue | null> {
  if (!o.permise(url)) return Promise.resolve(null);
  return new Promise((rendre) => {
    let fini = false;
    let sauts = 0;
    let actuelle = url;
    let requete: RequeteImage | undefined;
    const finir = (v: ImageLue | null) => {
      if (fini) return;
      fini = true;
      clearTimeout(minuterie);
      if (v === null)
        try {
          requete?.abort();
        } catch {
          // déjà terminée
        }
      rendre(v);
    };
    const minuterie = setTimeout(() => finir(null), DELAI_IMAGE_MS);
    try {
      requete = ouvrir(url, { cookies: o.cookies });
      requete.on("redirect", (_statut, _methode, vers) => {
        if (fini) return;
        let suivante: string;
        try {
          suivante = new URL(vers, actuelle).href;
        } catch {
          return finir(null);
        }
        // Une page hostile pourrait rediriger vers un tiers, la machine ou le réseau local : vérifiée avant d'y aller.
        if (sauts >= REDIRECTIONS_IMAGE || !o.permise(suivante)) return finir(null);
        sauts++;
        actuelle = suivante;
        requete!.followRedirect();
      });
      requete.on("response", (r) => {
        if (fini) return;
        const type = premier(r.headers["content-type"])?.split(";")[0]?.trim().toLowerCase() ?? "";
        if (r.statusCode < 200 || r.statusCode >= 300 || !TYPE_IMAGE.test(type) || Number(premier(r.headers["content-length"]) ?? 0) > o.max) return finir(null);
        const morceaux: Buffer[] = [];
        let taille = 0;
        r.on("data", (m) => {
          if (fini) return;
          taille += m.length;
          if (taille > o.max) return finir(null);
          morceaux.push(m);
        });
        r.on("end", () => finir({ type, corps: Buffer.concat(morceaux) }));
        r.on("error", () => finir(null));
        r.on("aborted", () => finir(null));
      });
      requete.on("error", () => finir(null));
      requete.on("abort", () => finir(null));
      requete.end();
    } catch {
      finir(null);
    }
  });
}
