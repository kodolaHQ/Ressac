import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accorderSite, cheminsEspace, DeclarationSite, lireAccordsSites, MemoireSite } from "../../../packages/noyau/src/index";
import { modifierAvecAgent } from "../../navigateur/src/commun/sites";
import { createSites, demandeAccord, empreinteDroits, SchemaActionSite, SiteSouvenirs, type SitesChrome } from "../noyau/sites";

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

function mount(gateOuvrir?: { reached: () => void; open: Promise<void> }, lireLiens: (page: string, signal?: AbortSignal) => Promise<string[]> = async () => []) {
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
  write("suivi", JSON.stringify({ ...declaration, domaines: ["vidola-a.example"], suiviAdresse: { page: "https://adresses.example/", motif: "vidola" } }));
  write("casse", "{pas du json");
  write("MonSite", JSON.stringify(declaration));
  const journal: string[] = [];
  const calls: {
    ouvrir: unknown[][];
    majs: Parameters<SitesChrome["mettreAJour"]>[0][];
    retouches: Parameters<SitesChrome["mettreAJour"]>[1][];
    recharges: string[];
    accueil: string[];
    apres: unknown[][];
    rediffuser: string[];
    suivi: unknown[][];
  } = {
    suivi: [],
    apres: [],
    rediffuser: [],
    ouvrir: [],
    majs: [],
    retouches: [],
    recharges: [],
    accueil: [],
  };
  let erreursChrome: Awaited<ReturnType<SitesChrome["erreurs"]>> = [];
  let ouvertesChrome: string[] = [];
  let vueChrome: Awaited<ReturnType<SitesChrome["vue"]>> = null;
  /** While set, fermer waits for it (a deletion in progress). */
  let retenue: Promise<void> | null = null;
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
    fermer: async (id) => {
      journal.push(`fermer ${id}`);
      await retenue;
    },
    vue: async () => vueChrome,
    apresAccord: async (...a) => void calls.apres.push(a),
    rediffuser: async (id) => void calls.rediffuser.push(id),
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
    cherche: (...a) => void calls.suivi.push(["cherche", ...a]),
    avis: (...a) => void calls.suivi.push(["avis", ...a]),
    adresseChangee: (...a) => void calls.suivi.push(["adresseChangee", ...a]),
  };
  const diffuser = vi.fn();
  const preRemplir = vi.fn();
  const memoires: { id: string; message: unknown }[] = [];
  const sites = createSites({ chemins, dataDir, adressesLocales: false, lireLiens, chrome, diffuser, preRemplir, notifierMemoire: (id, message) => void memoires.push({ id, message }) });
  cleanup.push(async () => {
    await sites.arreter();
    rmSync(racine, { recursive: true, force: true });
  });
  return { sites, chemins, dataDir, calls, journal, diffuser, preRemplir, memoires, write, setOuvertes: (o: string[]) => (ouvertesChrome = o),
    setVue: (v: typeof vueChrome) => (vueChrome = v),
    retenir: (p: Promise<void> | null) => (retenue = p), setErreurs: (e: typeof erreursChrome) => (erreursChrome = e) };
}

