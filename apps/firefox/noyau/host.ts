import type { Noyau, OngletInfo } from "../../../packages/noyau/src/index.ts";
import type { TailleTerminal } from "../../navigateur/src/commun/api.ts";

// The agent host: Firefox spawns it and talks JSON-RPC over stdin/stdout, one JSON message per line.
// stdout carries only the RPC: anything else written there would corrupt it, so it goes to stderr.
const writeStdout = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
console.log = console.info = console.debug = console.error;
// Firefox gone: its pipe breaks, and the end of stdin stops everything below.
process.stdout.on("error", () => {});
process.on("unhandledRejection", (e) => console.error("[webaios] rejet non géré :", e));

process.env.WEBAIOS_CONTENEUR ||= "webaios-atelier-firefox";
// Two containers cannot publish the same host ports: the Electron app keeps 5280-5299.
process.env.WEBAIOS_PORTS_CONTENEUR ||= "5300-5319";

const { join } = await import("node:path");
const { createInterface } = await import("node:readline");
// Imported after the env is set and stdout redirected: nothing in the noyau can write to stdout at load time.
const { chargerProfils, cheminsEspace, creerNoyau, prefixeContexte } = await import("../../../packages/noyau/src/index.ts");
const { SessionsAgent } = await import("../../navigateur/src/main/agent/sessions.ts");
const { Historique } = await import("../../navigateur/src/main/historique.ts");
const { createRpc } = await import("../shared/rpc.ts");
const { RemoteBridge } = await import("./remote-bridge.ts");
const { ExtensionsAgent } = await import("./extensions/agent.ts");

const dataDir = process.env.WEBAIOS_DATA_DIR;
if (!dataDir) {
  console.error("[webaios] WEBAIOS_DATA_DIR manquant");
  process.exit(2);
}
const racine = join(dataDir, "espace");
// Outside the agent's noyau: the history works even when the noyau does not start.
// Electron's retenable (capture-texte.ts) can't be imported here: it needs the extensionless "../historique" import, which Node refuses.
const MEMOIRE_BOUCLE = process.env.WEBAIOS_MEMOIRE_BOUCLE === "1";
// Keep in sync with apps/navigateur/src/main/onglets/capture-texte.ts.
const retenable = (url: string) => {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && (MEMOIRE_BOUCLE || !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));
  } catch {
    return false;
  }
};
// A broken database must not take the agent down: no history then (empty answers, no agent tools).
const historique = (() => {
  try {
    const h = new Historique(join(dataDir, "historique.sqlite"));
    h.purger();
    return h;
  } catch (e) {
    console.error("[webaios] l'historique n'a pas pu s'ouvrir :", e);
    return undefined;
  }
})();
const purge = setInterval(() => historique?.purger(), 6 * 60 * 60 * 1000);
purge.unref();
const duckduckgo = process.env.WEBAIOS_TEST_DUCKDUCKGO_URL;

let noyau: Noyau | null = null;
let erreur: string | null = null;
let pret: Promise<Noyau | null> = Promise.resolve(null);
let unsubscribe: (() => void) | undefined;
let accesTimer: NodeJS.Timeout | undefined;

const etatAcces = () => ({ agent: noyau?.agent ?? "L'agent", onglets: noyau?.politique.etat() ?? {} });
// A burst of policy changes gives one notification per 50 ms.
const diffuserAcces = () => {
  accesTimer ??= setTimeout(() => {
    accesTimer = undefined;
    rpc.notify("acces", etatAcces());
  }, 50);
};

const lancerNoyau = (profilId: string): Promise<Noyau | null> => {
  erreur = null;
  return creerNoyau({
    pont: bridge,
    profilId,
    racine,
    dossierWidgets: join(dataDir, "widgets"),
    dossierActions: join(dataDir, "actions"),
    dossierProfilage: join(dataDir, "profilage"),
    extensions: extensions.outils(),
    ...(process.env.WEBAIOS_TEST_ADRESSES_LOCALES === "1" ? { adressesLocales: true } : {}),
    ...(duckduckgo ? { urlRecherche: duckduckgo } : {}),
  }).then(
    (n) => {
      noyau = n;
      unsubscribe = n.politique.surChange(diffuserAcces);
      diffuserAcces();
      return n;
    },
    (e: Error) => {
      erreur = e.message;
      console.error("[webaios] le noyau n'a pas pu démarrer :", e);
      return null;
    },
  );
};

const arreterNoyau = async (n: Noyau | null) => {
  noyau = null;
  unsubscribe?.();
  unsubscribe = undefined;
  diffuserAcces();
  await n?.arreter();
};

const demarrer = async () => {
  const n = await pret;
  if (!n) throw new Error(erreur ?? "le noyau de l'agent n'a pas démarré");
  return { agent: n.agent };
};

let profil: string | null = null;
// Another profile: a new noyau (command, MCP config) and a new agent in every panel. Never two noyaux at once:
// two MCP servers would write the same mcp.json.
const changerProfil = (profilAgent: string) => {
  const relancer = profil !== null;
  profil = profilAgent;
  pret = pret.then(arreterNoyau).then(() => lancerNoyau(profilAgent));
  if (relancer) void sessions.relancerTout();
  return demarrer();
};

let stopping: Promise<void> | undefined;
const arreter = () =>
  (stopping ??= (async () => {
    extensions.arreter();
    await sessions.toutArreter();
    await arreterNoyau(await pret);
    clearInterval(purge);
    historique?.fermer();
  })());

