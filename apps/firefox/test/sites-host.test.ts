import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accorderSite, cheminsEspace, DeclarationSite, lireAccordsSites, MemoireSite } from "../../../packages/noyau/src/index";
import { SchemaActionSite as electronSchema } from "../../navigateur/src/commun/api";
import { modifierAvecAgent } from "../../navigateur/src/commun/sites";
import { createSites, SchemaActionSite, SiteSouvenirs, type SitesChrome } from "../noyau/sites";

// A gate on lireSite: while armed, the next call waits (a slow read, for the deletion race).
const gate: { armed: boolean; reached: (() => void) | null; open: (() => void) | null } = { armed: false, reached: null, open: null };
vi.mock("../../../packages/noyau/src/index", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../packages/noyau/src/index")>();
  return {
    ...real,
    lireSite: async (...a: Parameters<typeof real.lireSite>) => {
      if (gate.armed) {
        gate.armed = false;
        await new Promise<void>((ok) => {
          gate.open = ok;
          gate.reached?.();
        });
      }
      return real.lireSite(...a);
    },
  };
});

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  gate.armed = false;
  gate.open?.();
  for (const c of cleanup.splice(0)) await c();
});

const declaration = {
  nom: "Vidola",
  description: "Séries",
  adresse: "https://vidola-a.example/",
  domaines: ["vidola-a.example", "vidola-b.example"],
  retouches: [],
  reprise: true,
};

function mount(gateOuvrir?: { reached: () => void; open: Promise<void> }) {
  const racine = realpathSync(mkdtempSync(join(tmpdir(), "sites-host-")));
  const chemins = cheminsEspace(join(racine, "espace"));
  const dataDir = join(racine, "profil");
  mkdirSync(dataDir, { recursive: true });
  const write = (id: string, texte: string) => {
    mkdirSync(join(chemins.sites, id), { recursive: true });
    writeFileSync(join(chemins.sites, id, "site.json"), texte);
  };
  write("vidola", JSON.stringify(declaration));
  writeFileSync(join(chemins.sites, "vidola", "garde.txt"), "x");
  write("casse", "{pas du json");
  write("MonSite", JSON.stringify(declaration));
  const journal: string[] = [];
  const calls: { ouvrir: unknown[][]; majs: Parameters<SitesChrome["mettreAJour"]>[0][]; retouches: Parameters<SitesChrome["mettreAJour"]>[1][]; recharges: string[]; accueil: string[] } = {
    ouvrir: [],
    majs: [],
    retouches: [],
    recharges: [],
    accueil: [],
  };
  let erreursChrome: Awaited<ReturnType<SitesChrome["erreurs"]>> = [];
  let ouvertesChrome: string[] = [];
  const chrome: SitesChrome = {
    ouvrir: async (...a) => {
      calls.ouvrir.push(a);
      journal.push("ouvrir");
      if (gateOuvrir) {
        gateOuvrir.reached();
        await gateOuvrir.open;
      }
      return true;
    },
    fermer: async (id) => void journal.push(`fermer ${id}`),
    effacer: async (id) => void journal.push(`effacer ${id}`),
    mettreAJour: async (s, r) => {
      calls.majs.push(s);
      calls.retouches.push(r);
      return false;
    },
    rechargerVue: async (id) => void calls.recharges.push(id),
    erreurs: async () => erreursChrome,
    ouvertes: async () => ouvertesChrome,
    accueilChange: (id) => void calls.accueil.push(id),
  };
  const diffuser = vi.fn();
  const preRemplir = vi.fn();
  const memoires: { id: string; message: unknown }[] = [];
  const sites = createSites({ chemins, dataDir, adressesLocales: false, chrome, diffuser, preRemplir, notifierMemoire: (id, message) => void memoires.push({ id, message }) });
  cleanup.push(async () => {
    await sites.arreter();
    rmSync(racine, { recursive: true, force: true });
  });
  return { sites, chemins, dataDir, calls, journal, diffuser, preRemplir, memoires, write, setOuvertes: (o: string[]) => (ouvertesChrome = o), setErreurs: (e: typeof erreursChrome) => (erreursChrome = e) };
}

