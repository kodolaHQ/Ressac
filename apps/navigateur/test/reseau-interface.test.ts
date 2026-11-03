import { expect, test, vi } from "vitest";
import { connect } from "node:net";
import { cibleIcone, couperReseauInterface, reglesContournement, repondreIcone, trouNoir, urlIcone } from "../src/main/reseau-interface";

test("reglesContournement : rien n'échappe au filet, sauf le serveur de développement à son adresse exacte", () => {
  expect(reglesContournement(undefined)).toBe("<-loopback>");
  expect(reglesContournement("http://localhost:5173")).toBe("<-loopback>;localhost:5173");
  expect(reglesContournement("http://localhost:5173/")).toBe("<-loopback>;localhost:5173");
  expect(reglesContournement("pas une url")).toBe("<-loopback>");
});

test("trouNoir ferme toute connexion sans rien répondre", async () => {
  const { port, fermer } = await trouNoir();
  const recu = await new Promise<string>((ok) => {
    let donnees = "";
    const s = connect(port, "127.0.0.1", () => s.write("CONNECT secret.example:443 HTTP/1.1\r\n\r\n"));
    s.on("data", (d) => (donnees += d));
    s.on("close", () => ok(donnees));
    s.on("error", () => ok(donnees));
  });
  expect(recu).toBe("");
  fermer();
});

test("couperReseauInterface : filet en échec → proxy injoignable, jamais le réseau réel", async () => {
  const proxys: unknown[] = [];
  const s = { setProxy: async (c: unknown) => (proxys.push(c), proxys.length === 1 ? Promise.reject(new Error("refusé")) : undefined) };
  const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
  await couperReseauInterface(s as unknown as Parameters<typeof couperReseauInterface>[0], "http://localhost:5173");
  erreur.mockRestore();
  expect(proxys.at(-1)).toEqual({ mode: "fixed_servers", proxyRules: "http://0.0.0.0:1", proxyBypassRules: "<-loopback>;localhost:5173" });
});

test("urlIcone et cibleIcone : http(s) passe par webaios-icone:, data:image reste, le reste est refusé", () => {
  const u = urlIcone("https://exemple.fr/favicon.ico?a=1&b=2")!;
  expect(u).toBe("webaios-icone://site/?u=https%3A%2F%2Fexemple.fr%2Ffavicon.ico%3Fa%3D1%26b%3D2");
  expect(cibleIcone(u)).toBe("https://exemple.fr/favicon.ico?a=1&b=2");
  expect(urlIcone("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
  for (const x of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,<b>", "webaios-widget://x/affichage.html"]) expect(urlIcone(x), x).toBeNull();
  for (const x of ["webaios-icone://site/?u=file%3A%2F%2F%2Fetc%2Fpasswd", "webaios-icone://site/", "webaios-widget://site/?u=https%3A%2F%2Fa.fr", "pas une url"]) expect(cibleIcone(x), x).toBeNull();
});

test("repondreIcone : sert l'image sans cookies, refuse un échec, une cible non http(s) et une image trop grosse", async () => {
  const demandes: { url: string; credentials: string }[] = [];
  const chercher = async (url: string, init: { credentials: string }) => {
    demandes.push({ url, credentials: init.credentials });
    if (url.endsWith("/gros.ico")) return new Response(new Uint8Array(600 * 1024), { headers: { "content-type": "image/x-icon" } });
    if (url.endsWith("/absent.ico")) return new Response("", { status: 404 });
    if (url.endsWith("/texte.ico")) return new Response("abc", { headers: { "content-type": "text/plain" } });
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png; charset=binary" } });
  };
  const ok = await repondreIcone(chercher, urlIcone("https://a.fr/f.png")!);
  expect(ok.status).toBe(200);
  expect(ok.headers.get("content-type")).toBe("image/png");
  expect([...new Uint8Array(await ok.arrayBuffer())]).toEqual([1, 2, 3]);
  expect(demandes[0]).toEqual({ url: "https://a.fr/f.png", credentials: "omit" });
  expect((await repondreIcone(chercher, urlIcone("https://a.fr/texte.ico")!)).headers.get("content-type")).toBe("application/octet-stream");
  expect((await repondreIcone(chercher, urlIcone("https://a.fr/absent.ico")!)).status).toBe(404);
  expect((await repondreIcone(chercher, urlIcone("https://a.fr/gros.ico")!)).status).toBe(404);
  const avant = demandes.length;
  expect((await repondreIcone(chercher, "webaios-icone://site/?u=file%3A%2F%2F%2Fetc%2Fpasswd")).status).toBe(404);
  expect(demandes).toHaveLength(avant);
  expect((await repondreIcone(async () => Promise.reject(new Error("réseau")), urlIcone("https://a.fr/f.png")!)).status).toBe(404);
});
