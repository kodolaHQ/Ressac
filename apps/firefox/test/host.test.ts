import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  const { WEBAIOS_CONTENEUR: _, ...parent } = process.env;
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
