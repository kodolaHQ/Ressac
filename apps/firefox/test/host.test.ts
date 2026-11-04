import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { DEMANDE_RETIREE, ERREUR_PROFIL_PRIVE } from "../../../packages/noyau/src/index";
import { TEXTE_PRIVE } from "../../../packages/noyau/src/mcp/pont";
import { hostPath, nodePath, tsxPath } from "../scripts/paths";
import { createRpc, type Handler, type Rpc } from "../shared/rpc";
import { installationImpossible } from "../noyau/extensions/agent";
import { CLES_ABSENTES, signatureRefusee } from "../noyau/extensions/amo";
import type { CarteExtension, ReponseAccord } from "../../navigateur/src/commun/extensions";
import { startFakeAmo } from "./fake-amo";
import { appelerOutil } from "./mcp";

const outils = join(import.meta.dirname, "outils");
const tabs = [
  { id: "t1", titre: "Un", url: "https://un.test/", espace: "Perso" },
  { id: "t2", titre: "Deux", url: "https://deux.test/", espace: "Perso" },
];
// 2 KB: a PNG signature followed by filler, enough to check the bytes go through unchanged.
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2040, 7)]).toString("base64");

interface Host {
  child: ChildProcessWithoutNullStreams;
  rpc: Rpc;
  dataDir: string;
  racine: string;
  journal: string;
  stderr: () => string;
  donnees: () => string;
  etats: unknown[];
  exited: Promise<number | null>;
}

const hosts: Host[] = [];

/** `o.dataDir`: restart on that folder; `o.handlers`: more requests answered as Firefox. */
function startHost(env: Record<string, string> = {}, prepare?: (dataDir: string) => void, o: { dataDir?: string; handlers?: Record<string, Handler> } = {}): Host {
  const dataDir = o.dataDir ?? realpathSync(mkdtempSync(join(tmpdir(), "webaios-host-")));
  prepare?.(dataDir);
  const racine = join(dataDir, "espace");
  const journal = join(dataDir, "docker.log");
  const { WEBAIOS_CONTENEUR: _, WEBAIOS_PORTS_CONTENEUR: __, ...parent } = process.env;
  const child = spawn(nodePath, ["--import", tsxPath, hostPath], {
    env: {
      ...parent,
      WEBAIOS_DATA_DIR: dataDir,
      // The fake docker and fake agent write their traces there.
      WEBAIOS_RACINE: racine,
      FAUX_DOCKER_JOURNAL: journal,
      WEBAIOS_HOST_TEST: "1",
      PATH: `${outils}:${process.env.PATH}`,
      ...env,
    },
  });
  let err = "";
  let donnees = "";
  const etats: unknown[] = [];
  child.stderr.on("data", (d) => (err += d));
  const rpc = createRpc({
    send: (l) => child.stdin.write(l + "\n"),
    handlers: {
      ongletActif: () => tabs[0],
      listerOnglets: () => tabs,
      lireTexte: ([id]: [string]) => ({ texte: `texte de ${id}` }),
      capturer: () => png,
      demanderAutorisation: () => true,
      "agent.donnees": (p: { d: string }) => void (donnees += p.d),
      "agent.etat": (p: { e: unknown }) => void etats.push(p.e),
      ...o.handlers,
    },
  });
  createInterface({ input: child.stdout }).on("line", (l) => rpc.receive(l));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => (rpc.close(`host exited: ${err}`), r(code))));
  const h = { child, rpc, dataDir, racine, journal, stderr: () => err, donnees: () => donnees, etats, exited };
  hosts.push(h);
  return h;
}

async function until(f: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}

afterEach(async () => {
  for (const h of hosts.splice(0)) {
    if (h.child.exitCode === null) {
      h.child.kill("SIGKILL");
      await h.exited;
    }
    // Detached fake docker calls started before the host exited can still append to the journal for a moment.
    const rm = () => rmSync(h.dataDir, { recursive: true, force: true });
    try {
      rm();
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
      rm();
    }
  }
});

