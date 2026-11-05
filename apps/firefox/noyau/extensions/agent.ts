import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  activer,
  analyserManifeste,
  appliquerProfilsPrives,
  cleExtension,
  couperTout,
  DEMANDE_RETIREE,
  desactiver,
  desactiverPartout,
  ERREUR_PROFIL_PRIVE,
  GARDES_PAR_DEFAUT,
  libellesPortee,
  lireEtatExtensions,
  modifierEtatExtensions,
  porteeElargie,
  preparerCopie,
  retirer,
  type AnalyseManifeste,
  type ConsolePourAgent,
  type EntreeExtension,
  type EtatExtensions,
  type ExtensionPourAgent,
  type MessageConsole,
  type OutilsExtensions,
  type Portee,
  type ResultatConsoleExtension,
  type ResultatDemandeExtension,
} from "../../../../packages/noyau/src/index.ts";
import type { CarteExtension, LigneExtension, LigneExtensionEspace, ReponseAccord } from "../../../navigateur/src/commun/extensions.ts";
import type { ResultatExtension } from "../../../navigateur/src/commun/api.ts";
import { DESACTIVEE_PLANTAGES, DESACTIVEE_PORTEE, LONGUEUR_RAISON_DEBLOCAGE } from "../../../navigateur/src/commun/extensions-messages.ts";
import type { Espace, Issue } from "../../../navigateur/src/commun/modele.ts";
import { ConsolesExtensions, type FiltreAgent } from "../../../navigateur/src/main/extensions/consoles.ts";
import type { Rpc } from "../../shared/rpc.ts";
import { AMO_URL, CLES_ABSENTES, ErreurSignature, lireCleAmo, signatureImpossible, signer } from "./amo.ts";
import { carteDe, nonPrisEnCharge } from "./carte.ts";
import { addonIdDe, manifesteFirefox, prochaineVersion, refusFirefox, SUFFIXE_ID, zipper } from "./copie-firefox.ts";

// Keep in sync with apps/navigateur/src/main/extensions/agent.ts (texts and reperesDuChemin).
export const DOSSIER_ABSENT = "Dossier absent";
export const ACTIVATION_REFUSEE = "Activation refusée";
export const ACTIVATION_RETIREE = DEMANDE_RETIREE;
export const TOUTES_COUPEES_AGENT = "Les extensions sont toutes désactivées : rien n'est activé";
const RETIREE_PENDANT_CARTE = "Extension retirée pendant la carte : rien n'est activé";
const ESPACE_DISPARU = "Espace disparu pendant la carte : rien n'est activé";
export const dossierAbsent = (id: string) => `${DOSSIER_ABSENT} : ~/WebAiOs/extensions/${id} n'existe plus (recrée-le, puis recharger_extension)`;
export const SANS_ACCORD = "Extension sans accord : demande d'abord son activation";
/** Firefox refused the signed .xpi (no Electron text: new, like decision 9's). */
export const installationImpossible = (m: string) => "Installation impossible : " + m.slice(0, 2000);

// Keep in sync with apps/navigateur/src/main/extensions/service.ts (console unlock texts, DROITS_OBSERVATEURS).
export const CONSOLE_PROFIL_PRIVE = "Extension active dans le profil d'un espace privé : sa console n'est jamais montrée à l'agent";
export const DEBLOCAGE_INACTIVE = "Extension inactive ou désactivée : rien à débloquer (demande d'abord son activation)";
export const DEBLOCAGE_CHANGE = "L'extension a changé pendant la carte : rien n'est débloqué";
const DEBLOCAGE_REFUSE = "Déblocage refusé";
export const REVOIR_PENDANT_COUPURE = "Les extensions sont toutes désactivées : réactive-les pour revoir cette extension";
export const RIEN_A_REVOIR = "Rien à revoir pour cette extension";
const ERREURS_CONSOLE_PAGE = 20;
/** Rights that see tabs or navigation: with one, sites or all sites, the background's and pages' console stays masked. */
export const DROITS_OBSERVATEURS = ["tabs", "webNavigation", "cookies", "history", "topSites", "sessions", "bookmarks", "activeTab", "clipboardRead", "contextMenus",
  "declarativeNetRequestFeedback"];
const NIVEAUX: readonly string[] = ["log", "info", "warn", "error", "debug"] satisfies MessageConsole["niveau"][];

/** What the unlock card showed (Electron's LienDeblocage): the unlock holds only for that. */
interface LienDeblocage {
  /** The profiles where it was active: active in another one ends it. */
  profils: string[];
  /** `modifieeLe`: a new copy (reloaded, recreated) ends it. */
  marque: string | null;
}

export type ResultatEnvoi = { ok: true; analyse: AnalyseManifeste } | { ok: false; erreur: string; refus?: string[] };

type Preparation = { ok: true; analyse: AnalyseManifeste; empreinte: string; staging: string; fondOriginal: string | undefined };

interface Repere {
  chemin: string;
  dev: number;
  ino: number;
}

/** Every element from the agent's extensions folder to `<id>` is a real directory (lstat), never a symbolic link. */
async function reperesDuChemin(dossierAgent: string, id: string): Promise<Repere[] | string> {
  const reperes: Repere[] = [];
  for (const chemin of [dossierAgent, join(dossierAgent, id)]) {
    let info;
    try {
      info = await lstat(chemin);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return DOSSIER_ABSENT;
      return `Dossier illisible : ${(e as Error).message}`;
    }
    if (info.isSymbolicLink()) return `Lien symbolique refusé : ${chemin}`;
    if (!info.isDirectory()) return chemin === dossierAgent ? DOSSIER_ABSENT : `Pas un dossier : ${chemin}`;
    reperes.push({ chemin, dev: info.dev, ino: info.ino });
  }
  return reperes;
}

/** What Firefox answers to navigateur.espaces. */
interface Navigateur {
  espaces: Espace[];
  fenetres: { id: string; espaceActif: string }[];
  premierPlan: string | null;
}
const profilsPrivesDe = (n: Navigateur) => new Set(n.espaces.filter((e) => e.prive).map((e) => e.profil));

const memesReperes = (a: Repere[], b: Repere[]) =>
  a.length === b.length && a.every((x, i) => x.chemin === b[i]!.chemin && x.dev === b[i]!.dev && x.ino === b[i]!.ino);

/** Why the console of `cle` cannot (or no longer) be unlocked, or null (Electron's refusDeblocage). */
function refusDeblocage(e: EtatExtensions, prives: ReadonlySet<string>, cle: string): string | null {
  const x = e.extensions[cle];
  if (!x || x.source !== "agent") return `Extension inconnue : ${cle}`;
  if (x.profils.some((p) => prives.has(p))) return CONSOLE_PROFIL_PRIVE;
  if (e.toutesCoupees || x.desactivee || x.profils.length === 0) return DEBLOCAGE_INACTIVE;
  return null;
}

/** True if `cle` is no longer what the card showed: a new copy, or active in another profile (the add-on id never changes here). */
function lienRompu(e: EtatExtensions, cle: string, lien: LienDeblocage): boolean {
  const x = e.extensions[cle];
  return !x || x.modifieeLe !== lien.marque || x.profils.some((p) => !lien.profils.includes(p));
}

/** Decision 4: installed but disabled unless granted, active in a profile, not disabled, and not everything cut. */
const actifDans = (e: EtatExtensions, x: EntreeExtension | undefined) => !!x?.accord && x.profils.length > 0 && !x.desactivee && !e.toutesCoupees;

