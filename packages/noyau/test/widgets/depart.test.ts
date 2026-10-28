import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dossierTemporaire } from "../aide/temporaire.js";

const SCRIPT = join(import.meta.dirname, "..", "..", "docker", "recolteur.mjs");
const MODELES = join(import.meta.dirname, "..", "..", "modeles", "widgets");

type Appel = { t: "appel"; n: number; f: string; a: any };
type Repondeur = (appel: Appel) => Promise<{ ok: unknown } | { erreur: string }> | { ok: unknown } | { erreur: string };

async function lancer(id: string, repondre: Repondeur, precedent: unknown = null, config?: Record<string, unknown>) {
  const dossier = await dossierTemporaire();
  await cp(join(MODELES, id), dossier, { recursive: true });
  if (config) {
    const w = JSON.parse(await readFile(join(dossier, "widget.json"), "utf8"));
    w.config = { ...w.config, ...config };
    await writeFile(join(dossier, "widget.json"), JSON.stringify(w));
  }
  const enfant = spawn("node", [SCRIPT, dossier], { stdio: ["pipe", "pipe", "pipe"] });
  const appels: Appel[] = [];
  const lignes: any[] = [];
  let tampon = "";
  const fini = new Promise<void>((ok) => enfant.on("close", () => ok()));
  enfant.stdout.on("data", (d) => {
    tampon += d;
    let i;
    while ((i = tampon.indexOf("\n")) >= 0) {
      const m = JSON.parse(tampon.slice(0, i));
      tampon = tampon.slice(i + 1);
      lignes.push(m);
      if (m.t === "appel") {
        appels.push(m);
        void Promise.resolve(repondre(m)).then((r) => enfant.stdin.write(JSON.stringify({ t: "reponse", n: m.n, ...r }) + "\n"));
      }
    }
  });
  enfant.stdin.write(JSON.stringify({ t: "debut", precedent, maintenant: "2026-10-28T10:00:00.000Z" }) + "\n");
  await fini;
  return { appels, terminal: lignes.find((l) => l.t === "fin" || l.t === "echec") };
}

const rss = (items: { titre: string; url: string }[]) =>
  `<?xml version="1.0"?><rss><channel>${items.map((i) => `<item><title>${i.titre}</title><link>${i.url}</link></item>`).join("")}</channel></rss>`;