describe("agent host", { timeout: 30_000 }, () => {
  it("creates the space and MCP config, lister_onglets goes through Firefox", async () => {
    const h = startHost();
    expect(await h.rpc.request("demarrer", { profilAgent: "claude" })).toEqual({ agent: expect.any(String) });
    expect(existsSync(join(h.racine, ".webaios", "mcp.json"))).toBe(true);
    const r = await appelerOutil(h.racine, "lister_onglets");
    expect(r.texte).toContain("onglet non partagé");
  });

  it("a private tab is hidden from the agent", async () => {
    const h = startHost();
    await h.rpc.request("demarrer", { profilAgent: "claude" });
    expect((await appelerOutil(h.racine, "lire_onglet", { id: "t3" })).texte).not.toBe(TEXTE_PRIVE);
    h.rpc.notify("prives", { prives: ["t3"], actifPrive: true });
    await h.rpc.request("acces.etat"); // stdin is read in order: the notification is applied
    expect((await appelerOutil(h.racine, "lire_onglet", { id: "t3" })).texte).toBe(TEXTE_PRIVE);
    expect((await appelerOutil(h.racine, "page_courante")).texte).toBe(TEXTE_PRIVE);
  });

  it("capture_ecran returns the PNG Firefox sent", async () => {
    const h = startHost();
    await h.rpc.request("demarrer", { profilAgent: "claude" });
    expect((await appelerOutil(h.racine, "capture_ecran", { id: "t1" })).image).toBe(png);
  });

  it("the terminal reaches the fake agent", async () => {
    const h = startHost();
    await h.rpc.request("demarrer", { profilAgent: "claude" });
    await h.rpc.request("agent.demarrer", { fenetre: "f1", taille: { cols: 80, rows: 24 } });
    await until(() => h.donnees().includes("faux agent prêt>"));
    h.rpc.notify("agent.ecrire", { fenetre: "f1", d: "bonjour\r" });
    await until(() => h.donnees().includes("bonjour"));
  });

  it("a repeat demarrer with the same profile keeps the noyau and its sessions", async () => {
    const h = startHost();
    await h.rpc.request("demarrer", { profilAgent: "claude" });
    await h.rpc.request("agent.demarrer", { fenetre: "f1", taille: { cols: 80, rows: 24 } });
    await until(() => h.donnees().includes("faux agent prêt>"));
    const mcp = readFileSync(join(h.racine, ".webaios", "mcp.json"), "utf8");
    const arrets = readFileSync(join(h.racine, "faux-docker-arrets.log"), "utf8"); // start-up orphan sweep only
    expect(await h.rpc.request("demarrer", { profilAgent: "claude" })).toEqual({ agent: expect.any(String) });
    expect(readFileSync(join(h.racine, ".webaios", "mcp.json"), "utf8")).toBe(mcp);
    h.rpc.notify("agent.ecrire", { fenetre: "f1", d: "encore\r" });
    await until(() => h.donnees().includes("encore"));
    expect(readFileSync(join(h.racine, "faux-docker-arrets.log"), "utf8")).toBe(arrets);
  });

  it("agent.profils asked while the noyau starts lists the default profile it prepares", async () => {
    const h = startHost();
    mkdirSync(join(h.racine, ".webaios", "profils"), { recursive: true });
    writeFileSync(join(h.racine, ".webaios", "profils", "autre.json"), JSON.stringify({ id: "autre", nom: "Autre", interactif: ["a"], nonInteractif: ["a"], configMcp: "claude-json" }));
    const started = h.rpc.request("demarrer", { profilAgent: "claude" });
    expect((await h.rpc.request<{ id: string }[]>("agent.profils")).map((p) => p.id)).toEqual(["autre", "claude"]);
    await started;
  });

  it("demarrer with another profile restarts the sessions", async () => {
    const h = startHost();
    await h.rpc.request("demarrer", { profilAgent: "claude" });
    const profils = join(h.racine, ".webaios", "profils");
    writeFileSync(join(profils, "autre.json"), readFileSync(join(profils, "claude.json"), "utf8").replace('"id": "claude"', '"id": "autre"'));
    await h.rpc.request("agent.demarrer", { fenetre: "f1", taille: { cols: 80, rows: 24 } });
    await until(() => h.donnees().includes("faux agent prêt>"));
    const arrets = join(h.racine, "faux-docker-arrets.log");
    const avant = readFileSync(arrets, "utf8");
    h.etats.length = 0;
    await h.rpc.request("demarrer", { profilAgent: "autre" });
    await until(() => h.etats.some((e) => (e as { etat: string }).etat === "actif"));
    // The old session was stopped in the container.
    await until(() => readFileSync(arrets, "utf8").slice(avant.length).includes("webaios-session-"));
  });

  it("docker absent → etat docker-absent", async () => {
    const h = startHost({ FAUX_DOCKER_ABSENT: "1" });
    await h.rpc.request("demarrer", { profilAgent: "claude" });
    await h.rpc.request("agent.demarrer", { fenetre: "f1", taille: { cols: 80, rows: 24 } });
    await until(() => h.etats.some((e) => (e as { etat: string }).etat === "docker-absent"));
  });

  it("a console.log in the host never reaches stdout", async () => {
    const h = startHost();
    h.rpc.notify("debug.log", { texte: "bruit-sur-stdout" });
    expect(await h.rpc.request("acces.etat")).toEqual({ agent: expect.any(String), onglets: {} });
    expect(h.stderr()).toContain("bruit-sur-stdout");
  });

  it("uses its own docker container", async () => {
    const h = startHost();
    await h.rpc.request("demarrer", { profilAgent: "claude" });
    await h.rpc.request("agent.demarrer", { fenetre: "f1", taille: { cols: 80, rows: 24 } });
    await until(() => h.donnees().includes("faux agent prêt>"));
    const lignes = readFileSync(h.journal, "utf8").split("\n");
    expect(lignes.some((l) => l.includes("webaios-atelier-firefox"))).toBe(true);
    expect(lignes.filter((l) => / webaios-atelier( |$)/.test(l))).toEqual([]);
  });

  it("publishes its own port range, apart from the Electron app's 5280-5299", async () => {
    const h = startHost({ FAUX_DOCKER_SANS_CONTENEUR: "1" });
    await h.rpc.request("demarrer", { profilAgent: "claude" });
    await h.rpc.request("agent.demarrer", { fenetre: "f1", taille: { cols: 80, rows: 24 } });
    await until(() => h.donnees().includes("faux agent prêt>"));
    const run = readFileSync(h.journal, "utf8").split("\n").find((l) => l.startsWith("run -d"));
    expect(run).toContain("127.0.0.1:5300-5319:5300-5319");
    expect(run).toContain("WEBAIOS_PORTS=5300-5319");
  });

  it("arreter stops sessions, then the process exits 0", async () => {
    const h = startHost();
    await h.rpc.request("demarrer", { profilAgent: "claude" });
    await h.rpc.request("agent.demarrer", { fenetre: "f1", taille: { cols: 80, rows: 24 } });
    await until(() => h.donnees().includes("faux agent prêt>"));
    await h.rpc.request("arreter");
    expect(await h.exited).toBe(0);
    expect(readFileSync(join(h.racine, "faux-docker-arrets.log"), "utf8")).toContain("webaios-session");
  });

  it("stdin closed → the host exits", async () => {
    const h = startHost();
    await h.rpc.request("demarrer", { profilAgent: "claude" });
    h.child.stdin.end();
    expect(await h.exited).toBe(0);
  });
});

