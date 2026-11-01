import { EventEmitter } from "node:events";
import type { OuvrirRequete, RequeteImage } from "../src/main/image-distante";

/**
 * Un faux `net.request` d'Electron (redirections en mode « manual ») qui répond par `reponse(url)` : une réponse 3xx avec
 * Location émet `redirect`, et la cible n'est demandée que si `followRedirect` est appelé pendant l'événement (sinon,
 * comme Electron, une erreur). `demandes` note chaque adresse réellement demandée, avec l'envoi des cookies.
 */
export function fauxReseau(reponse: (url: string) => Response | Promise<Response>) {
  const demandes: { url: string; cookies: boolean }[] = [];
  const ouvrir: OuvrirRequete = (depart, o) => {
    const req = new EventEmitter() as EventEmitter & RequeteImage;
    let abandonnee = false;
    let suivre = false;
    req.followRedirect = () => void (suivre = true);
    req.abort = () => {
      if (abandonnee) return;
      abandonnee = true;
      req.emit("abort");
    };
    const demander = async (url: string): Promise<void> => {
      demandes.push({ url, cookies: o.cookies });
      let r: Response;
      try {
        r = await reponse(url);
      } catch {
        if (!abandonnee) req.emit("error", new Error("réseau"));
        return;
      }
      if (abandonnee) return;
      const location = r.headers.get("location");
      if (r.status >= 300 && r.status < 400 && location) {
        const vers = new URL(location, url).href;
        suivre = false;
        req.emit("redirect", r.status, "GET", vers, {});
        if (abandonnee) return;
        if (suivre) return demander(vers);
        req.emit("error", new Error("Redirect was cancelled"));
        return;
      }
      const corps = Buffer.from(await r.arrayBuffer());
      const rep = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string> };
      rep.statusCode = r.status;
      rep.headers = Object.fromEntries(r.headers.entries());
      req.emit("response", rep);
      for (let i = 0; i < corps.length && !abandonnee; i += 64 * 1024) rep.emit("data", corps.subarray(i, i + 64 * 1024));
      if (!abandonnee) rep.emit("end");
    };
    req.end = () => void setImmediate(() => void demander(depart));
    return req;
  };
  return { demandes, ouvrir };
}