describe("liste", () => {
  it("shows the current domain, the error of a broken site.json, and no actions for a refused id", async () => {
    const m = mount();
    mkdirSync(join(m.dataDir, "sites", "vidola"), { recursive: true });
    writeFileSync(join(m.dataDir, "sites", "vidola", "adresse.json"), JSON.stringify({ actuel: "vidola-b.example", anciens: ["vidola-a.example"], depuis: null }));
    const l = await m.sites.liste();
    const vidola = l.find((s) => s.id === "vidola")!;
    expect(vidola).toMatchObject({ nom: "Vidola", ouverte: false });
    expect(vidola.domaine).toBe("vidola-b.example");
    expect(vidola).not.toHaveProperty("empreinte");
    expect(l.find((s) => s.id === "casse")!.erreur).toMatch(/site\.json/);
    expect(l.find((s) => s.id === "MonSite")).toMatchObject({ sansActions: true });
  });
});

describe("ouvrirParId", () => {
  it("opens with domains, start address, home flag and the remembered frame; unknown or invalid ids do not call the chrome", async () => {
    const m = mount();
    m.sites.noter("vidola", { cadre: { x: 1, y: 2, largeur: 300, hauteur: 400 } });
    expect(await m.sites.ouvrirParId("vidola")).toBe(true);
    const [site, cadre] = m.calls.ouvrir[0]!;
    expect(site).toMatchObject({ id: "vidola", domaines: ["vidola-a.example", "vidola-b.example"], depart: "https://vidola-a.example/", aAccueil: false });
    expect(cadre).toEqual({ x: 1, y: 2, largeur: 300, hauteur: 400 });
    expect(m.calls.ouvrir[0]![2]).toEqual({ js: {}, css: {} });
    expect((await m.sites.liste()).find((s) => s.id === "vidola")!.ouverte).toBe(true);
    for (const id of ["absente", "casse", "MonSite", "../x"]) expect(await m.sites.ouvrirParId(id)).toBe(false);
    expect(m.calls.ouvrir).toHaveLength(1);
  });

  it("resynchroniser takes the chrome's open windows; fermee forgets one", async () => {
    const m = mount();
    m.setOuvertes(["vidola"]);
    await m.sites.resynchroniser();
    expect((await m.sites.liste()).find((s) => s.id === "vidola")!.ouverte).toBe(true);
    m.sites.fermee("vidola");
    expect((await m.sites.liste()).find((s) => s.id === "vidola")!.ouverte).toBe(false);
  });
});