/** What the chrome's guard checkpoints read (`extensions.portees`): each granted agent extension by its add-on id. */
export type Portees = Record<string, { cle: string; accord: Portee; profils: string[]; actif: boolean }>;
export function porteesDe(e: EtatExtensions): Portees {
  const r: Portees = {};
  for (const [cle, x] of Object.entries(e.extensions))
    if (x.source === "agent" && x.accord) r[addonIdDe(cle.slice("agent:".length))] = { cle, accord: x.accord, profils: x.profils, actif: actifDans(e, x) };
  return r;
}

/**
 * The agent's extensions (registry `<dossier>/etat.json`, copies, signed .xpi), kept in the noyau host; the chrome
 * installs, enables, disables or uninstalls by RPC. One operation at a time per extension.
 */
export class ExtensionsAgent {
  private readonly files = new Map<string, Promise<unknown>>();
  /** The grant card open for each key: a reload or a removal takes it down (it holds the key's queue). */
  private readonly cartes = new Map<string, AbortController>();
  private readonly arret = new AbortController();
  private readonly env: NodeJS.ProcessEnv;
  /** The agent's extensions' consoles and crash counts, by add-on id, in memory. */
  private readonly consoles = new ConsolesExtensions({
    surPlantages: (addonId) => void this.desactiverPlantages(addonId).catch((e: unknown) => console.error(`[extensions] ${addonId} non désactivée après ses plantages :`, e)),
  });
  /** Consoles unlocked for the agent, by key: in memory only (quitting ends them), as Electron. */
  private readonly deblocages = new Map<string, LienDeblocage>();
  /** The last refused startup or reload of each key (Electron's erreursAgent), shown until one passes. */
  private readonly erreursEnvoi = new Map<string, string>();
  /** Unlock cards shown, by key: one at a time, taken down if the extension leaves the registry or changes. */
  private readonly cartesDeblocage = new Map<string, { reponse: Promise<Issue>; retrait: AbortController; lien: LienDeblocage; attentes: number }>();
  /** Keys whose source changed while closed and that ran nowhere at startup: signed when next activated (appliquer). */
  private readonly aSigner = new Set<string>();

  constructor(private readonly o: { dossier: string; dossierAgent: string; rpc: Rpc; env?: NodeJS.ProcessEnv }) {
    this.env = o.env ?? process.env;
  }

  /** Startup (decision 5): leftovers deleted, every granted one recopied, signed again only if its source changed, then installed. */
  async demarrer(): Promise<void> {
    // First: the chrome's checkpoints wait for it (an add-on kept by Firefox starts before this host).
    this.o.rpc.notify("extensions.portees", porteesDe(await lireEtatExtensions(this.o.dossier)));
    for (const [sous, reste] of [
      ["copies", /\.(tmp|ancienne|attente)$/],
      ["signes", /\.(attente|envoi)\.xpi$/],
    ] as const) {
      const noms = await readdir(join(this.o.dossier, sous)).catch(() => [] as string[]);
      for (const nom of noms) if (reste.test(nom)) await rm(join(this.o.dossier, sous, nom), { recursive: true, force: true }).catch(() => undefined);
    }
    const etat = await lireEtatExtensions(this.o.dossier);
    await Promise.all(
      Object.entries(etat.extensions).map(async ([cle, x]) => {
        if (x.source !== "agent" || !x.accord) return;
        try {
          const r = await this.preparerEtInstaller(cle.slice("agent:".length), { accord: x.accord, demarrage: true });
          if (!r.ok) console.warn(`[extensions] ${cle} au démarrage : ${r.erreur}`);
        } catch (e) {
          console.error(`[extensions] ${cle} non installée au démarrage :`, e);
        }
      }),
    );
  }

  /**
   * Copy, sign, install. The scope must stay within `accord` (broadened: disabled, grant kept). `demarrage`: an unchanged
   * source reinstalls the kept signed .xpi without sending anything. A failure before the install leaves the registry
   * and the running version untouched.
   */
  preparerEtInstaller(id: string, o: { accord: Portee; demarrage?: boolean }): Promise<ResultatEnvoi> {
    const cle = this.cle(id);
    if (!cle) return Promise.resolve({ ok: false, erreur: `Identifiant d'extension invalide : ${id}` });
    return this.enFile(cle, () => this.envoi(id, cle, o).then((r) => this.noterEnvoi(cle, r)));
  }

  /** Keeps a refused copy, signing or install as the key's error; a success or a disabling clears it. */
  private noterEnvoi<T extends ResultatEnvoi>(cle: string, r: T): T {
    const avant = this.erreursEnvoi.get(cle);
    if (r.ok || r.erreur === DESACTIVEE_PORTEE) this.erreursEnvoi.delete(cle);
    else this.erreursEnvoi.set(cle, r.erreur);
    if (avant !== this.erreursEnvoi.get(cle)) this.o.rpc.notify("extensions.change");
    return r;
  }

  /** The agent's extension tools (Electron's outilsAgent, service.ts). */
  outils(): OutilsExtensions {
    return {
      lister: () => this.lister(),
      demander: (id, x) => this.demander(id, x),
      recharger: (id) => this.recharger(id),
      console: (id, depuis) => this.consolePourAgent(id, depuis),
      debloquerConsole: (id, raison, x) => this.debloquerConsole(id, raison, x),
      refermerConsole: async (id) => {
        const cle = this.cleAgent(id);
        if (!cle) return { ok: false, erreur: `Extension inconnue : ${id}` };
        return this.couperDeblocage(cle);
      },
    };
  }

  /** A console message the chrome relayed (`extensions.console`); `onglet`: a content script's, readable by the agent or not. */
  noterConsole(addonId: unknown, m: unknown, onglet: unknown): void {
    const x = m as Partial<MessageConsole> | null;
    if (typeof addonId !== "string" || !addonId.endsWith(SUFFIXE_ID) || !this.cle(addonId.slice(0, -SUFFIXE_ID.length))) return;
    if (!x || typeof x.horodatage !== "number" || typeof x.texte !== "string" || !NIVEAUX.includes(x.niveau as string)) return;
    const o = onglet as { lisible?: unknown } | null;
    this.consoles.noter(addonId, { horodatage: x.horodatage, niveau: x.niveau!, texte: x.texte }, o ? { lisible: o.lisible === true } : undefined);
  }

  /** A crash the chrome saw (`extensions.plantage`, or queued in `extensions.pret`; spike S7): the `PLANTAGES_MAX`-th in `FENETRE_PLANTAGES_MS` disables it everywhere. */
  plantage(addonId: unknown, le?: unknown): void {
    if (typeof addonId !== "string" || !addonId.endsWith(SUFFIXE_ID) || !this.cle(addonId.slice(0, -SUFFIXE_ID.length))) return;
    // When the chrome saw it (a crash queued while no host ran), never later than now.
    const maintenant = Date.now();
    this.consoles.plantage(addonId, typeof le === "number" && le <= maintenant ? le : maintenant);
  }

  /** As Electron's desactiverPlantages: disabled everywhere (`DESACTIVEE_PLANTAGES`), shown on the page with « Réactiver ». */
  private async desactiverPlantages(addonId: string): Promise<void> {
    const cle = this.cle(addonId.slice(0, -SUFFIXE_ID.length))!;
    const r = await this.ecrireCle(cle, (e) => {
      const x = e.extensions[cle]!;
      return x.desactivee ? e : { ...e, extensions: { ...e.extensions, [cle]: { ...x, desactivee: { raison: "plantages" as const, le: new Date().toISOString() } } } };
    });
    if (!r.ok) throw new Error(r.erreur);
    console.warn(`[extensions] ${cle} désactivée : ${DESACTIVEE_PLANTAGES}`);
  }

