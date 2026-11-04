import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { TEXTE_PRIVE } from "../../../packages/noyau/src/mcp/pont";
import { hostPath, nodePath, tsxPath } from "../scripts/paths";
import { createRpc, type Rpc } from "../shared/rpc";
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

function startHost(env: Record<string, string> = {}): Host {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "webaios-host-")));
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

  it("a space turned private marks its visits", async () => {
    const h = startHost();
    visit(h, "https://a.test/", "Page A");
    h.rpc.notify("historique.rendrePrive", { espaceId: "e1" });
    await settle(h);
    expect(await h.rpc.request("historique.recents", {})).toEqual([expect.objectContaining({ espaceId: "e1", prive: true })]);
  });
});