describe("agir", () => {
  it("modifier pre-fills the agent terminal; relire and dossier do nothing here", async () => {
    const m = mount();
    await m.sites.agir("vidola", "modifier", "f1");
    expect(m.preRemplir).toHaveBeenCalledWith("f1", modifierAvecAgent("vidola"));
    await m.sites.agir("vidola", "relire", "f1");
    await m.sites.agir("vidola", "dossier", "f1");
    expect(m.preRemplir).toHaveBeenCalledTimes(1);
    expect(m.journal).toEqual([]);
  });

  it("oublier deletes memoire.json and tells a subscribed home screen the memory is empty", async () => {
    const m = mount();
    const mem = await MemoireSite.ouvrir(join(m.dataDir, "sites"), "vidola");
    mem.retenir("serie", { a: 1 }, "/s");
    await mem.vider();
    const fichier = join(m.dataDir, "sites", "vidola", "memoire.json");
    expect(existsSync(fichier)).toBe(true);
    await m.sites.ouvrirParId("vidola");
    const avant = await m.sites.memoireAccueil("vidola");
    expect(avant).toMatchObject({ type: "memoire", domaine: "vidola-a.example" });
    expect(Object.keys(avant!.valeurs)).toEqual(["serie"]);
    await m.sites.agir("vidola", "oublier", "f1");
    expect(existsSync(fichier)).toBe(false);
    await vi.waitFor(() => expect(m.memoires.at(-1)).toMatchObject({ id: "vidola", message: { type: "memoire", valeurs: {} } }));
    expect(readdirSync(join(m.chemins.sites, "vidola")).sort()).toEqual(["garde.txt", "site.json"]);
  });

  it("supprimer closes then erases in the chrome, wipes the profile data and trashes the folder", async () => {
    const m = mount();
    await accorderSite(m.dataDir, "vidola", DeclarationSite.parse(declaration));
    mkdirSync(join(m.dataDir, "sites", "vidola"), { recursive: true });
    writeFileSync(join(m.dataDir, "sites", "vidola", "adresse.json"), "{}");
    m.sites.noter("vidola", { favicon: "data:x" });
    await m.sites.ouvrirParId("vidola");
    await m.sites.agir("vidola", "supprimer", "f1");
    expect(m.journal.filter((j) => /^(fermer|effacer)/.test(j))).toEqual(["fermer vidola", "effacer vidola"]);
    expect(existsSync(join(m.dataDir, "sites", "vidola"))).toBe(false);
    expect(Object.hasOwn(await lireAccordsSites(m.dataDir), "vidola")).toBe(false);
    const corbeille = readdirSync(join(m.chemins.sites, ".corbeille"));
    expect(corbeille).toHaveLength(1);
    expect(corbeille[0]).toMatch(/^vidola-\d+$/);
    expect(existsSync(join(m.chemins.sites, "vidola"))).toBe(false);
    expect(existsSync(join(m.chemins.sites, ".corbeille", corbeille[0]!, "site.json"))).toBe(true);
    // The favicon memory is forgotten (written after the 500 ms delay, or on stop).
    await m.sites.arreter();
    const sites = existsSync(join(m.dataDir, "sites.json")) ? JSON.parse(readFileSync(join(m.dataDir, "sites.json"), "utf8")) : {};
    expect(sites.vidola).toBeUndefined();
  });

  it("a failed trash shows Electron's text on the row", async () => {
    const m = mount();
    writeFileSync(join(m.chemins.sites, ".corbeille"), "un fichier, pas un dossier");
    await m.sites.agir("vidola", "supprimer", "f1");
    const ligne = (await m.sites.liste()).find((s) => s.id === "vidola")!;
    expect(ligne.erreurAction).toBe("Dossier non mis à la corbeille : la connexion et la mémoire sont effacées, le dossier reste.");
    expect(existsSync(join(m.chemins.sites, "vidola"))).toBe(true);
  });

  it("refuses a path id and a refused id; an unknown folder is neither forgotten nor deleted", async () => {
    const m = mount();
    await m.sites.agir("../x", "supprimer", "f1");
    await m.sites.agir("MonSite", "supprimer", "f1");
    await m.sites.agir("inconnu", "supprimer", "f1");
    expect(m.journal).toEqual([]);
    expect(existsSync(join(m.chemins.sites, ".corbeille"))).toBe(false);
    expect(existsSync(join(m.chemins.sites, "MonSite"))).toBe(true);
  });

  it("deleting during a slow open: the chrome is never asked to open; a concurrent second delete does nothing", async () => {
    const m = mount();
    const atteint = new Promise<void>((ok) => (gate.reached = ok));
    gate.armed = true;
    const ouverture = m.sites.ouvrirParId("vidola");
    await atteint;
    const a = m.sites.agir("vidola", "supprimer", "f1");
    const b = m.sites.agir("vidola", "supprimer", "f1");
    gate.open!();
    expect(await ouverture).toBe(false);
    await Promise.all([a, b]);
    expect(m.calls.ouvrir).toHaveLength(0);
    expect(m.journal.filter((j) => j === "fermer vidola")).toHaveLength(1);
    expect(readdirSync(join(m.chemins.sites, ".corbeille"))).toHaveLength(1);
  });
});

describe("deleting while the chrome opens the window", () => {
  it("closes the window opened meanwhile and does not mark it open", async () => {
    let lache!: () => void;
    let atteint!: () => void;
    const reached = new Promise<void>((ok) => (atteint = ok));
    const m = mount({ reached: () => atteint(), open: new Promise<void>((ok) => (lache = ok)) });
    const ouverture = m.sites.ouvrirParId("vidola");
    await reached;
    const suppression = m.sites.agir("vidola", "supprimer", "f1");
    await vi.waitFor(() => expect(m.journal).toContain("effacer vidola"));
    lache();
    expect(await ouverture).toBe(false);
    await suppression;
    expect(m.journal.at(-1)).toBe("fermer vidola");
    expect((await m.sites.liste()).find((s) => s.id === "vidola")?.ouverte ?? false).toBe(false);
  });
});