  /** `console_extension` (Electron's consolePourAgent): filtered (unlocked: whole); null if not in the registry. */
  private async consolePourAgent(id: string, depuis?: number): Promise<ConsolePourAgent | null> {
    const cle = this.cleAgent(id);
    const etat = await lireEtatExtensions(this.o.dossier);
    const x = cle ? etat.extensions[cle] : undefined;
    if (!cle || !x) return null;
    const prives = profilsPrivesDe(await this.navigateur());
    if (x.profils.some((p) => prives.has(p))) throw new Error(CONSOLE_PROFIL_PRIVE);
    return this.consoles.pourAgent(addonIdDe(this.id(cle)!), this.filtreAgent(etat, cle, depuis));
  }

  /** Electron's filtreAgent: unlocked; ran in an unreadable tab (entry flag, or its add-on id kept after a removal); observing right. */
  private filtreAgent(etat: EtatExtensions, cle: string, depuis?: number): FiltreAgent {
    const x = etat.extensions[cle];
    const a = x?.accord;
    return {
      ...(depuis !== undefined ? { depuis } : {}),
      debloquee: this.deblocages.has(cle),
      tourneIllisible: (x?.consoleMasquee?.length ?? 0) > 0 || !!etat.consolesMasquees?.includes(addonIdDe(this.id(cle)!)),
      observateur: !a || a.tousLesSites || a.scriptsTousLesSites || a.hotes.length > 0 || a.permissions.some((p) => DROITS_OBSERVATEURS.includes(p)),
    };
  }

  /**
   * `debloquer_console` (Electron's debloquerConsole): the unlock card, for an agent extension active somewhere, never
   * in a private space's profile, naming the spaces of its profiles. Granted: its console is whole for what the card
   * showed, until refermer_console or a registry write that ends it (verifierDeblocages).
   */
  private async debloquerConsole(id: string, raison: string, x: { fenetre: string | null; agent: string; signal?: AbortSignal }): Promise<ResultatConsoleExtension> {
    const cle = this.cleAgent(id);
    const etat = await lireEtatExtensions(this.o.dossier);
    const entree = cle ? etat.extensions[cle] : undefined;
    if (!cle || !entree) return { ok: false, erreur: `Extension inconnue : ${id}` };
    const nav = await this.navigateur();
    const refus = refusDeblocage(etat, profilsPrivesDe(nav), cle);
    if (refus) return { ok: false, erreur: refus };
    if (this.deblocages.has(cle)) return { ok: true };
    let carte = this.cartesDeblocage.get(cle);
    if (!carte) {
      const retrait = new AbortController();
      const lien = { profils: [...entree.profils], marque: entree.modifieeLe };
      const demande = {
        nom: entree.nom,
        espaces: nav.espaces.filter((e) => lien.profils.includes(e.profil) && !e.prive).map((e) => e.nom),
        raison: raison.slice(0, LONGUEUR_RAISON_DEBLOCAGE),
        agent: x.agent,
        fenetre: x.fenetre,
      };
      const nouvelle = {
        retrait,
        lien,
        attentes: 0,
        reponse: this.o.rpc
          .request<Issue>("extensions.deblocage", demande, AbortSignal.any([retrait.signal, this.arret.signal]))
          .catch((): Issue => "retiree")
          .finally(() => {
            if (this.cartesDeblocage.get(cle) === nouvelle) this.cartesDeblocage.delete(cle);
          }),
      };
      this.cartesDeblocage.set(cle, nouvelle);
      carte = nouvelle;
    }
    const ouverte = carte;
    ouverte.attentes++;
    // This call dropped (new conversation) takes the card down only if it is the last one waiting for it.
    let abandonner: () => void = () => {};
    const abandon = new Promise<Issue>((ok) => (abandonner = () => ok("retiree")));
    let parti = false;
    const partir = () => {
      if (parti) return;
      parti = true;
      if (--ouverte.attentes === 0) ouverte.retrait.abort();
      abandonner();
    };
    if (x.signal?.aborted) partir();
    x.signal?.addEventListener("abort", partir, { once: true });
    let issue: Issue;
    try {
      issue = await Promise.race([ouverte.reponse, abandon]);
    } finally {
      x.signal?.removeEventListener("abort", partir);
      if (!parti) {
        parti = true;
        ouverte.attentes--;
      }
    }
    if (issue === "retiree") return { ok: false, erreur: DEMANDE_RETIREE, retiree: true };
    if (issue !== "autoriser") return { ok: false, erreur: DEBLOCAGE_REFUSE, refusee: true };
    // The state may have changed during the card: checked again on « yes », against what the card showed.
    const apres = await lireEtatExtensions(this.o.dossier);
    if (refusDeblocage(apres, profilsPrivesDe(await this.navigateur()), cle) || lienRompu(apres, cle, ouverte.lien)) return { ok: false, erreur: DEBLOCAGE_CHANGE };
    this.deblocages.set(cle, ouverte.lien);
    this.o.rpc.notify("extensions.change");
    return { ok: true };
  }

  /** « Couper le déblocage » (Extensions page) or `refermer_console`: its console is filtered again. */
  couperDeblocage(cle: string): ResultatExtension {
    if (this.deblocages.delete(cle)) this.o.rpc.notify("extensions.change");
    return { ok: true };
  }

  /** After each registry write: an unlock whose extension left, was disabled, cut, activated elsewhere or recopied ends; its card falls. */
  private verifierDeblocages(e: EtatExtensions, prives: ReadonlySet<string>): void {
    for (const [cle, lien] of [...this.deblocages]) if (refusDeblocage(e, prives, cle) || lienRompu(e, cle, lien)) this.deblocages.delete(cle);
    for (const [cle, carte] of this.cartesDeblocage) if (refusDeblocage(e, prives, cle) || lienRompu(e, cle, carte.lien)) carte.retrait.abort();
  }

  /** `<id>` or `agent:<id>`, as Electron's cleAgentPour. */
  private cleAgent(id: string): string | null {
    return this.cle(id.startsWith("agent:") ? id.slice("agent:".length) : id);
  }

