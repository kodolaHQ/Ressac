import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { dossierWidgets, ecrireWidget, lancer, nouveauProfil, nouvelleRacine } from "./aide";

// Le lecteur invisible fait défiler une page qui charge en défilant (plan 13). Tout est local : la page est servie par
// le test, jamais un vrai site. Les widgets sont récoltés au lancement (sans état : jamais récoltés).

/**
 * Une liste d'annonces de 300 px chacune, 5 au départ (1 500 px, plus haut que l'écran de 900 px), 5 de plus, 200 ms
 * après que le bas de la liste est vu : par IntersectionObserver (`/io`) ou par l'événement `scroll` (`/defilement`).
 * La page écrit aussi ce qu'elle voit de sa fenêtre (cachée) : `visibilityState` et les images d'animation.
 */
const pageAnnonces = (mode: "io" | "defilement" | "virtuelle") => `<!doctype html><meta charset="utf-8"><title>Annonces</title>
<style>body{margin:0} .a{height:300px}</style>
<p id="etat"></p><div id="haut"></div><div id="liste"></div><div id="fin" style="height:10px"></div>
<script>
  const liste = document.getElementById("liste");
  let n = 0, enCours = false, images = 0;
  const ajouter = () => {
    for (let i = 0; i < 5 && n < 40; i++) {
      n++;
      const d = document.createElement("div");
      d.className = "a";
      d.innerHTML = '<a href="https://exemple.invalid/annonce/' + n + '">Annonce ' + n + "</a> prix " + (1000 * n) + " €";
      liste.appendChild(d);
    }
    enCours = false;
  };
  const plus = () => { if (!enCours) { enCours = true; setTimeout(ajouter, 200); } };
  ajouter();
  const compter = () => { images++; requestAnimationFrame(compter); };
  requestAnimationFrame(compter);
  setInterval(() => {
    document.getElementById("etat").textContent = "visibilite=" + document.visibilityState + " images=" + (images > 0 ? "oui" : "non");
  }, 100);
  ${
    mode === "io"
      ? `new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) plus(); }).observe(document.getElementById("fin"));`
      : `addEventListener("scroll", () => { if (innerHeight + scrollY >= document.documentElement.scrollHeight - 50) plus(); });`
  }
  ${
    // Liste virtualisée (comme Leboncoin) : une annonce sortie de l'écran par le haut est retirée de la page, remplacée
    // par de l'espace vide de même hauteur.
    mode === "virtuelle"
      ? `addEventListener("scroll", () => {
          const haut = document.getElementById("haut");
          for (const d of [...liste.children]) {
            if (d.getBoundingClientRect().bottom >= -300) break;
            haut.style.height = (haut.offsetHeight + d.offsetHeight) + "px";
            d.remove();
          }
        });`
      : ""
  }
</script>`;

let site: { url: string; serveur: Server };
let ia: Server;

test.beforeAll(async () => {
  const serveur = createServer((req, res) => {
    const chemin = new URL(req.url ?? "/", "http://x").pathname;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    const mode = ({ "/io": "io", "/defilement": "defilement", "/virtuelle": "virtuelle" } as const)[chemin as "/io"];
    res.end(mode ? pageAnnonces(mode) : "<title>ok</title>");
  });
  await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
  site = { url: `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`, serveur };
  // Faux Kev et faux Ollama : jamais les vrais modèles (aucun bloc d'IA ici).
  ia = createServer((_req, res) => void res.writeHead(200, { "Content-Type": "application/json" }).end('{"models":[],"data":[]}'));
  await new Promise<void>((ok) => ia.listen(0, "127.0.0.1", ok));
});
test.afterAll(async () => {
  for (const s of [site?.serveur, ia]) {
    s?.closeAllConnections();
    await new Promise<void>((ok) => (s ? s.close(() => ok()) : ok()));
  }
});