describe("chercherAdresse", () => {
  const AVIS_CHANGE = "Vidola a changé d'adresse : vidola-b.example. Il faudra peut-être te reconnecter.";

  it("a new domain: the bar is told (reading, new address, notice), adresse.json is written, the open app takes it", async () => {
    const m = mount(undefined, async () => ["https://adresses.example/x", "https://vidola-b.example/"]);
    await m.sites.ouvrirParId("suivi");
    await m.sites.chercherAdresse("suivi", "https://vidola-a.example/serie/1");
    expect(m.calls.suivi).toEqual([
      ["cherche", "suivi", true],
      ["cherche", "suivi", false],
      ["adresseChangee", "suivi", ["vidola-a.example", "vidola-b.example"], "https://vidola-b.example/", "https://vidola-b.example/serie/1"],
      ["avis", "suivi", { genre: "adresse-changee", texte: AVIS_CHANGE }],
    ]);
    expect(JSON.parse(readFileSync(join(m.dataDir, "sites", "suivi", "adresse.json"), "utf8"))).toMatchObject({ actuel: "vidola-b.example", anciens: ["vidola-a.example"] });
    expect(m.sites.sitesOuverts.get("suivi")).toMatchObject({ domaines: ["vidola-a.example", "vidola-b.example"], depart: "https://vidola-b.example/" });
    expect(m.sites.sitesOuverts.get("suivi")!.demande.suivis).toEqual(["vidola-b.example"]);
  });

  it("nothing to follow (no suiviAdresse, not open, deleting): no reading", async () => {
    const lireLiens = vi.fn(async () => ["https://vidola-b.example/"]);
    const m = mount(undefined, lireLiens);
    await m.sites.ouvrirParId("vidola");
    await m.sites.chercherAdresse("vidola", null);
    await m.sites.chercherAdresse("suivi", null);
    expect(lireLiens).not.toHaveBeenCalled();
    expect(m.calls.suivi).toEqual([]);
  });

  it("too early gives the last notice again, without a second reading", async () => {
    const lireLiens = vi.fn(async () => []);
    const m = mount(undefined, lireLiens);
    await m.sites.ouvrirParId("suivi");
    await m.sites.chercherAdresse("suivi", null);
    const first = m.calls.suivi.filter((c) => c[0] === "avis");
    expect(first).toEqual([["avis", "suivi", { genre: "introuvable", texte: "Adresse introuvable sur adresses.example" }]]);
    await m.sites.chercherAdresse("suivi", null);
    expect(lireLiens).toHaveBeenCalledTimes(1);
    expect(m.calls.suivi.filter((c) => c[0] === "avis")).toEqual([...first, ...first]);
  });

  it("the window closes during the reading: it is aborted and nothing is sent after", async () => {
    let signal: AbortSignal | undefined;
    let release: (l: string[]) => void = () => {};
    const m = mount(undefined, (_p, s) => {
      signal = s;
      return new Promise((ok) => (release = ok));
    });
    await m.sites.ouvrirParId("suivi");
    const done = m.sites.chercherAdresse("suivi", null);
    await vi.waitFor(() => expect(signal).toBeDefined());
    m.sites.fermee("suivi");
    expect(signal!.aborted).toBe(true);
    release(["https://vidola-b.example/"]);
    await done;
    expect(m.calls.suivi).toEqual([["cherche", "suivi", true]]);
    expect(existsSync(join(m.dataDir, "sites", "suivi", "adresse.json"))).toBe(false);
  });

  it("a deletion aborts the reading too", async () => {
    let signal: AbortSignal | undefined;
    const m = mount(undefined, (_p, s) => {
      signal = s;
      return new Promise(() => {});
    });
    await m.sites.ouvrirParId("suivi");
    void m.sites.chercherAdresse("suivi", null);
    await vi.waitFor(() => expect(signal).toBeDefined());
    await m.sites.agir("suivi", "supprimer", "f1");
    expect(signal!.aborted).toBe(true);
  });
});

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

  it("position and reprise: only an open app with its accord; « Oublier » drops a note waiting for its second", async () => {
    const m = mount();
    const note = (t: number) => m.sites.position({ id: "vidola", cadre: "1:2", adresse: "/episode/4", t, duree: 90 });
    await m.sites.ouvrirParId("vidola");
    await note(70);
    expect(await m.sites.reprise({ id: "vidola", adresse: "/episode/4", duree: 90 })).toBeNull();
    expect((await m.sites.outils.memoire("vidola"))!.positions).toEqual({});
    m.sites.fermee("vidola");
    await accorderSite(m.dataDir, "vidola", DeclarationSite.parse(declaration));
    await m.sites.ouvrirParId("vidola");
    await note(70);
    expect(await m.sites.reprise({ id: "vidola", adresse: "/episode/4", duree: 91 })).toBe(70);
    // A second note too soon waits; « Oublier » (the real action) drops it, the memory stays empty.
    void note(75);
    await m.sites.agir("vidola", "oublier", "f1");
    await new Promise((r) => setTimeout(r, 1300));
    expect((await m.sites.outils.memoire("vidola"))!.positions).toEqual({});
    m.sites.fermee("vidola");
    expect(await m.sites.reprise({ id: "vidola", adresse: "/episode/4", duree: 90 })).toBeNull();
  });
});