describe("widgets de départ", () => {
  it("meteo sans ville rend { ville: null } ; avec Bordeaux rend actuel, 12 heures et 5 jours", async () => {
    const sans = await lancer("meteo", () => ({ erreur: "ne devrait rien appeler" }));
    expect(sans.terminal).toEqual({ t: "fin", donnees: { ville: null } });
    expect(sans.appels).toHaveLength(0);

    const heures = Array.from({ length: 48 }, (_, i) => `2026-10-28T${String(i % 24).padStart(2, "0")}:00`);
    const r = await lancer(
      "meteo",
      (a) => {
        if (a.a.url.startsWith("https://geocoding-api.open-meteo.com/v1/search?name=Bordeaux&count=1&language=fr"))
          return { ok: { results: [{ name: "Bordeaux", latitude: 44.84, longitude: -0.58 }] } };
        if (a.a.url.startsWith("https://api.open-meteo.com/v1/forecast?latitude=44.84&longitude=-0.58"))
          return {
            ok: {
              current: { time: "2026-10-28T10:00", temperature_2m: 17.4, weather_code: 2 },
              hourly: { time: heures, temperature_2m: heures.map((_, i) => 10 + i), weather_code: heures.map(() => 61) },
              daily: {
                time: ["2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"],
                temperature_2m_max: [18, 16, 15, 17, 19],
                temperature_2m_min: [9, 10, 9, 10, 9],
                weather_code: [2, 61, 3, 1, 0],
              },
            },
          };
        return { erreur: "url inattendue " + a.a.url };
      },
      null,
      { ville: "Bordeaux" },
    );
    expect(r.terminal.t).toBe("fin");
    const d = r.terminal.donnees;
    expect(d.ville).toBe("Bordeaux");
    expect(d.actuel).toEqual({ temperature: 17, code: 2, libelle: "Partiellement nuageux" });
    expect(d.heures).toHaveLength(12);
    expect(d.heures[0]).toEqual({ heure: "11:00", temperature: 21, code: 61, libelle: "Pluie faible" });
    expect(d.jours).toHaveLength(5);
    expect(d.jours[1]).toEqual({ date: "2026-10-29", min: 10, max: 16, code: 61, libelle: "Pluie faible" });
  });

  const flux: Record<string, string> = {
    "https://news.ycombinator.com/rss": rss(Array.from({ length: 10 }, (_, i) => ({ titre: `HN ${i}`, url: `https://exemple.org/hn${i}` })).concat([{ titre: "Doublon", url: "https://www.exemple.org/doublon/?utm_source=x" }])),
    "https://lobste.rs/rss": rss(Array.from({ length: 10 }, (_, i) => ({ titre: `Lobsters ${i}`, url: `https://exemple.net/l${i}` })).concat([{ titre: "Autre titre", url: "https://exemple.org/doublon" }, { titre: "HN 3", url: "https://autre.fr/x" }])),
    "https://www.theverge.com/rss/index.xml": rss([]),
    "https://next.ink/feed/": rss([]),
  };

  it("actus-tech dédoublonne, trie par Kev, garde 15 articles, résume les 8 premiers et réutilise les résumés précédents", async () => {
    const r = await lancer(
      "actus-tech",
      (a) => {
        if (a.f === "recuperer") return flux[a.a.url] !== undefined ? { ok: flux[a.a.url] } : { erreur: "inconnu" };
        if (a.f === "kev") {
          const m = /(?:HN|Lobsters) (\d)/.exec(a.a.state);
          const n = m ? Number(m[1]) : 0;
          return { ok: { q: { type: "noul", noul: a.a.state.includes("Lobsters") ? 0.9 - n * 0.01 : 0.8 - n * 0.01 } } };
        }
        if (a.f === "lirePage") return { ok: { url: a.a.url, titre: "T", texte: "contenu ".repeat(5000), liens: [] } };
        if (a.f === "gemma") return { ok: "Un résumé." };
        return { erreur: "?" };
      },
      { articles: [{ titre: "Lobsters 0", url: "https://exemple.net/l0", source: "exemple.net", p: 0.9, resume: "Ancien résumé." }] },
    );
    expect(r.terminal.t).toBe("fin");
    const arts = r.terminal.donnees.articles;
    expect(arts).toHaveLength(15);
    expect(arts[0]).toMatchObject({ titre: "Lobsters 0", url: "https://exemple.net/l0", source: "exemple.net", resume: "Ancien résumé." });
    // doublons : un seul « doublon » et « HN 3 » une fois
    expect(arts.filter((x: any) => x.titre === "HN 3")).toHaveLength(1);
    const kevs = r.appels.filter((a) => a.f === "kev");
    expect(kevs[0]!.a.questions.q.instructions).toContain("Cet article intéresse-t-il quelqu'un qui suit : IA et modèles");
    expect(kevs.filter((a) => a.a.state.includes("Doublon") || a.a.state.includes("Autre titre"))).toHaveLength(1);
    expect(arts.slice(0, 8).every((x: any) => typeof x.resume === "string")).toBe(true);
    expect(arts.slice(8).every((x: any) => x.resume === undefined)).toBe(true);
    expect(r.appels.filter((a) => a.f === "gemma")).toHaveLength(7); // le 1er réutilise le précédent
    const g = r.appels.find((a) => a.f === "gemma")!;
    expect(g.a.prompt.length).toBeLessThan(13000);
    const lp = r.appels.filter((a) => a.f === "lirePage");
    expect(lp).toHaveLength(7);
    expect(lp.every((a) => a.a.compte === undefined || a.a.compte === false)).toBe(true);
  });

  it("actus-tech : une source en échec n'empêche pas les autres", async () => {
    const r = await lancer("actus-tech", (a) => {
      if (a.f === "recuperer") {
        if (a.a.url.includes("lobste.rs")) return { erreur: "hors ligne" };
        return { ok: flux[a.a.url]! };
      }
      if (a.f === "kev") return { ok: { q: { type: "noul", noul: 0.9 } } };
      return { erreur: "pas de page" }; // les résumés échouent : sautés
    });
    expect(r.terminal.t).toBe("fin");
    const arts = r.terminal.donnees.articles;
    expect(arts.length).toBeGreaterThan(0);
    expect(arts.some((x: any) => x.titre.startsWith("Lobsters"))).toBe(false);
    expect(arts.every((x: any) => x.resume === undefined)).toBe(true);
  });

  it("daily-dev lit avec le compte, ne garde que les /posts/, et échoue avec le message de connexion si aucun post", async () => {
    const liens = [
      { texte: "Un article suffisamment long sur Svelte", url: "https://app.daily.dev/posts/abc" },
      { texte: "Court", url: "https://app.daily.dev/posts/court" },
      { texte: "Une page de tags assez longue pour passer", url: "https://app.daily.dev/tags/svelte" },
      { texte: "Un autre post externe qui ne compte pas", url: "https://evil.example/posts/x" },
      { texte: "Un second article suffisamment long", url: "https://app.daily.dev/posts/def" },
    ];
    const r = await lancer("daily-dev", (a) => {
      if (a.f === "lirePage" && a.a.compte) return { ok: { url: "https://app.daily.dev/", titre: "d", texte: "", liens } };
      if (a.f === "lirePage" && a.a.url.endsWith("/abc")) return { ok: { url: "https://evil.example/", titre: "x", texte: "redirigé", liens: [] } };
      if (a.f === "lirePage") return { ok: { url: a.a.url, titre: "x", texte: "contenu", liens: [] } };
      if (a.f === "kev") return { ok: { q: { type: "noul", noul: 0.9 } } };
      if (a.f === "gemma") return { ok: "Résumé." };
      return { erreur: "?" };
    });
    expect(r.appels[0]).toMatchObject({ f: "lirePage", a: { url: "https://app.daily.dev/", compte: true } });
    expect(r.terminal.t).toBe("fin");
    const arts = r.terminal.donnees.articles;
    expect(arts.map((x: any) => x.url).sort()).toEqual(["https://app.daily.dev/posts/abc", "https://app.daily.dev/posts/def"]);
    const abc = arts.find((x: any) => x.url.endsWith("/abc"));
    expect(abc.resume).toBeUndefined(); // redirigé hors app.daily.dev : résumé sauté
    expect(arts.find((x: any) => x.url.endsWith("/def")).resume).toBe("Résumé.");

    const vide = await lancer("daily-dev", () => ({ ok: { url: "https://app.daily.dev/", titre: "d", texte: "", liens: [] } }));
    expect(vide.terminal).toEqual({ t: "echec", erreur: "Aucun article trouvé : es-tu connecté à daily.dev dans ce profil ?" });
  });

  it("actus-tech échoue clairement quand le tri de l'IA locale ne note rien", async () => {
    const r = await lancer("actus-tech", (a) => {
      if (a.f === "recuperer") return { ok: flux[a.a.url]! };
      if (a.f === "kev") return { ok: {} };
      return { erreur: "?" };
    });
    expect(r.terminal).toEqual({ t: "echec", erreur: "Le tri par l'IA locale a échoué" });
  });

  it("daily-dev garde 12 articles, résume les 6 premiers et réutilise le précédent", async () => {
    const liens = Array.from({ length: 20 }, (_, i) => ({ texte: `Article numéro ${String(i).padStart(2, "0")} assez long`, url: `https://app.daily.dev/posts/p${i}` }));
    const r = await lancer(
      "daily-dev",
      (a) => {
        if (a.f === "lirePage" && a.a.compte) return { ok: { url: "https://app.daily.dev/", titre: "d", texte: "", liens } };
        if (a.f === "lirePage") return { ok: { url: a.a.url, titre: "x", texte: "contenu", liens: [] } };
        if (a.f === "kev") return { ok: { q: { type: "noul", noul: 0.99 - Number(/numéro (\d\d)/.exec(a.a.state)![1]) * 0.01 } } };
        if (a.f === "gemma") return { ok: "Résumé." };
        return { erreur: "?" };
      },
      { articles: [{ titre: "x", url: "https://app.daily.dev/posts/p1", source: "app.daily.dev", p: 0.9, resume: "Ancien." }] },
    );
    const arts = r.terminal.donnees.articles;
    expect(arts).toHaveLength(12);
    expect(arts.filter((x: any) => x.resume)).toHaveLength(6);
    expect(arts.slice(6).every((x: any) => x.resume === undefined)).toBe(true);
    expect(arts[1].resume).toBe("Ancien.");
    expect(r.appels.filter((a) => a.f === "gemma")).toHaveLength(5);
  });
});