describe("history", { timeout: 30_000 }, () => {
  const visit = (h: Host, url: string, titre: string, o: { prive?: boolean; espaceId?: string } = {}) =>
    h.rpc.notify("historique.noter", { url, titre, espaceId: o.espaceId ?? "e1", prive: o.prive ?? false });

  // A notification runs a microtask after its line, a request at once: a round trip lets the notifications before it land.
  const settle = (h: Host) => h.rpc.request("acces.etat");

  it("noted visits are searched, cleared and survive the agent's noyau", async () => {
    // No docker, no demarrer: the history must not need the agent's noyau.
    const h = startHost();
    visit(h, "https://a.test/", "Page A");
    h.rpc.notify("historique.titre", { url: "https://a.test/", espaceId: "e1", titre: "Page A bis" });
    await settle(h);
    expect(await h.rpc.request("historique.rechercher", { texte: "page a" })).toEqual([
      expect.objectContaining({ titre: "Page A bis", visites: 1, prive: false }),
    ]);
    await h.rpc.request("historique.effacer", {});
    expect(await h.rpc.request("historique.recents", {})).toEqual([]);
  });

  it("chercher_historique finds a non-private visit, never a private one", async () => {
    const h = startHost();
    await h.rpc.request("demarrer", { profilAgent: "claude" });
    visit(h, "https://a.test/", "Alpha");
    visit(h, "https://b.test/", "Alpha privé", { prive: true });
    await settle(h);
    const r = await appelerOutil(h.racine, "chercher_historique", { requete: "alpha" });
    expect(r.texte).toContain("a.test");
    expect(r.texte).not.toContain("b.test");
    expect((await appelerOutil(h.racine, "lire_historique", { url: "https://a.test/" })).texte).toBe("Rien de retenu pour cette page.");
  });

  it("retained text is found by the agent, never for a loopback URL", async () => {
    const h = startHost();
    await h.rpc.request("demarrer", { profilAgent: "claude" });
    visit(h, "https://a.test/", "Alpha");
    h.rpc.notify("historique.retenir", { url: "https://a.test/", espaceId: "e1", titre: "Alpha", texte: "Le chat dort" });
    visit(h, "http://127.0.0.1/x", "Local");
    h.rpc.notify("historique.retenir", { url: "http://127.0.0.1/x", espaceId: "e1", titre: "Local", texte: "Le chien veille" });
    await settle(h);
    expect((await appelerOutil(h.racine, "chercher_historique", { requete: "chat" })).texte).toContain("a.test");
    expect((await appelerOutil(h.racine, "lire_historique", { url: "https://a.test/" })).texte).toContain("Le chat dort");
    const recents = (await h.rpc.request("historique.recents", {})) as { url: string; retenu: boolean }[];
    expect(recents.find((v) => v.url === "http://127.0.0.1/x")?.retenu).toBe(false);
  });

  it("an unreadable history database leaves the host and the agent running, without history", async () => {
    // A directory where the SQLite file should be: opening it throws.
    const h = startHost({}, (d) => mkdirSync(join(d, "historique.sqlite")));
    visit(h, "https://a.test/", "Page A");
    expect(await h.rpc.request("historique.recents", {})).toEqual([]);
    expect(await h.rpc.request("historique.rechercher", { texte: "page" })).toEqual([]);
    await h.rpc.request("demarrer", { profilAgent: "claude" });
    await h.rpc.request("agent.demarrer", { fenetre: "f1", taille: { cols: 80, rows: 24 } });
    await until(() => h.donnees().includes("faux agent prêt>"));
    expect(h.stderr()).toContain("historique");
  });

  it("a space turned private marks its visits", async () => {
    const h = startHost();
    visit(h, "https://a.test/", "Page A");
    h.rpc.notify("historique.rendrePrive", { espaceId: "e1" });
    await settle(h);
    expect(await h.rpc.request("historique.recents", {})).toEqual([expect.objectContaining({ espaceId: "e1", prive: true })]);
  });
});