describe("accorder", () => {
  const avecRetouches = { ...declaration, retouches: [{ correspond: ["/*"], js: ["a.js"], css: [] }] };
  async function ouverte() {
    const m = mount();
    m.write("vidola", JSON.stringify(avecRetouches));
    mkdirSync(join(m.chemins.sites, "vidola", "retouches"), { recursive: true });
    writeFileSync(join(m.chemins.sites, "vidola", "retouches", "a.js"), "window.a = 1");
    await m.sites.ouvrirParId("vidola");
    const site = m.sites.sitesOuverts.get("vidola")!;
    m.setVue("accord");
    return { m, site };
  }
  const accords = (m: { dataDir: string }) => lireAccordsSites(m.dataDir);

  it("with the card's fingerprint: writes the accord, tells the chrome (accord now covers), reads again without reloading", async () => {
    const { m, site } = await ouverte();
    expect(site.accordRequis).toBe(true);
    await m.sites.accorder("vidola", true, site.demande.empreinte);
    expect(Object.keys(await accords(m))).toEqual(["vidola"]);
    expect(m.calls.apres).toEqual([["vidola", expect.objectContaining({ accordRequis: false })]]);
    await vi.waitFor(() => expect(m.calls.majs.length).toBeGreaterThan(0), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(m.calls.recharges).toEqual([]);
  });

  it("a stale fingerprint: nothing is written, the chrome shows the card again", async () => {
    const { m } = await ouverte();
    await m.sites.accorder("vidola", true, "0".repeat(64));
    expect(await accords(m)).toEqual({});
    expect(m.calls.apres).toEqual([]);
    expect(m.calls.rediffuser).toEqual(["vidola"]);
  });

  it("« Ouvrir sans retouches »: the next view without any accord", async () => {
    const { m, site } = await ouverte();
    await m.sites.accorder("vidola", false, site.demande.empreinte);
    expect(await accords(m)).toEqual({});
    expect(m.calls.apres).toEqual([["vidola", null]]);
  });

  it.each([["site"], [null]] as const)("when the window shows %s, not the card: nothing happens", async (vue) => {
    const { m, site } = await ouverte();
    m.setVue(vue);
    await m.sites.accorder("vidola", true, site.demande.empreinte);
    expect(await accords(m)).toEqual({});
    expect(m.calls.apres).toEqual([]);
    expect(m.calls.rediffuser).toEqual([]);
  });

  it("an app that is not open grants nothing", async () => {
    const m = mount();
    m.setVue("accord");
    await m.sites.accorder("vidola", true, "0".repeat(64));
    expect(await accords(m)).toEqual({});
    expect(m.calls.apres).toEqual([]);
  });

  it("accorder during a deletion grants nothing (Review Focus 4)", async () => {
    const { m, site } = await ouverte();
    let lache!: () => void;
    m.retenir(new Promise<void>((ok) => (lache = ok)));
    const suppression = m.sites.agir("vidola", "supprimer", "f1");
    await vi.waitFor(() => expect(m.journal).toContain("fermer vidola"));
    await m.sites.accorder("vidola", true, site.demande.empreinte);
    lache();
    await suppression;
    expect(await accords(m)).toEqual({});
    expect(m.calls.apres).toEqual([]);
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

describe("site rights, card and memory", () => {
  const demandee = {
    ...declaration,
    connexion: ["compte.example"],
    retouches: [
      { correspond: ["/serie/*"], js: ["a.js"], css: ["cacher.css"], cadres: ["https://lecteur.example/*"] },
      { correspond: ["/serie/*"], js: ["a.js"], css: [], cadres: false as const },
    ],
  };

  it("empreinteDroits follows the rights only", () => {
    const d = DeclarationSite.parse(demandee);
    // Rights drift: another sign-in domain changes it; a description does not.
    expect(empreinteDroits(DeclarationSite.parse({ ...demandee, connexion: ["autre.example"] }))).not.toBe(empreinteDroits(d));
    expect(empreinteDroits(DeclarationSite.parse({ ...demandee, description: "autre" }))).toBe(empreinteDroits(d));
  });

  it("demandeAccord gives the card (e2e 43): rights, files without duplicates, followed domains, fingerprint", () => {
    const d = DeclarationSite.parse(demandee);
    const carte = demandeAccord({ id: "vidola", declaration: d, aAccueil: false, domaines: ["vidola-a.example", "VIDOLA-C.example"], depart: "https://vidola-a.example/", accordRequis: true });
    expect(carte).toEqual({
      nom: "Vidola",
      domaines: ["vidola-a.example", "vidola-b.example"],
      connexion: ["compte.example"],
      cadres: ["https://lecteur.example/*"],
      reprise: true,
      fichiers: ["a.js", "cacher.css"],
      correspond: ["/serie/*"],
      suivis: ["vidola-c.example"],
      empreinte: empreinteDroits(d),
    });
  });

  it("SchemaActionSite accepts a plain id with a known action only", () => {
    const vs = [{ id: "vidola", action: "supprimer" }, { id: "../x", action: "supprimer" }, { id: "Vidola", action: "ouvrir" }, { id: "a", action: "autre" }, { id: ".corbeille", action: "relire" }];
    expect(vs.map((v) => SchemaActionSite.safeParse(v).success)).toEqual([true, false, false, false, false]);
  });

  it("SiteSouvenirs has its public methods and writes indented JSON of the whole map", async () => {
    for (const n of ["lire", "noter", "oublier", "vider"]) expect(typeof (SiteSouvenirs.prototype as unknown as Record<string, unknown>)[n]).toBe("function");
    const dossier = mkdtempSync(join(tmpdir(), "souvenirs-"));
    cleanup.push(() => rmSync(dossier, { recursive: true, force: true }));
    const s = new SiteSouvenirs(dossier);
    s.noter("vidola", { favicon: "f", cadre: { x: 1, y: 2, largeur: 3, hauteur: 4 } });
    await s.vider();
    expect(readFileSync(join(dossier, "sites.json"), "utf8")).toBe(JSON.stringify({ vidola: { favicon: "f", cadre: { x: 1, y: 2, largeur: 3, hauteur: 4 } } }, null, 2));
    expect(readdirSync(dossier)).toEqual(["sites.json"]);
  });
});