describe("watching", () => {
  it("a site.json rewritten with one domain less updates the open window and broadcasts; an accueil/ change reaches the chrome", async () => {
    const m = mount();
    await m.sites.ouvrirParId("vidola");
    // Let the watcher settle before writing.
    await new Promise((r) => setTimeout(r, 400));
    m.diffuser.mockClear();
    m.write("vidola", JSON.stringify({ ...declaration, domaines: ["vidola-a.example"] }));
    await vi.waitFor(() => expect(m.calls.majs.length).toBeGreaterThan(0), { timeout: 5000 });
    expect(m.calls.majs.at(-1)!.domaines).toEqual(["vidola-a.example"]);
    expect(m.diffuser).toHaveBeenCalled();
    mkdirSync(join(m.chemins.sites, "vidola", "accueil"), { recursive: true });
    writeFileSync(join(m.chemins.sites, "vidola", "accueil", "index.html"), "<p>x</p>");
    await vi.waitFor(() => expect(m.calls.accueil).toContain("vidola"), { timeout: 5000 });
  });
});

describe("retouches", () => {
  const avecRetouches = { ...declaration, retouches: [{ correspond: ["/*"], js: ["a.js"], css: ["a.css"] }] };
  const ecrire = (m: ReturnType<typeof mount>, f: string, texte: string) => {
    mkdirSync(join(m.chemins.sites, "vidola", "retouches"), { recursive: true });
    writeFileSync(join(m.chemins.sites, "vidola", "retouches", f), texte);
  };

  it("opens with the retouches' files, the accord card and the fingerprint", async () => {
    const m = mount();
    m.write("vidola", JSON.stringify(avecRetouches));
    ecrire(m, "a.js", "window.a = 1");
    ecrire(m, "a.css", "p {}");
    await m.sites.ouvrirParId("vidola");
    const [site, cadre, retouches] = m.calls.ouvrir[0]!;
    expect(cadre).toBeNull();
    expect(retouches).toEqual({ js: { "a.js": "window.a = 1" }, css: { "a.css": "p {}" } });
    expect(site).toMatchObject({ accordRequis: true, demande: { nom: "Vidola", fichiers: ["a.js", "a.css"], empreinte: expect.stringMatching(/^[0-9a-f]{64}$/) }, empreinte: expect.any(String) });
    expect(m.sites.sitesOuverts.get("vidola")).toBe(site);
  });

  it("rewriting retouches/a.js updates the chrome then reloads the view once; the same content does not reload", async () => {
    const m = mount();
    m.write("vidola", JSON.stringify(avecRetouches));
    ecrire(m, "a.js", "window.a = 1");
    ecrire(m, "a.css", "p {}");
    await m.sites.ouvrirParId("vidola");
    await new Promise((r) => setTimeout(r, 400));
    ecrire(m, "a.js", "window.a = 2");
    await vi.waitFor(() => expect(m.calls.recharges).toEqual(["vidola"]), { timeout: 5000 });
    expect(m.calls.retouches.at(-1)).toEqual({ js: { "a.js": "window.a = 2" }, css: { "a.css": "p {}" } });
    const majs = m.calls.majs.length;
    ecrire(m, "a.js", "window.a = 2");
    await vi.waitFor(() => expect(m.calls.majs.length).toBeGreaterThan(majs), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(m.calls.recharges).toEqual(["vidola"]);
  });

  it("memoireOp: only an open app with its accord; the address is the chrome's", async () => {
    const m = mount();
    const op = { id: "vidola", adresse: "/serie/x", op: "retenir", cle: "k", valeur: 1 };
    expect(await m.sites.memoireOp(op)).toMatchObject({ ok: false });
    await m.sites.ouvrirParId("vidola");
    // reprise: true asks for the accord.
    expect(await m.sites.memoireOp(op)).toMatchObject({ ok: false });
    m.sites.fermee("vidola");
    await accorderSite(m.dataDir, "vidola", DeclarationSite.parse(declaration));
    await m.sites.ouvrirParId("vidola");
    expect(await m.sites.memoireOp(op)).toEqual({ ok: true });
    expect(await m.sites.memoireOp({ ...op, op: "lire" })).toEqual({ ok: true, valeur: 1 });
    expect((await m.sites.outils.memoire("vidola"))!.valeurs.k).toMatchObject({ adresse: "/serie/x" });
    m.sites.fermee("vidola");
    expect(await m.sites.memoireOp({ ...op, op: "lire" })).toMatchObject({ ok: false });
  });
});

describe("outils", () => {
  it("lister carries the fingerprint, memoire returns the content, erreurs is empty, an unknown app is null", async () => {
    const m = mount();
    const l = await m.sites.outils.lister();
    expect(l.find((s) => s.id === "vidola")!.empreinte).toMatch(/\S/);
    expect(l.find((s) => s.id === "casse")).toMatchObject({ erreur: expect.any(String) });
    expect(l.find((s) => s.id === "casse")).not.toHaveProperty("empreinte");
    const mem = await MemoireSite.ouvrir(join(m.dataDir, "sites"), "vidola");
    mem.retenir("serie", 1, "/s");
    await mem.vider();
    expect((await m.sites.outils.memoire("vidola"))!.valeurs).toHaveProperty("serie");
    // Closed: no console. Open: the chrome's.
    m.setErreurs([{ quand: "q", texte: "boum", source: "webaios-retouche://vidola/a.js:1", sourceVerifiee: false }]);
    expect(await m.sites.outils.erreurs("vidola")).toEqual([]);
    await m.sites.ouvrirParId("vidola");
    expect(await m.sites.outils.erreurs("vidola")).toEqual([{ quand: "q", texte: "boum", source: "webaios-retouche://vidola/a.js:1", sourceVerifiee: false }]);
    expect(await m.sites.outils.memoire("inconnu")).toBeNull();
    expect(await m.sites.outils.erreurs("inconnu")).toBeNull();
    expect(await m.sites.outils.ouvrir("inconnu")).toBe(false);
  });
});

describe("copies kept in sync with Electron", () => {
  it("SchemaActionSite accepts and refuses the same ids and actions", () => {
    for (const v of [{ id: "vidola", action: "supprimer" }, { id: "../x", action: "supprimer" }, { id: "Vidola", action: "ouvrir" }, { id: "a", action: "autre" }, { id: ".corbeille", action: "relire" }])
      expect(SchemaActionSite.safeParse(v).success).toBe(electronSchema.safeParse(v).success);
  });

  it("SiteSouvenirs has MemoireApplications' public methods and writes the same format", async () => {
    const source = readFileSync(join(__dirname, "../../navigateur/src/main/applications/service.ts"), "utf8");
    const bloc = source.slice(source.indexOf("class MemoireApplications"), source.indexOf("\n}\n", source.indexOf("class MemoireApplications")));
    const publiques = [...bloc.matchAll(/^ {2}(?!private|constructor)(\w+)\(/gm)].map((x) => x[1]).sort();
    expect(publiques).toEqual(["lire", "noter", "oublier", "vider"]);
    for (const n of publiques) expect(typeof (SiteSouvenirs.prototype as unknown as Record<string, unknown>)[n!]).toBe("function");
    // The written format: indented JSON of the whole map, temporary file then rename, 500 ms default.
    expect(bloc).toContain("JSON.stringify(this.donnees, null, 2)");
    expect(bloc).toContain("delaiMs = 500");
    const dossier = mkdtempSync(join(tmpdir(), "souvenirs-"));
    cleanup.push(() => rmSync(dossier, { recursive: true, force: true }));
    const s = new SiteSouvenirs(dossier);
    s.noter("vidola", { favicon: "f", cadre: { x: 1, y: 2, largeur: 3, hauteur: 4 } });
    await s.vider();
    expect(readFileSync(join(dossier, "sites.json"), "utf8")).toBe(JSON.stringify({ vidola: { favicon: "f", cadre: { x: 1, y: 2, largeur: 3, hauteur: 4 } } }, null, 2));
    expect(readdirSync(dossier)).toEqual(["sites.json"]);
  });
});