  /**
   * Each registry entry: the non-private spaces where it is active (named), the private ones (counted), its disabling;
   * then Firefox's AMO add-ons (decision 7): global, so active in every space, with no error.
   */
  private async lister(): Promise<ExtensionPourAgent[]> {
    const [nav, etat, amo] = await Promise.all([
      this.navigateur(),
      lireEtatExtensions(this.o.dossier),
      // An extra source: the agent keeps its own rows if Firefox cannot list its add-ons.
      this.o.rpc.request<{ id: string; nom: string; version: string; actif: boolean }[]>("extensions.amo", {}).catch((e: unknown) => {
        console.error("[extensions] modules d'AMO non listés :", e);
        return [];
      }),
    ]);
    const prives = nav.espaces.filter((e) => e.prive).length;
    const ouverts = nav.espaces.filter((e) => !e.prive).map((e) => e.nom);
    const modules = amo
      .map((a): ExtensionPourAgent => ({ cle: `store:${a.id}`, source: "store", nom: a.nom, version: a.version, espaces: a.actif ? ouverts : [], espacesPrives: a.actif ? prives : 0, erreurs: [] }))
      .sort((a, b) => a.nom.localeCompare(b.nom) || a.cle.localeCompare(b.cle));
    const profilsPrives = profilsPrivesDe(nav);
    const agent = Object.entries(etat.extensions)
      .map(([cle, x]): ExtensionPourAgent => {
        const espaces = nav.espaces.filter((e) => x.profils.includes(e.profil));
        const id = this.id(cle);
        // As Electron's listePourAgent: its kept error, its disabling, then its console's errors as console_extension filters them.
        const erreurs = [...(this.erreursEnvoi.has(cle) ? [this.erreursEnvoi.get(cle)!] : []), ...(x.desactivee ? [x.desactivee.raison === "plantages" ? DESACTIVEE_PLANTAGES : DESACTIVEE_PORTEE] : [])];
        if (id && !x.profils.some((p) => profilsPrives.has(p))) erreurs.push(...this.consoles.erreursPourAgent(addonIdDe(id), this.filtreAgent(etat, cle)).slice(-ERREURS_CONSOLE_PAGE));
        return {
          cle,
          source: x.source,
          nom: x.nom,
          version: x.version,
          espaces: espaces.filter((e) => !e.prive).map((e) => e.nom),
          espacesPrives: espaces.filter((e) => e.prive).length,
          erreurs,
        };
      })
      .sort((a, b) => a.nom.localeCompare(b.nom) || a.cle.localeCompare(b.cle));
    return [...agent, ...modules];
  }

  /** The Extensions page (Electron's liste, the agent's only): one row per registry entry, by name. */
  async liste(): Promise<LigneExtension[]> {
    const [nav, etat] = await Promise.all([this.navigateur(), lireEtatExtensions(this.o.dossier)]);
    const prives = profilsPrivesDe(nav);
    const lignes: LigneExtension[] = [];
    for (const [cle, x] of Object.entries(etat.extensions)) {
      const id = this.id(cle);
      if (!id || x.source !== "agent") continue;
      const manifeste = await readFile(join(this.o.dossier, "copies", id, "manifest.json"), "utf8").then((t) => JSON.parse(t) as unknown, () => null);
      // The granted scope; without a grant (never for a loaded entry), the manifest's on disk.
      const portee = x.accord ?? analyserManifeste(manifeste, { source: "agent" }).portee;
      const desactivee = x.desactivee ? (x.desactivee.raison === "plantages" ? DESACTIVEE_PLANTAGES : DESACTIVEE_PORTEE) : null;
      lignes.push({
        cle,
        nom: x.nom,
        source: "agent",
        version: x.version,
        droits: libellesPortee(portee, "agent"),
        sites: [...portee.hotes],
        tousLesSites: portee.tousLesSites,
        espaces: nav.espaces.filter((e) => x.profils.includes(e.profil) && !prives.has(e.profil)).map((e) => ({ nom: e.nom, profil: e.profil })),
        erreurs: [...(this.erreursEnvoi.has(cle) ? [this.erreursEnvoi.get(cle)!] : []), ...this.consoles.erreurs(addonIdDe(id)).slice(-ERREURS_CONSOLE_PAGE)],
        modifieeLe: x.modifieeLe,
        desactivee,
        majEnAttente: null,
        nonPrisEnCharge: nonPrisEnCharge(manifeste),
        epinglee: x.epinglee,
        consoleDebloquee: this.deblocages.has(cle),
        applis: [],
      });
    }
    return lignes.sort((a, b) => a.nom.localeCompare(b.nom) || a.cle.localeCompare(b.cle));
  }

  /** « Désactiver toutes les extensions » is on. */
  async coupees(): Promise<boolean> {
    return (await lireEtatExtensions(this.o.dossier)).toutesCoupees;
  }

  /** « Désactiver toutes les extensions » (kept in the registry, so across a restart): every agent add-on disabled, never uninstalled. */
  async toutCouper(oui: boolean): Promise<ResultatExtension> {
    try {
      const e = await this.modifier((e) => couperTout(e, oui));
      for (const cle of Object.keys(e.extensions)) {
        const id = this.id(cle);
        if (id) await this.enFile(cle, () => this.appliquer(id, cle));
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, erreur: (e as Error).message };
    }
  }

  /** « Désactiver partout »: out of every profile, the add-on disabled; its grant and storage stay (decision 4). */
  desactiverPartout(cle: string): Promise<ResultatExtension> {
    return this.ecrireCle(cle, (e) => desactiverPartout(e, cle));
  }

  /** « Réactiver » after crashes: it runs again in the profiles where it was active. */
  async reactiver(cle: string): Promise<ResultatExtension> {
    const r = await this.ecrireCle(cle, (e) => {
      const x = e.extensions[cle]!;
      return x.desactivee?.raison === "plantages" ? { ...e, extensions: { ...e.extensions, [cle]: { ...x, desactivee: null } } } : e;
    });
    const id = this.id(cle);
    if (r.ok && id) this.consoles.oublier(addonIdDe(id));
    return r;
  }

  /** « Revoir l'accord » (disabled for a broadened scope): the card, in `fenetre`'s active space if the extension is active there. */
  async revoir(cle: string, fenetre: string | null): Promise<ResultatExtension> {
    const id = this.id(cle);
    const etat = await lireEtatExtensions(this.o.dossier);
    const x = etat.extensions[cle];
    if (!id || !x) return { ok: false, erreur: `Extension inconnue : ${cle}` };
    if (etat.toutesCoupees) return { ok: false, erreur: REVOIR_PENDANT_COUPURE };
    if (x.desactivee?.raison !== "portee-elargie") return { ok: false, erreur: RIEN_A_REVOIR };
    const nav = await this.navigateur();
    const prives = profilsPrivesDe(nav);
    const actif = nav.fenetres.find((f) => f.id === fenetre)?.espaceActif;
    const espace =
      nav.espaces.find((e) => e.id === actif && x.profils.includes(e.profil)) ??
      nav.espaces.find((e) => x.profils.includes(e.profil) && !prives.has(e.profil)) ??
      nav.espaces.find((e) => e.id === actif);
    if (!espace) return { ok: false, erreur: "Aucun espace où la revoir" };
    const r = await this.demander(id, { espace: espace.id, fenetre });
    return r.ok ? { ok: true } : { ok: false, erreur: r.erreur };
  }

