import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RequeteEnregistree { methode: string; url: string; corps: any }
export interface FauxServeur { url: string; requetes: RequeteEnregistree[]; fermer(): Promise<void> }

async function demarrer(repondre: (req: RequeteEnregistree, res: import("node:http").ServerResponse) => void): Promise<FauxServeur> {
  const requetes: RequeteEnregistree[] = [];
  const serveur: Server = createServer((req, res) => {
    const morceaux: Buffer[] = [];
    req.on("data", (m) => morceaux.push(m));
    req.on("end", () => {
      const texte = Buffer.concat(morceaux).toString("utf8");
      const r = { methode: req.method ?? "", url: req.url ?? "", corps: texte ? JSON.parse(texte) : undefined };
      requetes.push(r);
      repondre(r, res);
    });
  });
  await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
  return {
    url: `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`,
    requetes,
    fermer: () => new Promise<void>((ok) => { serveur.closeAllConnections(); serveur.close(() => ok()); }),
  };
}

const json = (res: import("node:http").ServerResponse, code: number, o: unknown) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(o));
};

/** Faux Kev : /v1/models et /v1/systemone. */
export const fauxKev = (answers: unknown = { q: { type: "noul", noul: 0.91 } }) =>
  demarrer((r, res) => {
    if (r.url === "/v1/models") return json(res, 200, { data: [] });
    if (r.url === "/v1/systemone") return json(res, 200, { model: "kev-latest", answers, usage: {} });
    json(res, 404, {});
  });

/** Faux Ollama : /api/chat répond `contenu`. */
export const fauxOllama = (contenu: string) =>
  demarrer((r, res) => {
    if (r.url === "/api/chat") return json(res, 200, { message: { content: contenu } });
    if (r.url === "/api/tags") return json(res, 200, { models: [{ name: "gemma4:e4b-mlx" }] });
    json(res, 404, {});
  });

/** Port sur lequel rien n'écoute. */
export async function urlInjoignable(): Promise<string> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((ok) => s.close(() => ok()));
  return `http://127.0.0.1:${port}`;
}