const sessions = new SessionsAgent({
  async ouvrir(f, t) {
    const n = await pret;
    if (!n) throw new Error(erreur ?? "le noyau de l'agent n'a pas démarré");
    return n.ouvrirSessionAgent({ ...t, fenetre: f });
  },
  // The user talks to the agent from the tab on screen: it is given to the agent.
  surEnvoi: (f) => {
    rpc.request<OngletInfo | null>("ongletActif", [f]).then(
      (o) => o && noyau?.politique.interactionUtilisateur(o),
      () => {},
    );
  },
  envoyer: (fenetre, canal, v) => rpc.notify(canal === "donnees" ? "agent.donnees" : "agent.etat", canal === "donnees" ? { fenetre, d: v } : { fenetre, e: v }),
});

const rpc = createRpc({
  send: (line) => void writeStdout(line + "\n"),
  handlers: {
    // Repeated with the same profile: the running noyau stays (its sessions with it); a failed start is retried.
    demarrer: async (p: { profilAgent: string }) => {
      if (profil === p.profilAgent && (await pret)) return demarrer();
      return changerProfil(p.profilAgent);
    },
    changerProfil: (p: { profilAgent: string }) => changerProfil(p.profilAgent),
    "agent.demarrer": (p: { fenetre: string; taille: TailleTerminal }) => sessions.demarrer(p.fenetre, p.taille),
    "agent.profils": async () => {
      // The noyau writes the default profile while it starts: the panel may ask before that.
      await pret;
      try {
        return (await chargerProfils(cheminsEspace(racine))).profils.map((x) => ({ id: x.id, nom: x.nom }));
      } catch {
        return [];
      }
    },
    "acces.etat": etatAcces,
    "historique.noter": (p: Parameters<InstanceType<typeof Historique>["noter"]>[0]) => historique?.noter(p),
    "historique.titre": (p: { url: string; espaceId: string; titre: string }) => historique?.majTitre(p.url, p.espaceId, p.titre),
    "historique.retenir": (p: { url: string; espaceId: string; titre: string; texte: string }) => {
      if (retenable(p.url)) historique?.retenir({ ...p, texte: String(p.texte) });
    },
    "historique.rendrePrive": (p: { espaceId: string }) => historique?.rendrePrive(p.espaceId),
    "historique.rechercher": (p: { texte: string; limite?: number; distinctes?: boolean }) => historique?.rechercher(p.texte, p.limite, p.distinctes) ?? [],
    "historique.recents": () => historique?.recents() ?? [],
    "historique.effacer": (p: { depuis?: string }) => historique?.effacer(p.depuis ? new Date(p.depuis) : undefined),
    "historique.oublierTexte": (p: { url: string; espaceId: string }) => historique?.oublierTexte(p.url, p.espaceId),
    arreter: async () => {
      try {
        await arreter();
      } finally {
        // Exit once the answer (or the error) is flushed: stdout is an asynchronous pipe on macOS.
        setImmediate(() => writeStdout("", () => process.exit(0)));
      }
    },
    "agent.ecrire": (p: { fenetre: string; d: string }) => sessions.ecrire(p.fenetre, p.d),
    "agent.redimensionner": (p: { fenetre: string; taille: TailleTerminal }) => sessions.redimensionner(p.fenetre, p.taille),
    "agent.fermerFenetre": (p: { fenetre: string }) => void sessions.fermerFenetre(p.fenetre),
    prives: (p: { prives: string[]; actifPrive: boolean }) => bridge.setPrivate(p),
    "politique.navigue": (p: { id: string; url: string }) => noyau?.politique.ongletNavigue(p.id, p.url),
    "politique.ferme": (p: { id: string }) => noyau?.politique.ongletFerme(p.id),
    "politique.couper": (p: { id: string; droit?: Parameters<Noyau["politique"]["couper"]>[1] }) => noyau?.politique.couper(p.id, p.droit),
    "agent.envoi": (p: { onglet: OngletInfo | null }) => void (p.onglet && noyau?.politique.interactionUtilisateur(p.onglet)),
    // Opening the panel on a tab gives it to the agent and pre-fills the context, without sending it.
    "agent.panneauOuvert": (p: { fenetre: string; onglet: OngletInfo }) => {
      noyau?.politique.interactionUtilisateur(p.onglet);
      if (sessions.active(p.fenetre)) sessions.ecrire(p.fenetre, prefixeContexte(p.onglet.titre, p.onglet.url));
    },
    // Sent by the chrome on each host start, with the about:addons changes seen while no host ran (applied first:
    // never reinstalled); answered when every granted extension is handled. A failed start is retried by the next one.
    "extensions.pret": async (p: { horsWebaios?: { addonId: string; quoi: "desinstallee" | "desactivee" }[] }) => {
      for (const h of p?.horsWebaios ?? []) await extensions.horsWebaios(h.addonId, h.quoi);
      return (demarrageExtensions ??= extensions.demarrer().catch((e) => {
        demarrageExtensions = undefined;
        throw e;
      }));
    },
    "extensions.horsWebaios": (p: { addonId: string; quoi: "desinstallee" | "desactivee" }) =>
      extensions.horsWebaios(p.addonId, p.quoi),
    ...(process.env.WEBAIOS_HOST_TEST === "1" ? { "debug.log": (p: { texte: string }) => console.log(p.texte) } : {}),
  },
});
const bridge = new RemoteBridge(rpc, historique);
// Outside the agent's noyau, like the history: granted extensions run even when the noyau does not start.
const extensions = new ExtensionsAgent({ dossier: join(dataDir, "extensions"), dossierAgent: cheminsEspace(racine).extensions, rpc });
let demarrageExtensions: Promise<void> | undefined;

createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on("line", (l) => rpc.receive(l))
  .on("close", () => {
    rpc.close("Firefox s'est arrêté");
    // A stop that hangs (docker, a session) must not keep an orphan host alive.
    setTimeout(() => process.exit(0), 5_000).unref();
    void arreter().finally(() => process.exit(0));
  });