  /** A registry write for a known agent key, in its queue, then applied to its add-on; an error comes back as text. */
  private async ecrireCle(cle: string, changer: (e: EtatExtensions) => EtatExtensions): Promise<ResultatExtension> {
    const id = this.id(cle);
    if (!id || !(cle in (await lireEtatExtensions(this.o.dossier)).extensions)) return { ok: false, erreur: `Extension inconnue : ${cle}` };
    try {
      await this.enFile(cle, async () => {
        await this.modifier((e) => (cle in e.extensions ? changer(e) : e));
        await this.appliquer(id, cle);
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, erreur: (e as Error).message };
    }
  }

  /**
   * `demander_extension` (Electron's demanderPourAgent): the space named (id or name, never a private one), else the
   * active space of the agent's window (or the foreground one); then the card, in that window.
   */
  private async demander(id: string, x: { espace?: string; fenetre: string | null; signal?: AbortSignal }): Promise<ResultatDemandeExtension> {
    const cle = this.cle(id);
    if (!cle) return { ok: false, erreur: `Identifiant d'extension invalide : ${id}` };
    const nav = await this.navigateur();
    const f = nav.fenetres.find((w) => w.id === x.fenetre) ?? nav.fenetres.find((w) => w.id === nav.premierPlan) ?? nav.fenetres[0];
    let espace: Espace | undefined;
    if (x.espace !== undefined) {
      const ouverts = nav.espaces.filter((e) => !e.prive);
      espace = ouverts.find((e) => e.id === x.espace) ?? ouverts.find((e) => e.nom.toLowerCase() === x.espace!.toLowerCase());
      if (!espace) return { ok: false, erreur: `Espace inconnu : ${x.espace}` };
    } else espace = nav.espaces.find((e) => e.id === f?.espaceActif);
    if (!espace) return { ok: false, erreur: "Aucun espace actif" };
    const choisi = espace;
    const r = await this.enFile(cle, () => this.activation(id, cle, choisi, f?.id ?? null, x.signal));
    if (r.ok) return { ok: true, espace: espace.nom };
    if (r.erreur === ACTIVATION_REFUSEE) return { ok: false, erreur: r.erreur, refusee: true };
    if (r.erreur === ACTIVATION_RETIREE) return { ok: false, erreur: r.erreur, retiree: true };
    return r;
  }

  /**
   * As Electron's activation (agent.ts): private profile → refused without a card; already granted and active there →
   * nothing asked. Else the copy is prepared and its card shown; accepted (the scope shown, the space still there and
   * not private), it is signed and installed on that scope, and only then granted and active in the space's profile.
   */
  private async activation(id: string, cle: string, espace: Espace, fenetre: string | null, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; erreur: string }> {
    const profil = espace.profil;
    const nav = await this.navigateur();
    if (profilsPrivesDe(nav).has(profil)) return { ok: false, erreur: ERREUR_PROFIL_PRIVE };
    const etat = await lireEtatExtensions(this.o.dossier);
    if (etat.toutesCoupees) return { ok: false, erreur: TOUTES_COUPEES_AGENT };
    const connue = etat.extensions[cle];
    if (connue?.desactivee?.raison === "plantages") return { ok: false, erreur: DESACTIVEE_PLANTAGES };
    if (connue?.accord && !connue.desactivee && connue.profils.includes(profil)) {
      // Already granted and active: nothing asked again, but a folder gone is said.
      const chemin = await reperesDuChemin(this.o.dossierAgent, id);
      if (typeof chemin === "string") return { ok: false, erreur: chemin === DOSSIER_ABSENT ? dossierAbsent(id) : chemin };
      return { ok: true };
    }

    const p = await this.preparer(id);
    if (!p.ok) return { ok: false, erreur: p.refus.map((r) => (r === DOSSIER_ABSENT ? dossierAbsent(id) : r)).join(" ; ") };
    const effacer = () => rm(p.staging, { recursive: true, force: true });
    // A signing will be needed: without keys, nothing is shown and nothing leaves.
    if ((await this.garde(id))?.empreinte !== p.empreinte && !(await lireCleAmo(this.env))) {
      await effacer();
      return { ok: false, erreur: CLES_ABSENTES };
    }
    // Already active elsewhere with a narrower grant: the new copy replaces it there too, the card says so.
    const autresProfils = connue?.accord && porteeElargie(connue.accord, p.analyse.portee) ? connue.profils.filter((x) => x !== profil) : [];
    const remplaceAussi = nav.espaces.filter((e) => !e.prive && autresProfils.includes(e.profil)).map((e) => e.nom);
    const carte = carteDe(p.analyse, { cle, espace, espaces: nav.espaces, remplaceAussi });
    const r = await this.demanderAccord(cle, carte, fenetre, signal);
    if (!(r.accepte && r.empreinte === carte.empreinte)) {
      await effacer();
      return { ok: false, erreur: r.retiree ? ACTIVATION_RETIREE : ACTIVATION_REFUSEE };
    }
    // The state may have changed during the card: checked again on « yes ».
    const apres = await this.navigateur();
    const ici = apres.espaces.find((e) => e.id === espace.id);
    const etatApres = await lireEtatExtensions(this.o.dossier);
    const refus = !ici
      ? ESPACE_DISPARU
      : ici.profil !== profil || profilsPrivesDe(apres).has(profil)
        ? ERREUR_PROFIL_PRIVE
        : etatApres.toutesCoupees
          ? TOUTES_COUPEES_AGENT
          : connue && !(cle in etatApres.extensions)
            ? RETIREE_PENDANT_CARTE
            : null;
    if (refus) {
      await effacer();
      return { ok: false, erreur: refus };
    }
    const e = await this.envoi(id, cle, { accord: p.analyse.portee, activer: { espaceId: espace.id, profil, connue: !!connue } }, p);
    if (e.ok) this.noterEnvoi(cle, e);
    return e.ok ? { ok: true } : { ok: false, erreur: e.erreur };
  }

  /** The card in the chrome (`extensions.accord`); fallen, aborted or unanswerable: « retirée », never a refusal. */
  private async demanderAccord(cle: string, carte: CarteExtension, fenetre: string | null, signal?: AbortSignal): Promise<ReponseAccord> {
    const retrait = new AbortController();
    this.cartes.set(cle, retrait);
    try {
      const signaux = [retrait.signal, this.arret.signal, ...(signal ? [signal] : [])];
      return await this.o.rpc.request<ReponseAccord>("extensions.accord", { carte, fenetre }, AbortSignal.any(signaux));
    } catch {
      return { accepte: false, empreinte: carte.empreinte, retiree: true };
    } finally {
      if (this.cartes.get(cle) === retrait) this.cartes.delete(cle);
    }
  }

  /** `recharger_extension`: within its grant, signed and installed without a card; broadened, disabled (grant kept). */
  private recharger(id: string): Promise<{ etat: "rechargee" | "desactivee" | "refusee"; detail: string[] }> {
    const cle = this.cle(id);
    if (!cle) return Promise.resolve({ etat: "refusee", detail: [`Identifiant d'extension invalide : ${id}`] });
    // A card left open for it holds its queue: it falls first.
    this.cartes.get(cle)?.abort();
    return this.enFile(cle, async () => {
      const accord = (await lireEtatExtensions(this.o.dossier)).extensions[cle]?.accord;
      if (!accord) return { etat: "refusee" as const, detail: [SANS_ACCORD] };
      const r = this.noterEnvoi(cle, await this.envoi(id, cle, { accord }));
      if (r.ok) return { etat: "rechargee" as const, detail: [] };
      if (r.erreur === DESACTIVEE_PORTEE) return { etat: "desactivee" as const, detail: [DESACTIVEE_PORTEE] };
      return { etat: "refusee" as const, detail: r.refus ?? [r.erreur] };
    });
  }

  /** The Extensions page's « Supprimer »: its storage goes with the add-on, the agent's folder stays. */
  async supprimerPage(cle: string): Promise<ResultatExtension> {
    if (!(cle in (await lireEtatExtensions(this.o.dossier)).extensions)) return { ok: false, erreur: `Extension inconnue : ${cle}` };
    return this.supprimer(cle).then(
      () => ({ ok: true as const }),
      (e: unknown) => ({ ok: false as const, erreur: (e as Error).message }),
    );
  }

  /**
   * « Supprimer »: uninstalled, copy and signed .xpi deleted, registry entry removed; amo-versions.json kept (AMO never reuses a number).
   * `horsWebaios`: about:addons' pending removal, which its Undo may have cancelled since: then nothing changes.
   */
  supprimer(cle: string, horsWebaios = false): Promise<void> {
    const id = this.id(cle);
    if (!id) return Promise.reject(new Error(`Identifiant d'extension invalide : ${cle}`));
    this.cartes.get(cle)?.abort();
    return this.enFile(cle, async () => {
      // Uninstalled first: an entry gone while the add-on stays installed would run without a grant.
      const fait = await this.o.rpc.request("extensions.desinstaller", horsWebaios ? { addonId: addonIdDe(id), unlessUndone: true } : { addonId: addonIdDe(id) });
      if (fait === false) return;
      await this.modifier((e) => (cle in e.extensions ? retirer(e, cle) : e));
      this.consoles.oublier(addonIdDe(id));
      this.erreursEnvoi.delete(cle);
      for (const f of [join("copies", id), join("copies", `${id}.attente`), join("signes", `${id}.xpi`), join("signes", `${id}.json`)])
        await rm(join(this.o.dossier, f), { recursive: true, force: true });
    });
  }

  /** about:addons removed it (« Supprimer », grant deleted) or disabled it (« Désactiver partout ») (decision 6). */
  async horsWebaios(addonId: string, quoi: "desinstallee" | "desactivee"): Promise<void> {
    if (!addonId.endsWith(SUFFIXE_ID)) return;
    const cle = this.cle(addonId.slice(0, -SUFFIXE_ID.length));
    if (!cle || !(cle in (await lireEtatExtensions(this.o.dossier)).extensions)) return;
    if (quoi === "desinstallee") return this.supprimer(cle, true);
    await this.enFile(cle, () => this.modifier((e) => (cle in e.extensions ? desactiverPartout(e, cle) : e)));
  }

  /**
   * The chrome saw it about to run in a tab of `profil` the agent cannot read (as Electron's aTourneDansOnglet): its
   * console stays masked to the agent there (`consoleMasquee`), and by add-on id (`consolesMasquees`, never emptied).
   */
  async aTourne(addonId: string, profil: string, lisible: boolean): Promise<void> {
    if (lisible || typeof addonId !== "string" || typeof profil !== "string" || !addonId.endsWith(SUFFIXE_ID)) return;
    const cle = this.cle(addonId.slice(0, -SUFFIXE_ID.length));
    if (!cle) return;
    await this.enFile(cle, () =>
      this.modifier((e) => {
        const x = e.extensions[cle];
        if (x?.source !== "agent") return e;
        const masquees = e.consolesMasquees?.includes(addonId) ? e.consolesMasquees : [...(e.consolesMasquees ?? []), addonId];
        const profils = x.consoleMasquee?.includes(profil) ? x.consoleMasquee : [...(x.consoleMasquee ?? []), profil];
        return { ...e, consolesMasquees: masquees, extensions: { ...e.extensions, [cle]: { ...x, consoleMasquee: profils } } };
      }),
    );
  }

  /**
   * The chrome's private profiles (`extensions.profilsPrives`, as Electron's appliquerProfilsPrives): each agent extension
   * active in one is taken out of it, the tabs of those profiles where it ran are reloaded (A7: its scripts stop), and
   * it is disabled where it is active nowhere else.
   */
  async profilsPrives(prives: string[]): Promise<void> {
    const { retirees } = appliquerProfilsPrives(await lireEtatExtensions(this.o.dossier), new Set(prives));
    if (retirees.length === 0) return;
    await this.modifier((e) => e);
    const parCle = new Map<string, string[]>();
    for (const r of retirees) parCle.set(r.cle, [...(parCle.get(r.cle) ?? []), r.profil]);
    for (const [cle, profils] of parCle) {
      const id = this.id(cle);
      if (!id) continue;
      this.o.rpc.notify("extensions.rechargerOnglets", { addonId: addonIdDe(id), profils });
      await this.enFile(cle, () => this.appliquer(id, cle));
    }
  }

  /**
   * The « Extensions » section of a space's settings (Electron's pourEspace, the agent's only): registry entries and the
   * agent's folders never granted (their names only), seen from that space's profile.
   */
  async pourEspace(espaceId: string): Promise<LigneExtensionEspace[]> {
    const nav = await this.navigateur();
    const espace = nav.espaces.find((e) => e.id === espaceId);
    if (!espace) return [];
    const etat = await lireEtatExtensions(this.o.dossier);
    const autres = nav.espaces.filter((e) => e.id !== espace.id && e.profil === espace.profil).map((e) => e.nom);
    const grisee = profilsPrivesDe(nav).has(espace.profil) ? ERREUR_PROFIL_PRIVE : null;
    const lignes: LigneExtensionEspace[] = Object.entries(etat.extensions)
      .filter(([, x]) => x.source === "agent")
      .map(([cle, x]) => {
        const active = x.profils.includes(espace.profil);
        return { cle, nom: x.nom, source: "agent", active, aussiDans: active ? autres : [], grisee, profils: [...x.profils] };
      });
    for (const d of await readdir(this.o.dossierAgent, { withFileTypes: true }).catch(() => [])) {
      const cle = this.cle(d.name);
      if (!d.isDirectory() || !cle || cle in etat.extensions) continue;
      lignes.push({ cle, nom: d.name, source: "agent", active: false, aussiDans: [], grisee, profils: [] });
    }
    return lignes.sort((a, b) => a.nom.localeCompare(b.nom) || a.cle.localeCompare(b.cle));
  }

  /**
   * A space settings' switch (Electron's basculer): off → taken out of the space's profile; on → refused in a private
   * profile, through the card without a grant (or disabled for a broadened scope), else active there at once.
   */
  async basculer(cle: string, espaceId: string, actif: boolean, fenetre: string | null): Promise<{ ok: true } | { ok: false; erreur: string }> {
    const id = this.id(cle);
    if (!id) return { ok: false, erreur: `Extension inconnue : ${cle}` };
    const nav = await this.navigateur();
    const espace = nav.espaces.find((e) => e.id === espaceId);
    if (!espace) return { ok: false, erreur: "Espace inconnu" };
    const profil = espace.profil;
    const ecrire = (changer: (e: EtatExtensions, prives: ReadonlySet<string>) => EtatExtensions) =>
      this.enFile(cle, async () => {
        await this.modifier(changer);
        await this.appliquer(id, cle);
      }).then(
        () => ({ ok: true as const }),
        (e: unknown) => ({ ok: false as const, erreur: (e as Error).message }),
      );
    if (!actif) return ecrire((e) => (cle in e.extensions ? desactiver(e, cle, profil) : e));
    if (profilsPrivesDe(nav).has(profil)) return { ok: false, erreur: ERREUR_PROFIL_PRIVE };
    const etat = await lireEtatExtensions(this.o.dossier);
    if (etat.toutesCoupees) return { ok: false, erreur: TOUTES_COUPEES_AGENT };
    const x = etat.extensions[cle];
    if (!(x?.accord && x.desactivee === null)) {
      const r = await this.demander(id, { espace: espace.id, fenetre });
      return r.ok ? { ok: true } : { ok: false, erreur: r.erreur };
    }
    // Checked again in the serialized write: everything cut, or a disabling, may have come in between.
    return ecrire((e, prives) => {
      if (e.toutesCoupees) throw new Error(TOUTES_COUPEES_AGENT);
      const d = e.extensions[cle]?.desactivee;
      if (d) throw new Error(d.raison === "plantages" ? DESACTIVEE_PLANTAGES : DESACTIVEE_PORTEE);
      return activer(e, cle, profil, prives);
    });
  }

  /** Quitting: a signing in progress is dropped (its version number stays taken; the change is signed again at the next startup). */
  arreter(): void {
    this.arret.abort();
  }

  private cle(id: string): string | null {
    try {
      return cleExtension("agent", id);
    } catch {
      return null;
    }
  }

  private id(cle: string): string | null {
    return cle.startsWith("agent:") && this.cle(cle.slice("agent:".length)) === cle ? cle.slice("agent:".length) : null;
  }

  private enFile<T>(cle: string, f: () => Promise<T>): Promise<T> {
    const suivante = (this.files.get(cle) ?? Promise.resolve()).catch(() => {}).then(f);
    this.files.set(cle, suivante);
    void suivante
      .finally(() => {
        if (this.files.get(cle) === suivante) this.files.delete(cle);
      })
      .catch(() => {});
    return suivante;
  }

  /** Registry change; the profiles of private spaces (asked from Firefox) are taken out of every agent extension. */
  private async modifier(changer: (e: EtatExtensions, prives: ReadonlySet<string>) => EtatExtensions): Promise<EtatExtensions> {
    const prives = profilsPrivesDe(await this.navigateur());
    const e = await modifierEtatExtensions(this.o.dossier, changer, () => prives);
    this.verifierDeblocages(e, prives);
    this.o.rpc.notify("extensions.portees", porteesDe(e));
    this.o.rpc.notify("extensions.change");
    return e;
  }

  private navigateur(): Promise<Navigateur> {
    return this.o.rpc.request<Navigateur>("navigateur.espaces", {});
  }

  private async actif(cle: string): Promise<boolean> {
    const e = await lireEtatExtensions(this.o.dossier);
    return actifDans(e, e.extensions[cle]);
  }

  /** As the registry says (decision 4): active → the kept signed .xpi installed if missing, then enabled; inactive → disabled, never installed fresh. */
  private async appliquer(id: string, cle: string): Promise<void> {
    const actif = await this.actif(cle);
    if (actif && this.aSigner.delete(cle)) return this.signerActivee(id, cle);
    const garde = await this.garde(id);
    if (garde) await this.installer(id, join(this.o.dossier, "signes", `${id}.xpi`), garde.version, actif);
    await this.o.rpc.request("extensions.activer", { addonId: addonIdDe(id), actif });
  }

  /** Active again after a startup that did not sign its changed source: signed now, else the kept version runs. */
  private async signerActivee(id: string, cle: string): Promise<void> {
    const x = (await lireEtatExtensions(this.o.dossier)).extensions[cle];
    const r = x?.accord ? this.noterEnvoi(cle, await this.envoi(id, cle, { accord: x.accord, demarrage: true })) : null;
    // envoi applied it, or disabled it (broadened scope, folder gone); otherwise the kept version runs.
    if (!r?.ok && r?.erreur !== DESACTIVEE_PORTEE && !r?.refus?.includes(DOSSIER_ABSENT)) await this.appliquer(id, cle);
  }

  /** Active once envoi is done: a scope-disabled one back within its grant runs again. */
  private async actifApresEnvoi(cle: string): Promise<boolean> {
    const e = await lireEtatExtensions(this.o.dossier);
    const x = e.extensions[cle];
    return actifDans(e, x?.desactivee?.raison === "portee-elargie" ? { ...x, desactivee: null } : x);
  }

  /** The last signed and installed version (`signes/<id>.json`), if its .xpi is there. */
  private async garde(id: string): Promise<{ version: string; empreinte: string } | null> {
    const signes = join(this.o.dossier, "signes");
    if (!(await lstat(join(signes, `${id}.xpi`)).then(() => true, () => false))) return null;
    return readFile(join(signes, `${id}.json`), "utf8").then((t) => JSON.parse(t) as { version: string; empreinte: string }, () => null);
  }

  /** `actif` false: Firefox installs it only over a present add-on (disabled first), never fresh. */
  private installer(id: string, xpi: string, version: string, actif: boolean): Promise<{ version: string } | null> {
    return this.o.rpc.request("extensions.installer", { addonId: addonIdDe(id), xpi, temporaire: !!this.env.WEBAIOS_TEST_AMO_URL, version, actif });
  }

  /**
   * `activer`: a grant card was accepted for `accord` (the scope shown) in `profil`: installed active, and only once
   * installed is the grant written (`connue`: an entry existed when the card was shown). A failure leaves no grant.
   */
  private async envoi(
    id: string,
    cle: string,
    o: { accord: Portee; demarrage?: boolean; activer?: { espaceId: string; profil: string; connue: boolean } },
    prepare?: Preparation,
  ): Promise<ResultatEnvoi> {
    const p = prepare ?? (await this.preparer(id));
    if (!p.ok) {
      // As Electron: only a missing folder stops the running version.
      if (p.refus.includes(DOSSIER_ABSENT)) await this.o.rpc.request("extensions.activer", { addonId: addonIdDe(id), actif: false });
      return { ok: false, erreur: p.refus.map((r) => (r === DOSSIER_ABSENT ? dossierAbsent(id) : r)).join(" ; "), refus: p.refus };
    }
    const { analyse, empreinte, staging } = p;
    const effacer = () => rm(staging, { recursive: true, force: true });
    if (porteeElargie(o.accord, analyse.portee)) {
      await effacer();
      await this.modifier((e) => {
        const x = e.extensions[cle];
        if (!x || x.desactivee?.raison === "portee-elargie") return e;
        return { ...e, extensions: { ...e.extensions, [cle]: { ...x, desactivee: { raison: "portee-elargie", le: new Date().toISOString() } } } };
      });
      await this.appliquer(id, cle);
      return { ok: false, erreur: DESACTIVEE_PORTEE };
    }

    const signes = join(this.o.dossier, "signes");
    let change = true;
    // Unchanged since the last signing (startup, a grant in another profile, or a reload): appliquer below reinstalls
    // the kept .xpi if it is missing, nothing is sent; a reload restarts the running one.
    const garde = await this.garde(id);
    if (garde?.empreinte === empreinte) {
      await effacer();
      // A reload still counts as a new start (modifieeLe: its console unlock ends, as in Electron).
      if (!o.demarrage && !o.activer) await this.o.rpc.request("extensions.redemarrer", { addonId: addonIdDe(id) });
      else change = false;
    } else if (o.demarrage && garde && !(await this.actifApresEnvoi(cle))) {
      // Active nowhere: nothing leaves for AMO; the kept version stays until it is activated again.
      await effacer();
      this.aSigner.add(cle);
      await this.appliquer(id, cle);
      return { ok: true, analyse };
    } else {
      const r = await this.signerEtInstaller(id, p, o.activer ? true : await this.actif(cle));
      if (!r.ok) {
        await effacer();
        return r;
      }
      this.aSigner.delete(cle);
      await writeFile(join(signes, `${id}.json`), JSON.stringify({ version: r.version, empreinte }));
      const copie = join(this.o.dossier, "copies", id);
      await rm(copie, { recursive: true, force: true });
      await rename(staging, copie);
    }
    const maintenant = new Date().toISOString();
    const a = o.activer;
    if (a) {
      try {
        // The signing takes minutes: the space is checked again before anything is granted for it.
        const nav = await this.navigateur();
        const ici = nav.espaces.find((e) => e.id === a.espaceId);
        if (!ici) throw new Error(ESPACE_DISPARU);
        if (ici.profil !== a.profil || profilsPrivesDe(nav).has(a.profil)) throw new Error(ERREUR_PROFIL_PRIVE);
        await this.modifier((e, prives) => {
          if (e.toutesCoupees) throw new Error(TOUTES_COUPEES_AGENT);
          const x = e.extensions[cle];
          if (a.connue && !x) throw new Error(RETIREE_PENDANT_CARTE);
          const base: EntreeExtension = x ?? {
            source: "agent",
            idChrome: null,
            nom: analyse.nom,
            version: analyse.version,
            accord: null,
            profils: [],
            epinglee: false,
            modifieeLe: null,
            desactivee: null,
            majEnAttente: null,
            vues: {},
          };
          const entree: EntreeExtension = {
            ...base,
            idChrome: addonIdDe(id),
            nom: analyse.nom,
            version: analyse.version,
            accord: o.accord,
            modifieeLe: maintenant,
            desactivee: base.desactivee?.raison === "plantages" ? base.desactivee : null,
          };
          return activer({ ...e, extensions: { ...e.extensions, [cle]: entree } }, cle, a.profil, prives);
        });
      } catch (err) {
        await this.nonAccordee(id, cle, analyse.portee);
        return { ok: false, erreur: (err as Error).message };
      }
      await this.appliquer(id, cle);
      return { ok: true, analyse };
    }
    await this.modifier((e) => {
      const x = e.extensions[cle];
      if (!x?.accord) return e;
      const entree: EntreeExtension = {
        ...x,
        idChrome: addonIdDe(id),
        nom: analyse.nom,
        version: analyse.version,
        modifieeLe: change || !x.modifieeLe ? maintenant : x.modifieeLe,
        // Back within its grant: it runs again. Not after crashes (re-enabled by hand).
        desactivee: x.desactivee?.raison === "portee-elargie" && !porteeElargie(x.accord, analyse.portee) ? null : x.desactivee,
      };
      return { ...e, extensions: { ...e.extensions, [cle]: entree } };
    });
    await this.appliquer(id, cle);
    return { ok: true, analyse };
  }

  /**
   * A card's grant could not be written after its install: that add-on never runs beyond a grant. No entry →
   * uninstalled; an older, narrower grant → disabled for a broadened scope (grant kept); anything failing → disabled.
   */
  private async nonAccordee(id: string, cle: string, portee: Portee): Promise<void> {
    try {
      const x = (await lireEtatExtensions(this.o.dossier)).extensions[cle];
      if (!x) return void (await this.o.rpc.request("extensions.desinstaller", { addonId: addonIdDe(id) }));
      if (!x.accord || porteeElargie(x.accord, portee))
        await this.modifier((e) => {
          const y = e.extensions[cle];
          if (!y || y.desactivee) return e;
          return { ...e, extensions: { ...e.extensions, [cle]: { ...y, desactivee: { raison: "portee-elargie", le: new Date().toISOString() } } } };
        });
      await this.appliquer(id, cle);
    } catch (e) {
      console.error(`[extensions] ${cle} : accord non écrit, désactivée :`, e);
      await this.o.rpc.request("extensions.activer", { addonId: addonIdDe(id), actif: false }).catch(() => {});
    }
  }

  /** prochaineVersion → manifesteFirefox → zipper → signer (signes/<id>.attente.xpi) → extensions.installer → signes/<id>.xpi. */
  private async signerEtInstaller(id: string, p: { staging: string; fondOriginal: string | undefined }, actif: boolean): Promise<{ ok: true; version: string } | { ok: false; erreur: string }> {
    const cleAmo = await lireCleAmo(this.env);
    if (!cleAmo) return { ok: false, erreur: CLES_ABSENTES };
    const n = await prochaineVersion(this.o.dossier, id);
    const chemin = join(p.staging, "manifest.json");
    const manifeste = manifesteFirefox(JSON.parse(await readFile(chemin, "utf8")), id, n, p.fondOriginal);
    await writeFile(chemin, JSON.stringify(manifeste, null, 2));
    const version = String(manifeste.version);
    const signes = join(this.o.dossier, "signes");
    const envoi = join(signes, `${id}.envoi.xpi`);
    const attente = join(signes, `${id}.attente.xpi`);
    await mkdir(signes, { recursive: true });
    try {
      await zipper(p.staging, envoi);
      await signer({ xpi: envoi, guid: addonIdDe(id), version, cle: cleAmo, base: this.env.WEBAIOS_TEST_AMO_URL || AMO_URL, sortie: attente, signal: this.arret.signal });
    } catch (e) {
      await rm(attente, { force: true });
      return { ok: false, erreur: e instanceof ErreurSignature ? e.message : signatureImpossible((e as Error).message) };
    } finally {
      await rm(envoi, { force: true });
    }
    try {
      await this.installer(id, attente, version, actif);
    } catch (e) {
      await rm(attente, { force: true });
      return { ok: false, erreur: installationImpossible((e as Error).message) };
    }
    await rename(attente, join(signes, `${id}.xpi`));
    return { ok: true, version };
  }

  /**
   * The controlled copy of `<dossierAgent>/<id>` in `copies/<id>.attente` (as Electron's preparerAgent: path without
   * links, checked before and after), plus the Firefox refusals. A refusal leaves no staging copy.
   */
  private async preparer(id: string): Promise<Preparation | { ok: false; refus: string[] }> {
    const staging = join(this.o.dossier, "copies", `${id}.attente`);
    const refuser = async (refus: string[]) => (await rm(staging, { recursive: true, force: true }), { ok: false as const, refus });
    await rm(staging, { recursive: true, force: true });
    const avant = await reperesDuChemin(this.o.dossierAgent, id);
    if (typeof avant === "string") return { ok: false, refus: [avant] };
    let reelAvant: string;
    try {
      reelAvant = await realpath(this.o.dossierAgent);
    } catch (e) {
      return { ok: false, refus: [`Dossier illisible : ${(e as Error).message}`] };
    }
    let r: Awaited<ReturnType<typeof preparerCopie>>;
    try {
      await mkdir(join(this.o.dossier, "copies"), { recursive: true });
      r = await preparerCopie({ source: join(this.o.dossierAgent, id), cible: staging, dossierGardes: GARDES_PAR_DEFAUT });
    } catch (e) {
      return refuser([`Copie impossible : ${(e as Error).message}`]);
    }
    const apres = await reperesDuChemin(this.o.dossierAgent, id);
    const reelApres = await realpath(this.o.dossierAgent).catch(() => "");
    if (typeof apres === "string" || !memesReperes(avant, apres) || reelApres !== reelAvant)
      return refuser([typeof apres === "string" ? apres : "Dossier remplacé pendant la copie"]);
    const lu = avant[1]!;
    if (r.racine && (r.racine.chemin !== join(reelAvant, id) || r.racine.dev !== lu.dev || r.racine.ino !== lu.ino)) return refuser(["Dossier remplacé pendant la copie"]);
    if (r.analyse.refus.length > 0) return refuser(r.analyse.refus);
    try {
      const manifeste = JSON.parse(await readFile(join(staging, "manifest.json"), "utf8"));
      const refus = refusFirefox(manifeste, await readdir(staging, { recursive: true }));
      if (refus.length > 0) return refuser(refus);
      // The original classic background, read from the copy's own generated webaios-fond.js (never the agent's folder again).
      const fond = /^importScripts\("webaios-garde-fond\.js", ("(?:[^"\\]|\\.)*")\);$/m.exec(await readFile(join(staging, "webaios-fond.js"), "utf8"));
      return { ok: true, analyse: r.analyse, empreinte: r.empreinte, staging, fondOriginal: fond ? (JSON.parse(fond[1]!) as string) : undefined };
    } catch (e) {
      return refuser([`Copie impossible : ${(e as Error).message}`]);
    }
  }
}