/** Un widget en workflow : la page (avec `defiler` si donné), un bloc `code` qui compte les annonces lues, la sortie. */
function widgetAnnonces(racine: string, id: string, chemin: string, defiler?: number): void {
  ecrireWidget(racine, id, {
    nom: id,
    recolte: { minutes: 60 },
    config: { url: `${site.url}${chemin}` },
    workflow: {
      version: 1,
      blocs: [
        { id: "page", type: "source.page", parametres: { url: "{config.url}", ...(defiler !== undefined ? { defiler } : {}) } },
        { id: "compte", type: "code", parametres: { source: "compter.mjs" } },
        { id: "sortie", type: "sortie", parametres: { vers: "widget" } },
      ],
      liens: [
        { de: "page", vers: "compte" },
        { de: "compte", vers: "sortie" },
      ],
    },
    fichiers: {
      "compter.mjs": `export default async (page) => ({
        annonces: (page.texte.match(/Annonce \\d+/g) ?? []).length,
        liens: page.liens.filter((l) => l.url.includes("/annonce/")).length,
        etat: (page.texte.match(/visibilite=\\S+ images=\\S+/) ?? [""])[0],
      });`,
    },
    affichage: "<!doctype html><p>annonces</p>",
  });
}

type Compte = { annonces: number; liens: number; etat: string };
const donnees = (profil: string, id: string): Compte | null => {
  const f = join(dossierWidgets(profil), id, "donnees.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Compte) : null;
};

test("le lecteur fait défiler une page qui charge en défilant (IntersectionObserver ou scroll), seulement avec defiler", async () => {
  test.setTimeout(150_000);
  const racine = nouvelleRacine();
  widgetAnnonces(racine, "sans-defiler", "/io");
  widgetAnnonces(racine, "io", "/io", 8);
  widgetAnnonces(racine, "defilement", "/defilement", 8);
  widgetAnnonces(racine, "virtuelle", "/virtuelle", 8);
  const profil = nouveauProfil();
  const { fermer } = await lancer({
    racine,
    profil,
    env: { WEBAIOS_KEV_URL: `http://127.0.0.1:${(ia.address() as AddressInfo).port}`, WEBAIOS_OLLAMA_URL: `http://127.0.0.1:${(ia.address() as AddressInfo).port}`, WEBAIOS_TEST_ADRESSES_LOCALES: "1" },
  });
  try {
    for (const id of ["sans-defiler", "io", "defilement", "virtuelle"]) {
      await expect.poll(() => donnees(profil, id), { timeout: 120_000, intervals: [500] }).not.toBeNull();
    }
    const sans = donnees(profil, "sans-defiler")!;
    const io = donnees(profil, "io")!;
    const defilement = donnees(profil, "defilement")!;
    const virtuelle = donnees(profil, "virtuelle")!;
    console.log("mesures :", JSON.stringify({ sans, io, defilement, virtuelle }));
    // Sans defiler : seulement les 5 premières annonces, comme avant.
    expect(sans).toMatchObject({ annonces: 5, liens: 5 });
    // Avec defiler : la page a chargé en défilant, dans la fenêtre cachée, par les deux mécanismes.
    expect(io.annonces).toBeGreaterThan(5);
    expect(io.liens).toBe(io.annonces);
    expect(defilement.annonces).toBeGreaterThan(5);
    expect(defilement.liens).toBe(defilement.annonces);
    // Liste virtualisée : les annonces retirées en défilant sont gardées au fur et à mesure, chacune une fois.
    expect(virtuelle.annonces).toBe(defilement.annonces);
    expect(virtuelle.liens).toBe(virtuelle.annonces);
    // Mesuré (Electron 45) : la fenêtre cachée (show: false, paintWhenInitiallyHidden, sans ralentissement d'arrière-plan)
    // se dit visible et anime ses images : IntersectionObserver et `scroll` y marchent sans rien de plus.
    expect(io.etat).toBe("visibilite=visible images=oui");
  } finally {
    await fermer();
  }
});