describe("agent extensions", { timeout: 60_000 }, () => {
  const HOTE = "http://127.0.0.1/*";
  const ACCORD = { permissions: [], hotes: [HOTE], reseau: [], tousLesSites: false, scriptsTousLesSites: false, scripts: true };
  const ID = "ma-ext@agent.webaios";
  const amos: Awaited<ReturnType<typeof startFakeAmo>>[] = [];
  afterEach(async () => {
    for (const a of amos.splice(0)) await a.close();
  });
  const fakeAmo = async (o?: Parameters<typeof startFakeAmo>[0]) => {
    const a = await startFakeAmo(o);
    amos.push(a);
    return a;
  };

  /** The agent's source in `<dataDir>/espace/extensions/ma-ext`: a classic service worker and a content script CSS. */
  const source = (dataDir: string, o: { hotes?: string[]; css?: string } = {}) => {
    const dir = join(dataDir, "espace", "extensions", "ma-ext");
    mkdirSync(dir, { recursive: true });
    const manifest = { manifest_version: 3, name: "Cacheur", version: "1.0.0", background: { service_worker: "fond.js" }, content_scripts: [{ matches: o.hotes ?? [HOTE], css: ["cache.css"] }] };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(dir, "fond.js"), "console.log('fond');\n");
    writeFileSync(join(dir, "cache.css"), o.css ?? "#cache-moi { display: none }\n");
  };
  const grant = (dataDir: string, profils = ["defaut"]) => {
    mkdirSync(join(dataDir, "extensions"), { recursive: true });
    const entree = { source: "agent", idChrome: null, nom: "Cacheur", version: "1.0.0", accord: ACCORD, profils, epinglee: false, modifieeLe: null, desactivee: null, majEnAttente: null, vues: {} };
    writeFileSync(join(dataDir, "extensions", "etat.json"), JSON.stringify({ version: 1, toutesCoupees: false, extensions: { "agent:ma-ext": entree } }));
  };
  const entree = (dataDir: string) => (JSON.parse(readFileSync(join(dataDir, "extensions", "etat.json"), "utf8")) as { extensions: Record<string, any> }).extensions["agent:ma-ext"];

  /**
   * Firefox's side, as the chrome does it: an inactive add-on is never installed fresh, the same version is not
   * reinstalled. Notes each real install (with the .xpi's hash and manifest, read before the noyau moves it), every
   * installer call, activation and uninstall. `casse`: installs throw.
   */
  const firefox = () => {
    const installs: { addonId: string; version: string; temporaire: boolean; sha: string; manifeste: any }[] = [];
    const appels: { version: string; actif: boolean }[] = [];
    const activations: { addonId: string; actif: boolean }[] = [];
    const desinstallations: string[] = [];
    const presents = new Map<string, string>();
    const f = {
      installs,
      appels,
      activations,
      desinstallations,
      presents,
      casse: false,
      espaces: [{ id: "e1", nom: "Perso", profil: "defaut", prive: false }] as { id: string; nom: string; profil: string; prive: boolean }[],
      /** The grant cards asked, and the answer given to each (default: Activer). */
      cartes: [] as CarteExtension[],
      /** Every extensions.portees notification, in order. */
      portees: [] as Record<string, unknown>[],
      reponse: (c: CarteExtension): ReponseAccord => ({ accepte: true, empreinte: c.empreinte }),
      handlers: {} as Record<string, Handler>,
    };
    f.handlers = {
      "extensions.installer": (p: { addonId: string; xpi: string; temporaire: boolean; version: string; actif: boolean }) => {
        appels.push({ version: p.version, actif: p.actif });
        if ((!p.actif && !presents.has(p.addonId)) || presents.get(p.addonId) === p.version) return null;
        if (f.casse) throw new Error("boom");
        const manifeste = JSON.parse(execFileSync("unzip", ["-p", p.xpi, "manifest.json"]).toString());
        installs.push({ addonId: p.addonId, version: p.version, temporaire: p.temporaire, sha: createHash("sha256").update(readFileSync(p.xpi)).digest("hex"), manifeste });
        presents.set(p.addonId, p.version);
        return { version: p.version };
      },
      "extensions.activer": (p: { addonId: string; actif: boolean }) => void activations.push(p),
      "extensions.desinstaller": (p: { addonId: string }) => void (desinstallations.push(p.addonId), presents.delete(p.addonId)),
      "extensions.accord": (p: { carte: CarteExtension }) => (f.cartes.push(p.carte), f.reponse(p.carte)),
      "navigateur.espaces": () => ({ espaces: f.espaces, fenetres: [{ id: "f1", espaceActif: "e1" }], premierPlan: "f1" }),
      "extensions.portees": (p: Record<string, unknown>) => void f.portees.push(p),
    };
    return f;
  };

  // Temporary add-ons are gone after a quit.
  // `cles: false`: no AMO keys.
  const launch = (amo: { url: string }, f: ReturnType<typeof firefox>, o: { dataDir?: string; prepare?: (d: string) => void; cles?: false } = {}) => {
    f.presents.clear();
    const cles: Record<string, string> = o.cles === false ? {} : { WEBAIOS_TEST_AMO_CLES: "user:1:abc:test-secret" };
    return startHost({ WEBAIOS_TEST_AMO_URL: amo.url, ...cles }, o.prepare, { dataDir: o.dataDir, handlers: f.handlers });
  };
  /** An agent tool, once the noyau runs. */
  const outil = async (h: Host, nom: string, args: Record<string, unknown> = {}) => {
    await h.rpc.request("demarrer", { profilAgent: "claude" });
    return (await appelerOutil(h.racine, nom, args)).texte;
  };
  const stop = async (h: Host) => {
    await h.rpc.request("arreter");
    await h.exited;
  };
  const prepare = (d: string) => (source(d), grant(d));

  it("a granted extension is copied, signed, installed; restart with an unchanged source sends nothing", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    let h = launch(amo, f, { prepare });
    await h.rpc.request("extensions.pret", {});
    expect(amo.envois.map((e) => [e.guid, e.version])).toEqual([[ID, "1.0.0.1"]]);
    expect(f.installs).toEqual([expect.objectContaining({ addonId: ID, version: "1.0.0.1", temporaire: true })]);
    expect(f.activations).toEqual([{ addonId: ID, actif: true }]);
    expect(entree(h.dataDir)).toMatchObject({ idChrome: ID, accord: ACCORD, desactivee: null });
    // Sent first at startup (before the install), then after each registry change.
    const portee = { [ID]: { cle: "agent:ma-ext", accord: ACCORD, profils: ["defaut"], actif: true } };
    expect(f.portees[0]).toEqual(portee);
    expect(f.portees.at(-1)).toEqual(portee);
    await stop(h);

    h = launch(amo, f, { dataDir: h.dataDir });
    await h.rpc.request("extensions.pret", {});
    expect(amo.envois).toHaveLength(1);
    expect(f.installs).toHaveLength(2);
    expect(f.installs[1]).toMatchObject({ version: "1.0.0.1", sha: f.installs[0]!.sha });
  });

  it("a classic service_worker background becomes background.scripts [guard, original] in the signed copy", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    const h = launch(amo, f, { prepare });
    await h.rpc.request("extensions.pret", {});
    expect(f.installs[0]!.manifeste.background).toEqual({ scripts: ["webaios-garde-fond.js", "fond.js"] });
    expect(f.installs[0]!.manifeste.browser_specific_settings.gecko.id).toBe(ID);
  });

  it("source changed while closed: signed again at startup; a new site disables it, grant kept", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    let h = launch(amo, f, { prepare });
    await h.rpc.request("extensions.pret", {});
    await stop(h);
    source(h.dataDir, { css: "#cache-moi, #reste { display: none }\n" });
    h = launch(amo, f, { dataDir: h.dataDir });
    await h.rpc.request("extensions.pret", {});
    expect(f.installs.map((i) => i.version)).toEqual(["1.0.0.1", "1.0.0.2"]);
    expect(entree(h.dataDir).desactivee).toBeNull();
    await stop(h);

    source(h.dataDir, { hotes: [HOTE, "https://exemple.com/*"] });
    f.activations.length = 0;
    h = launch(amo, f, { dataDir: h.dataDir });
    await h.rpc.request("extensions.pret", {});
    expect(amo.envois).toHaveLength(2);
    expect(f.installs).toHaveLength(2);
    expect(entree(h.dataDir)).toMatchObject({ accord: ACCORD, desactivee: { raison: "portee-elargie" } });
    expect(f.activations).toEqual([{ addonId: ID, actif: false }]);
  });

  it("two reloads in a row: serialized, strictly increasing, the last one installed", async () => {
    const amo = await fakeAmo({ delaiMs: 500 });
    const f = firefox();
    const h = launch(amo, f, { prepare });
    await h.rpc.request("demarrer", { profilAgent: "claude" });
    const [a, b] = await Promise.all([outil(h, "recharger_extension", { id: "ma-ext" }), outil(h, "recharger_extension", { id: "ma-ext" })]);
    expect([a, b]).toEqual(["etat : rechargee", "etat : rechargee"]);
    expect(amo.envois.map((e) => e.version)).toEqual(["1.0.0.1", "1.0.0.2"]);
    expect(f.installs.at(-1)!.version).toBe("1.0.0.2");
    expect(JSON.parse(readFileSync(join(h.dataDir, "extensions", "signes", "ma-ext.json"), "utf8")).version).toBe("1.0.0.2");
  });

  it("a failed signature leaves the running version", async () => {
    const f = firefox();
    let h = launch(await fakeAmo(), f, { prepare });
    await h.rpc.request("extensions.pret", {});
    await stop(h);
    source(h.dataDir, { css: "#reste { display: none }\n" });
    h = launch(await fakeAmo({ refus: "Validation failed: eval" }), f, { dataDir: h.dataDir });
    const r = await outil(h, "recharger_extension", { id: "ma-ext" });
    expect(r).toContain("etat : refusee");
    expect(r).toContain(signatureRefusee("Validation failed: eval"));
    expect(r).not.toContain("test-secret");
    expect(JSON.parse(readFileSync(join(h.dataDir, "extensions", "signes", "ma-ext.json"), "utf8")).version).toBe("1.0.0.1");
    expect(f.installs).toHaveLength(1);
    expect(existsSync(join(h.dataDir, "extensions", "signes", "ma-ext.xpi"))).toBe(true);
  });

  it("removed from about:addons: grant deleted, never reinstalled", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    let h = launch(amo, f, { prepare });
    await h.rpc.request("extensions.pret", {});
    h.rpc.notify("extensions.horsWebaios", { addonId: ID, quoi: "desinstallee" });
    await until(() => entree(h.dataDir) === undefined);
    await until(() => JSON.stringify(f.portees.at(-1)) === "{}");
    expect(existsSync(join(h.dataDir, "extensions", "signes", "ma-ext.xpi"))).toBe(false);
    await stop(h);
    h = launch(amo, f, { dataDir: h.dataDir });
    await h.rpc.request("extensions.pret", {});
    expect(f.installs).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(h.dataDir, "extensions", "amo-versions.json"), "utf8"))).toEqual({ "ma-ext": 1 });
  });

  it("a first install of an inactive grant never makes the add-on active", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    const h = launch(amo, f, { prepare: (d) => (source(d), grant(d, [])) });
    await h.rpc.request("extensions.pret", {});
    expect(amo.envois).toHaveLength(1);
    expect(f.appels.length).toBeGreaterThan(0);
    expect(f.appels.every((a) => a.actif === false)).toBe(true);
    expect(f.installs).toEqual([]);
    expect(f.activations.some((a) => a.actif)).toBe(false);
    expect(existsSync(join(h.dataDir, "extensions", "signes", "ma-ext.xpi"))).toBe(true);
  });

  it("a removal seen while the host was down comes with pret: not reinstalled, grant deleted", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    const h = launch(amo, f, { prepare });
    await h.rpc.request("extensions.pret", { horsWebaios: [{ addonId: ID, quoi: "desinstallee" }] });
    expect(f.installs).toEqual([]);
    expect(amo.envois).toEqual([]);
    expect(entree(h.dataDir)).toBeUndefined();
  });

  it("a failed startup can be retried by a later pret", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    // A directory where the registry should be: reading it throws.
    const h = launch(amo, f, { prepare: (d) => (source(d), mkdirSync(join(d, "extensions", "etat.json"), { recursive: true })) });
    await expect(h.rpc.request("extensions.pret", {})).rejects.toThrow();
    rmSync(join(h.dataDir, "extensions", "etat.json"), { recursive: true });
    grant(h.dataDir);
    await h.rpc.request("extensions.pret", {});
    expect(f.installs).toHaveLength(1);
  });

  it("a failed install gives a bounded French text and keeps nothing", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    f.casse = true;
    const h = launch(amo, f, { prepare });
    expect(await outil(h, "recharger_extension", { id: "ma-ext" })).toContain(installationImpossible("boom"));
    expect(existsSync(join(h.dataDir, "extensions", "signes", "ma-ext.json"))).toBe(false);
  });

  it("a profile used by a private space is taken out of the grant's profiles", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    f.espaces.push({ id: "e2", nom: "Secret", profil: "secret", prive: true });
    const h = launch(amo, f, { prepare: (d) => (source(d), grant(d, ["defaut", "secret"])) });
    await h.rpc.request("extensions.pret", {});
    expect(entree(h.dataDir).profils).toEqual(["defaut"]);
  });

  it("demander_extension: refused, nothing sent; Activer: signed and installed, then granted, « Activée »", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    // Nothing granted while the card shows, nor while it installs: the grant is written after the install.
    const accord = f.handlers["extensions.accord"]!;
    const installer = f.handlers["extensions.installer"]!;
    const sansAccord: boolean[] = [];
    const nonAccordee = () => !existsSync(join(h.dataDir, "extensions", "etat.json")) || !entree(h.dataDir)?.accord;
    f.handlers["extensions.accord"] = (p, s) => (sansAccord.push(nonAccordee()), accord(p, s));
    f.handlers["extensions.installer"] = (p, s) => (sansAccord.push(nonAccordee()), installer(p, s));
    const h = launch(amo, f, { prepare: source });
    f.reponse = (c) => ({ accepte: false, empreinte: c.empreinte });
    expect(await outil(h, "demander_extension", { id: "ma-ext" })).toBe("Refusée par l'utilisateur.");
    expect(amo.envois).toEqual([]);
    f.reponse = (c) => ({ accepte: true, empreinte: c.empreinte });
    expect(await outil(h, "demander_extension", { id: "ma-ext" })).toBe("Activée dans « Perso ».");
    expect(f.cartes[1]).toMatchObject({ cle: "agent:ma-ext", nom: "Cacheur", espace: "Perso", espaceId: "e1", sites: [HOTE], reseau: [] });
    expect(f.installs).toEqual([expect.objectContaining({ version: "1.0.0.1" })]);
    // Two cards, the signed install; then appliquer's call (same version: a no-op) once granted.
    expect(sansAccord).toEqual([true, true, true, false]);
    expect(entree(h.dataDir)).toMatchObject({ idChrome: ID, accord: ACCORD, profils: ["defaut"], desactivee: null });
    expect(f.activations.at(-1)).toEqual({ addonId: ID, actif: true });
    // Already granted and active there: nothing asked again.
    expect(await outil(h, "demander_extension", { id: "ma-ext" })).toBe("Activée dans « Perso ».");
    expect(f.cartes).toHaveLength(2);
    expect(await outil(h, "lister_extensions")).toContain("agent:ma-ext · Cacheur · 1.0.0 · agent · actives dans : Perso · erreurs : aucune");
  });

  it("demander_extension without AMO keys: clear error, no card asked, nothing sent", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    const h = launch(amo, f, { prepare: source, cles: false });
    const r = await outil(h, "demander_extension", { id: "ma-ext" });
    expect(r).toContain("Clés AMO absentes");
    expect(r).toBe(CLES_ABSENTES);
    expect(f.cartes).toEqual([]);
    expect(amo.envois).toEqual([]);
  });

  it("nativeMessaging is refused by the copy, before any card", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    const h = launch(amo, f, {
      prepare: (d) => {
        source(d);
        const chemin = join(d, "espace", "extensions", "ma-ext", "manifest.json");
        writeFileSync(chemin, JSON.stringify({ ...JSON.parse(readFileSync(chemin, "utf8")), permissions: ["nativeMessaging"] }));
      },
    });
    expect(await outil(h, "demander_extension", { id: "ma-ext" })).toContain("Droit refusé : nativeMessaging");
    expect(f.cartes).toEqual([]);
    expect(amo.envois).toEqual([]);
  });

  it("recharger_extension: a new site disables it (grant kept), the card comes back", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    const h = launch(amo, f, { prepare: source });
    expect(await outil(h, "demander_extension", { id: "ma-ext" })).toBe("Activée dans « Perso ».");
    source(h.dataDir, { hotes: [HOTE, "https://exemple.com/*"] });
    const r = await outil(h, "recharger_extension", { id: "ma-ext" });
    expect(r).toContain("etat : desactivee");
    expect(r).toContain("demander_extension");
    expect(entree(h.dataDir)).toMatchObject({ accord: ACCORD, desactivee: { raison: "portee-elargie" } });
    expect(f.activations.at(-1)).toEqual({ addonId: ID, actif: false });
    expect(await outil(h, "demander_extension", { id: "ma-ext" })).toBe("Activée dans « Perso ».");
    expect(f.cartes).toHaveLength(2);
    expect(entree(h.dataDir)).toMatchObject({ accord: { hotes: [HOTE, "https://exemple.com/*"] }, desactivee: null });
    expect(f.installs.map((i) => i.version)).toEqual(["1.0.0.1", "1.0.0.2"]);
    expect(f.activations.at(-1)).toEqual({ addonId: ID, actif: true });
  });

  it("a space made private during the signing: error, the broader version does not run under the narrower grant", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    f.espaces.push({ id: "e2", nom: "Travail", profil: "travail", prive: false });
    const installer = f.handlers["extensions.installer"]!;
    // Turns Travail private as the broader version (1.0.0.2) is installed.
    f.handlers["extensions.installer"] = (p, s) => {
      if (p.version === "1.0.0.2") f.espaces[1]!.prive = true;
      return installer(p, s);
    };
    const h = launch(amo, f, { prepare });
    await h.rpc.request("extensions.pret", {});
    source(h.dataDir, { hotes: [HOTE, "https://exemple.com/*"] });
    expect(await outil(h, "demander_extension", { id: "ma-ext", espace: "Travail" })).toBe(ERREUR_PROFIL_PRIVE);
    expect(entree(h.dataDir)).toMatchObject({ accord: ACCORD, profils: ["defaut"], desactivee: { raison: "portee-elargie" } });
    expect(f.activations.at(-1)).toEqual({ addonId: ID, actif: false });
  });

  it("a space deleted during the signing: error, nothing granted, the add-on removed", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    f.espaces.push({ id: "e2", nom: "Travail", profil: "travail", prive: false });
    const installer = f.handlers["extensions.installer"]!;
    f.handlers["extensions.installer"] = (p, s) => {
      f.espaces.splice(1);
      return installer(p, s);
    };
    const h = launch(amo, f, { prepare: source });
    expect(await outil(h, "demander_extension", { id: "ma-ext", espace: "Travail" })).toBe("Espace disparu pendant la carte : rien n'est activé");
    expect(existsSync(join(h.dataDir, "extensions", "etat.json")) && entree(h.dataDir)).toBeFalsy();
    expect(f.desinstallations).toEqual([ID]);
  });

  it("a new conversation drops the card: « retirée », nothing sent, no grant", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    f.handlers["extensions.accord"] = (p: { carte: CarteExtension }, signal) => {
      f.cartes.push(p.carte);
      return new Promise((r) => signal.addEventListener("abort", () => r({ accepte: true, empreinte: p.carte.empreinte })));
    };
    const h = launch(amo, f, { prepare: source });
    const appel = outil(h, "demander_extension", { id: "ma-ext" });
    await until(() => f.cartes.length === 1);
    await h.rpc.request("agent.demarrer", { fenetre: "f1", taille: { cols: 80, rows: 24 } });
    expect(await appel).toBe(DEMANDE_RETIREE);
    expect(amo.envois).toEqual([]);
    expect(existsSync(join(h.dataDir, "extensions", "etat.json")) && entree(h.dataDir)).toBeFalsy();
    expect(existsSync(join(h.dataDir, "extensions", "copies", "ma-ext.attente"))).toBe(false);
  });
});
