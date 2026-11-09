import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  enable,
  parseManifest,
  applyPrivateProfiles,
  extensionKey,
  cutAll,
  REQUEST_REMOVED,
  disable,
  disableEverywhere,
  PRIVATE_PROFILE_ERROR,
  DEFAULT_GUARDS,
  scopeLabels,
  readExtensionsState,
  changeExtensionsState,
  widenedScope,
  prepareCopy,
  remove,
  type ManifestAnalysis,
  type AgentConsole,
  type ExtensionEntry,
  type ExtensionsState,
  type AgentExtension,
  type MessageConsole,
  type ExtensionsTools,
  type Scope,
  type ExtensionConsoleResult,
  type ExtensionRequestResult,
} from "../../../../packages/kernel/src/index.ts";
import type { ExtensionCard, ExtensionLine, SpaceExtensionLine, GrantResponse } from "../../shared/extensions.ts";
import type { ExtensionResult } from "../../shared/api.ts";
import { DISABLED_CRASHES, DISABLED_SCOPE, UNLOCK_REASON_LENGTH } from "../../shared/extensions-messages.ts";
import type { Space, Outcome } from "../../shared/model.ts";
import { ConsolesExtensions, type AgentFilter } from "../../core/extensions/consoles.ts";
import type { Rpc } from "../../shared/rpc.ts";
import { AMO_URL, KEYS_ABSENT, SignatureError, readAmoKey, signatureImpossible, sign } from "./amo.ts";
import { cardOf, unsupported } from "./carte.ts";
import { addonIdOf, firefoxManifest, nextVersion, firefoxDenial, ID_SUFFIX, zipper } from "./firefox-copy.ts";

export const FOLDER_ABSENT = "Dossier absent";
export const ACTIVATION_DENIED = "Activation refusée";
export const ACTIVATION_REMOVED = REQUEST_REMOVED;
export const ALL_CUT_AGENT = "Les extensions sont toutes désactivées : rien n'est activé";
const REMOVED_DURING_CARD = "Extension retirée pendant la carte : rien n'est activé";
const SPACE_GONE = "Espace disparu pendant la carte : rien n'est activé";
export const folderAbsent = (id: string) => `${FOLDER_ABSENT} : ~/WebAiOs/extensions/${id} n'existe plus (recrée-le, puis recharger_extension)`;
export const NO_GRANT = "Extension sans accord : demande d'abord son activation";
/** Firefox refused the signed .xpi. */
export const installationImpossible = (m: string) => "Installation impossible : " + m.slice(0, 2000);

export const CONSOLE_PRIVATE_PROFILE = "Extension active dans le profil d'un espace privé : sa console n'est jamais montrée à l'agent";
export const UNLOCK_INACTIVE = "Extension inactive ou désactivée : rien à débloquer (demande d'abord son activation)";
export const UNLOCK_CHANGED = "L'extension a changé pendant la carte : rien n'est débloqué";
const UNLOCK_DENIED = "Déblocage refusé";
export const REVIEW_DURING_OUTAGE = "Les extensions sont toutes désactivées : réactive-les pour revoir cette extension";
export const NOTHING_TO_REVIEW = "Rien à revoir pour cette extension";
const PAGE_CONSOLE_ERRORS = 20;
/** Rights that see tabs or navigation: with one, sites or all sites, the background's and pages' console stays masked. */
export const OBSERVER_RIGHTS = ["tabs", "webNavigation", "cookies", "history", "topSites", "sessions", "bookmarks", "activeTab", "clipboardRead", "contextMenus",
  "declarativeNetRequestFeedback"];
const LEVELS: readonly string[] = ["log", "info", "warn", "error", "debug"] satisfies MessageConsole["niveau"][];

/** What the unlock card showed: the unlock holds only for that. */
interface UnlockLink {
  /** The profiles where it was active: active in another one ends it. */
  profils: string[];
  /** `modifieeLe`: a new copy (reloaded, recreated) ends it. */
  marque: string | null;
}

export type SendResult = { ok: true; analyse: ManifestAnalysis } | { ok: false; erreur: string; refus?: string[] };

type Preparation = { ok: true; analyse: ManifestAnalysis; empreinte: string; staging: string; fondOriginal: string | undefined };

interface Marker {
  chemin: string;
  dev: number;
  ino: number;
}

/** Every element from the agent's extensions folder to `<id>` is a real directory (lstat), never a symbolic link. */
async function pathMarkers(agentFolder: string, id: string): Promise<Marker[] | string> {
  const markers: Marker[] = [];
  for (const path of [agentFolder, join(agentFolder, id)]) {
    let info;
    try {
      info = await lstat(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return FOLDER_ABSENT;
      return `Dossier illisible : ${(e as Error).message}`;
    }
    if (info.isSymbolicLink()) return `Lien symbolique refusé : ${path}`;
    if (!info.isDirectory()) return path === agentFolder ? FOLDER_ABSENT : `Pas un dossier : ${path}`;
    markers.push({ chemin: path, dev: info.dev, ino: info.ino });
  }
  return markers;
}

/** What Firefox answers to navigateur.espaces. */
interface Browser {
  espaces: Space[];
  fenetres: { id: string; espaceActif: string }[];
  premierPlan: string | null;
}
const privateProfilesOf = (n: Browser) => new Set(n.espaces.filter((e) => e.prive).map((e) => e.profil));

const sameMarkers = (a: Marker[], b: Marker[]) =>
  a.length === b.length && a.every((x, i) => x.chemin === b[i]!.chemin && x.dev === b[i]!.dev && x.ino === b[i]!.ino);

/** Why the console of `cle` cannot (or no longer) be unlocked, or null. */
function unlockDenial(e: ExtensionsState, privates: ReadonlySet<string>, key: string): string | null {
  const x = e.extensions[key];
  if (!x || x.source !== "agent") return `Extension inconnue : ${key}`;
  if (x.profils.some((p) => privates.has(p))) return CONSOLE_PRIVATE_PROFILE;
  if (e.toutesCoupees || x.desactivee || x.profils.length === 0) return UNLOCK_INACTIVE;
  return null;
}

/** True if `cle` is no longer what the card showed: a new copy, or active in another profile (the add-on id never changes here). */
function brokenLink(e: ExtensionsState, key: string, link: UnlockLink): boolean {
  const x = e.extensions[key];
  return !x || x.modifieeLe !== link.marque || x.profils.some((p) => !link.profils.includes(p));
}

/** Decision 4: installed but disabled unless granted, active in a profile, not disabled, and not everything cut. */
const activeIn = (e: ExtensionsState, x: ExtensionEntry | undefined) => !!x?.accord && x.profils.length > 0 && !x.desactivee && !e.toutesCoupees;

/** What the chrome's guard checkpoints read (`extensions.portees`): each granted agent extension by its add-on id. */
export type Scopes = Record<string, { cle: string; accord: Scope; profils: string[]; actif: boolean }>;
export function scopesOf(e: ExtensionsState): Scopes {
  const r: Scopes = {};
  for (const [key, x] of Object.entries(e.extensions))
    if (x.source === "agent" && x.accord) r[addonIdOf(key.slice("agent:".length))] = { cle: key, accord: x.accord, profils: x.profils, actif: activeIn(e, x) };
  return r;
}

/**
 * The agent's extensions (registry `<dossier>/etat.json`, copies, signed .xpi), kept in the kernel host; the chrome
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
  /** Consoles unlocked for the agent, by key: in memory only (quitting ends them). */
  private readonly deblocages = new Map<string, UnlockLink>();
  /** The last refused startup or reload of each key, shown until one passes. */
  private readonly erreursEnvoi = new Map<string, string>();
  /** Unlock cards shown, by key: one at a time, taken down if the extension leaves the registry or changes. */
  private readonly cartesDeblocage = new Map<string, { reponse: Promise<Outcome>; retrait: AbortController; lien: UnlockLink; attentes: number }>();
  /** Keys whose source changed while closed and that ran nowhere at startup: signed when next activated (appliquer). */
  private readonly aSigner = new Set<string>();

  constructor(private readonly o: { dossier: string; dossierAgent: string; rpc: Rpc; env?: NodeJS.ProcessEnv }) {
    this.env = o.env ?? process.env;
  }

  /** Startup (decision 5): leftovers deleted, every granted one recopied, signed again only if its source changed, then installed. */
  async demarrer(): Promise<void> {
    // First: the chrome's checkpoints wait for it (an add-on kept by Firefox starts before this host).
    this.o.rpc.notify("extensions.portees", scopesOf(await readExtensionsState(this.o.dossier)));
    for (const [sub, rest] of [
      ["copies", /\.(tmp|ancienne|attente)$/],
      ["signes", /\.(attente|envoi)\.xpi$/],
    ] as const) {
      const names = await readdir(join(this.o.dossier, sub)).catch(() => [] as string[]);
      for (const name of names) if (rest.test(name)) await rm(join(this.o.dossier, sub, name), { recursive: true, force: true }).catch(() => undefined);
    }
    const state = await readExtensionsState(this.o.dossier);
    await Promise.all(
      Object.entries(state.extensions).map(async ([key, x]) => {
        if (x.source !== "agent" || !x.accord) return;
        try {
          const r = await this.preparerEtInstaller(key.slice("agent:".length), { accord: x.accord, demarrage: true });
          if (!r.ok) console.warn(`[extensions] ${key} au démarrage : ${r.erreur}`);
        } catch (e) {
          console.error(`[extensions] ${key} non installée au démarrage :`, e);
        }
      }),
    );
  }

  /**
   * Copy, sign, install. The scope must stay within `accord` (broadened: disabled, grant kept). `demarrage`: an unchanged
   * source reinstalls the kept signed .xpi without sending anything. A failure before the install leaves the registry
   * and the running version untouched.
   */
  preparerEtInstaller(id: string, o: { accord: Scope; demarrage?: boolean }): Promise<SendResult> {
    const key = this.cle(id);
    if (!key) return Promise.resolve({ ok: false, erreur: `Identifiant d'extension invalide : ${id}` });
    return this.enFile(key, () => this.envoi(id, key, o).then((r) => this.noterEnvoi(key, r)));
  }

  /** Keeps a refused copy, signing or install as the key's error; a success or a disabling clears it. */
  private noterEnvoi<T extends SendResult>(key: string, r: T): T {
    const before = this.erreursEnvoi.get(key);
    if (r.ok || r.erreur === DISABLED_SCOPE) this.erreursEnvoi.delete(key);
    else this.erreursEnvoi.set(key, r.erreur);
    if (before !== this.erreursEnvoi.get(key)) this.o.rpc.notify("extensions.change");
    return r;
  }

  /** The agent's extension tools. */
  outils(): ExtensionsTools {
    return {
      lister: () => this.lister(),
      demander: (id, x) => this.demander(id, x),
      recharger: (id) => this.recharger(id),
      console: (id, from) => this.consolePourAgent(id, from),
      debloquerConsole: (id, reason, x) => this.debloquerConsole(id, reason, x),
      refermerConsole: async (id) => {
        const key = this.cleAgent(id);
        if (!key) return { ok: false, erreur: `Extension inconnue : ${id}` };
        return this.couperDeblocage(key);
      },
    };
  }

  /** A console message the chrome relayed (`extensions.console`); `onglet`: a content script's, readable by the agent or not. */
  noterConsole(addonId: unknown, m: unknown, tab: unknown): void {
    const x = m as Partial<MessageConsole> | null;
    if (typeof addonId !== "string" || !addonId.endsWith(ID_SUFFIX) || !this.cle(addonId.slice(0, -ID_SUFFIX.length))) return;
    if (!x || typeof x.horodatage !== "number" || typeof x.texte !== "string" || !LEVELS.includes(x.niveau as string)) return;
    const o = tab as { lisible?: unknown } | null;
    this.consoles.noter(addonId, { horodatage: x.horodatage, niveau: x.niveau!, texte: x.texte }, o ? { lisible: o.lisible === true } : undefined);
  }

  /** A crash the chrome saw (`extensions.plantage`, or queued in `extensions.pret`; spike S7): the `PLANTAGES_MAX`-th in `FENETRE_PLANTAGES_MS` disables it everywhere. */
  plantage(addonId: unknown, at?: unknown): void {
    if (typeof addonId !== "string" || !addonId.endsWith(ID_SUFFIX) || !this.cle(addonId.slice(0, -ID_SUFFIX.length))) return;
    // When the chrome saw it (a crash queued while no host ran), never later than now.
    const now = Date.now();
    this.consoles.plantage(addonId, typeof at === "number" && at <= now ? at : now);
  }

  /** Disabled everywhere after crashes (`DESACTIVEE_PLANTAGES`), shown on the page with « Réactiver ». */
  private async desactiverPlantages(addonId: string): Promise<void> {
    const key = this.cle(addonId.slice(0, -ID_SUFFIX.length))!;
    const r = await this.ecrireCle(key, (e) => {
      const x = e.extensions[key]!;
      return x.desactivee ? e : { ...e, extensions: { ...e.extensions, [key]: { ...x, desactivee: { raison: "plantages" as const, le: new Date().toISOString() } } } };
    });
    if (!r.ok) throw new Error(r.erreur);
    console.warn(`[extensions] ${key} désactivée : ${DISABLED_CRASHES}`);
  }

  /** `console_extension`: filtered (unlocked: whole); null if not in the registry. */
  private async consolePourAgent(id: string, from?: number): Promise<AgentConsole | null> {
    const key = this.cleAgent(id);
    const state = await readExtensionsState(this.o.dossier);
    const x = key ? state.extensions[key] : undefined;
    if (!key || !x) return null;
    const privates = privateProfilesOf(await this.navigateur());
    if (x.profils.some((p) => privates.has(p))) throw new Error(CONSOLE_PRIVATE_PROFILE);
    return this.consoles.pourAgent(addonIdOf(this.id(key)!), this.filtreAgent(state, key, from));
  }

  /** The console filter: unlocked; ran in an unreadable tab (entry flag, or its add-on id kept after a removal); observing right. */
  private filtreAgent(state: ExtensionsState, key: string, from?: number): AgentFilter {
    const x = state.extensions[key];
    const a = x?.accord;
    return {
      ...(from !== undefined ? { depuis: from } : {}),
      debloquee: this.deblocages.has(key),
      tourneIllisible: (x?.consoleMasquee?.length ?? 0) > 0 || !!state.consolesMasquees?.includes(addonIdOf(this.id(key)!)),
      observateur: !a || a.tousLesSites || a.scriptsTousLesSites || a.hotes.length > 0 || a.permissions.some((p) => OBSERVER_RIGHTS.includes(p)),
    };
  }

  /**
   * `debloquer_console`: the unlock card, for an agent extension active somewhere, never
   * in a private space's profile, naming the spaces of its profiles. Granted: its console is whole for what the card
   * showed, until refermer_console or a registry write that ends it (verifierDeblocages).
   */
  private async debloquerConsole(id: string, reason: string, x: { fenetre: string | null; agent: string; signal?: AbortSignal }): Promise<ExtensionConsoleResult> {
    const key = this.cleAgent(id);
    const state = await readExtensionsState(this.o.dossier);
    const entry = key ? state.extensions[key] : undefined;
    if (!key || !entry) return { ok: false, erreur: `Extension inconnue : ${id}` };
    const nav = await this.navigateur();
    const denial = unlockDenial(state, privateProfilesOf(nav), key);
    if (denial) return { ok: false, erreur: denial };
    if (this.deblocages.has(key)) return { ok: true };
    let card = this.cartesDeblocage.get(key);
    if (!card) {
      const removal = new AbortController();
      const link = { profils: [...entry.profils], marque: entry.modifieeLe };
      const request = {
        nom: entry.nom,
        espaces: nav.espaces.filter((e) => link.profils.includes(e.profil) && !e.prive).map((e) => e.nom),
        raison: reason.slice(0, UNLOCK_REASON_LENGTH),
        agent: x.agent,
        fenetre: x.fenetre,
      };
      const fresh = {
        retrait: removal,
        lien: link,
        attentes: 0,
        reponse: this.o.rpc
          .request<Outcome>("extensions.deblocage", request, AbortSignal.any([removal.signal, this.arret.signal]))
          .catch((): Outcome => "retiree")
          .finally(() => {
            if (this.cartesDeblocage.get(key) === fresh) this.cartesDeblocage.delete(key);
          }),
      };
      this.cartesDeblocage.set(key, fresh);
      card = fresh;
    }
    const opened = card;
    opened.attentes++;
    // This call dropped (new conversation) takes the card down only if it is the last one waiting for it.
    let giveUp: () => void = () => {};
    const abandon = new Promise<Outcome>((ok) => (giveUp = () => ok("retiree")));
    let gone = false;
    const from = () => {
      if (gone) return;
      gone = true;
      if (--opened.attentes === 0) opened.retrait.abort();
      giveUp();
    };
    if (x.signal?.aborted) from();
    x.signal?.addEventListener("abort", from, { once: true });
    let outcome: Outcome;
    try {
      outcome = await Promise.race([opened.reponse, abandon]);
    } finally {
      x.signal?.removeEventListener("abort", from);
      if (!gone) {
        gone = true;
        opened.attentes--;
      }
    }
    if (outcome === "retiree") return { ok: false, erreur: REQUEST_REMOVED, retiree: true };
    if (outcome !== "autoriser") return { ok: false, erreur: UNLOCK_DENIED, refusee: true };
    // The state may have changed during the card: checked again on « yes », against what the card showed.
    const after = await readExtensionsState(this.o.dossier);
    if (unlockDenial(after, privateProfilesOf(await this.navigateur()), key) || brokenLink(after, key, opened.lien)) return { ok: false, erreur: UNLOCK_CHANGED };
    this.deblocages.set(key, opened.lien);
    this.o.rpc.notify("extensions.change");
    return { ok: true };
  }

  /** « Couper le déblocage » (Extensions page) or `refermer_console`: its console is filtered again. */
  couperDeblocage(key: string): ExtensionResult {
    if (this.deblocages.delete(key)) this.o.rpc.notify("extensions.change");
    return { ok: true };
  }

  /** After each registry write: an unlock whose extension left, was disabled, cut, activated elsewhere or recopied ends; its card falls. */
  private verifierDeblocages(e: ExtensionsState, privates: ReadonlySet<string>): void {
    for (const [key, link] of [...this.deblocages]) if (unlockDenial(e, privates, key) || brokenLink(e, key, link)) this.deblocages.delete(key);
    for (const [key, card] of this.cartesDeblocage) if (unlockDenial(e, privates, key) || brokenLink(e, key, card.lien)) card.retrait.abort();
  }

  /** `<id>` or `agent:<id>`. */
  private cleAgent(id: string): string | null {
    return this.cle(id.startsWith("agent:") ? id.slice("agent:".length) : id);
  }

  /**
   * Each registry entry: the non-private spaces where it is active (named), the private ones (counted), its disabling;
   * then Firefox's AMO add-ons (decision 7): global, so active in every space, with no error.
   */
  private async lister(): Promise<AgentExtension[]> {
    const [nav, state, amo] = await Promise.all([
      this.navigateur(),
      readExtensionsState(this.o.dossier),
      // An extra source: the agent keeps its own rows if Firefox cannot list its add-ons.
      this.o.rpc.request<{ id: string; nom: string; version: string; actif: boolean }[]>("extensions.amo", {}).catch((e: unknown) => {
        console.error("[extensions] modules d'AMO non listés :", e);
        return [];
      }),
    ]);
    const privates = nav.espaces.filter((e) => e.prive).length;
    const opened = nav.espaces.filter((e) => !e.prive).map((e) => e.nom);
    const modules = amo
      .map((a): AgentExtension => ({ cle: `store:${a.id}`, source: "store", nom: a.nom, version: a.version, espaces: a.actif ? opened : [], espacesPrives: a.actif ? privates : 0, erreurs: [] }))
      .sort((a, b) => a.nom.localeCompare(b.nom) || a.cle.localeCompare(b.cle));
    const privateProfiles = privateProfilesOf(nav);
    const agent = Object.entries(state.extensions)
      .map(([key, x]): AgentExtension => {
        const spaces = nav.espaces.filter((e) => x.profils.includes(e.profil));
        const id = this.id(key);
        // Its kept error, its disabling, then its console's errors as console_extension filters them.
        const errors = [...(this.erreursEnvoi.has(key) ? [this.erreursEnvoi.get(key)!] : []), ...(x.desactivee ? [x.desactivee.raison === "plantages" ? DISABLED_CRASHES : DISABLED_SCOPE] : [])];
        if (id && !x.profils.some((p) => privateProfiles.has(p))) errors.push(...this.consoles.erreursPourAgent(addonIdOf(id), this.filtreAgent(state, key)).slice(-PAGE_CONSOLE_ERRORS));
        return {
          cle: key,
          source: x.source,
          nom: x.nom,
          version: x.version,
          espaces: spaces.filter((e) => !e.prive).map((e) => e.nom),
          espacesPrives: spaces.filter((e) => e.prive).length,
          erreurs: errors,
        };
      })
      .sort((a, b) => a.nom.localeCompare(b.nom) || a.cle.localeCompare(b.cle));
    return [...agent, ...modules];
  }

  /** The Extensions page (the agent's only): one row per registry entry, by name. */
  async liste(): Promise<ExtensionLine[]> {
    const [nav, state] = await Promise.all([this.navigateur(), readExtensionsState(this.o.dossier)]);
    const privates = privateProfilesOf(nav);
    const lignes: ExtensionLine[] = [];
    for (const [key, x] of Object.entries(state.extensions)) {
      const id = this.id(key);
      if (!id || x.source !== "agent") continue;
      const manifest = await readFile(join(this.o.dossier, "copies", id, "manifest.json"), "utf8").then((t) => JSON.parse(t) as unknown, () => null);
      // The granted scope; without a grant (never for a loaded entry), the manifest's on disk.
      const scope = x.accord ?? parseManifest(manifest, { source: "agent" }).portee;
      const disabled = x.desactivee ? (x.desactivee.raison === "plantages" ? DISABLED_CRASHES : DISABLED_SCOPE) : null;
      lignes.push({
        cle: key,
        nom: x.nom,
        source: "agent",
        version: x.version,
        droits: scopeLabels(scope, "agent"),
        sites: [...scope.hotes],
        tousLesSites: scope.tousLesSites,
        espaces: nav.espaces.filter((e) => x.profils.includes(e.profil) && !privates.has(e.profil)).map((e) => ({ nom: e.nom, profil: e.profil })),
        erreurs: [...(this.erreursEnvoi.has(key) ? [this.erreursEnvoi.get(key)!] : []), ...this.consoles.erreurs(addonIdOf(id)).slice(-PAGE_CONSOLE_ERRORS)],
        modifieeLe: x.modifieeLe,
        desactivee: disabled,
        majEnAttente: null,
        nonPrisEnCharge: unsupported(manifest),
        epinglee: x.epinglee,
        consoleDebloquee: this.deblocages.has(key),
        applis: [],
      });
    }
    return lignes.sort((a, b) => a.nom.localeCompare(b.nom) || a.cle.localeCompare(b.cle));
  }

  /** « Désactiver toutes les extensions » is on. */
  async coupees(): Promise<boolean> {
    return (await readExtensionsState(this.o.dossier)).toutesCoupees;
  }

  /** « Désactiver toutes les extensions » (kept in the registry, so across a restart): every agent add-on disabled, never uninstalled. */
  async toutCouper(yes: boolean): Promise<ExtensionResult> {
    try {
      const e = await this.modifier((e) => cutAll(e, yes));
      for (const key of Object.keys(e.extensions)) {
        const id = this.id(key);
        if (id) await this.enFile(key, () => this.appliquer(id, key));
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, erreur: (e as Error).message };
    }
  }

  /** « Désactiver partout »: out of every profile, the add-on disabled; its grant and storage stay (decision 4). */
  desactiverPartout(key: string): Promise<ExtensionResult> {
    return this.ecrireCle(key, (e) => disableEverywhere(e, key));
  }

  /** « Réactiver » after crashes: it runs again in the profiles where it was active. */
  async reactiver(key: string): Promise<ExtensionResult> {
    const r = await this.ecrireCle(key, (e) => {
      const x = e.extensions[key]!;
      return x.desactivee?.raison === "plantages" ? { ...e, extensions: { ...e.extensions, [key]: { ...x, desactivee: null } } } : e;
    });
    const id = this.id(key);
    if (r.ok && id) this.consoles.oublier(addonIdOf(id));
    return r;
  }

  /** « Revoir l'accord » (disabled for a broadened scope): the card, in `fenetre`'s active space if the extension is active there. */
  async revoir(key: string, win: string | null): Promise<ExtensionResult> {
    const id = this.id(key);
    const state = await readExtensionsState(this.o.dossier);
    const x = state.extensions[key];
    if (!id || !x) return { ok: false, erreur: `Extension inconnue : ${key}` };
    if (state.toutesCoupees) return { ok: false, erreur: REVIEW_DURING_OUTAGE };
    if (x.desactivee?.raison !== "portee-elargie") return { ok: false, erreur: NOTHING_TO_REVIEW };
    const nav = await this.navigateur();
    const privates = privateProfilesOf(nav);
    const active = nav.fenetres.find((f) => f.id === win)?.espaceActif;
    const space =
      nav.espaces.find((e) => e.id === active && x.profils.includes(e.profil)) ??
      nav.espaces.find((e) => x.profils.includes(e.profil) && !privates.has(e.profil)) ??
      nav.espaces.find((e) => e.id === active);
    if (!space) return { ok: false, erreur: "Aucun espace où la revoir" };
    const r = await this.demander(id, { espace: space.id, fenetre: win });
    return r.ok ? { ok: true } : { ok: false, erreur: r.erreur };
  }

  /** A registry write for a known agent key, in its queue, then applied to its add-on; an error comes back as text. */
  private async ecrireCle(key: string, change: (e: ExtensionsState) => ExtensionsState): Promise<ExtensionResult> {
    const id = this.id(key);
    if (!id || !(key in (await readExtensionsState(this.o.dossier)).extensions)) return { ok: false, erreur: `Extension inconnue : ${key}` };
    try {
      await this.enFile(key, async () => {
        await this.modifier((e) => (key in e.extensions ? change(e) : e));
        await this.appliquer(id, key);
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, erreur: (e as Error).message };
    }
  }

  /**
   * `demander_extension`: the space named (id or name, never a private one), else the
   * active space of the agent's window (or the foreground one); then the card, in that window.
   */
  private async demander(id: string, x: { espace?: string; fenetre: string | null; signal?: AbortSignal }): Promise<ExtensionRequestResult> {
    const key = this.cle(id);
    if (!key) return { ok: false, erreur: `Identifiant d'extension invalide : ${id}` };
    const nav = await this.navigateur();
    const f = nav.fenetres.find((w) => w.id === x.fenetre) ?? nav.fenetres.find((w) => w.id === nav.premierPlan) ?? nav.fenetres[0];
    let space: Space | undefined;
    if (x.espace !== undefined) {
      const opened = nav.espaces.filter((e) => !e.prive);
      space = opened.find((e) => e.id === x.espace) ?? opened.find((e) => e.nom.toLowerCase() === x.espace!.toLowerCase());
      if (!space) return { ok: false, erreur: `Espace inconnu : ${x.espace}` };
    } else space = nav.espaces.find((e) => e.id === f?.espaceActif);
    if (!space) return { ok: false, erreur: "Aucun espace actif" };
    const chosen = space;
    const r = await this.enFile(key, () => this.activation(id, key, chosen, f?.id ?? null, x.signal));
    if (r.ok) return { ok: true, espace: space.nom };
    if (r.erreur === ACTIVATION_DENIED) return { ok: false, erreur: r.erreur, refusee: true };
    if (r.erreur === ACTIVATION_REMOVED) return { ok: false, erreur: r.erreur, retiree: true };
    return r;
  }

  /**
   * Activation: private profile → refused without a card; already granted and active there →
   * nothing asked. Else the copy is prepared and its card shown; accepted (the scope shown, the space still there and
   * not private), it is signed and installed on that scope, and only then granted and active in the space's profile.
   */
  private async activation(id: string, key: string, space: Space, win: string | null, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; erreur: string }> {
    const profile = space.profil;
    const nav = await this.navigateur();
    if (privateProfilesOf(nav).has(profile)) return { ok: false, erreur: PRIVATE_PROFILE_ERROR };
    const state = await readExtensionsState(this.o.dossier);
    if (state.toutesCoupees) return { ok: false, erreur: ALL_CUT_AGENT };
    const known = state.extensions[key];
    if (known?.desactivee?.raison === "plantages") return { ok: false, erreur: DISABLED_CRASHES };
    if (known?.accord && !known.desactivee && known.profils.includes(profile)) {
      // Already granted and active: nothing asked again, but a folder gone is said.
      const path = await pathMarkers(this.o.dossierAgent, id);
      if (typeof path === "string") return { ok: false, erreur: path === FOLDER_ABSENT ? folderAbsent(id) : path };
      return { ok: true };
    }

    const p = await this.preparer(id);
    if (!p.ok) return { ok: false, erreur: p.refus.map((r) => (r === FOLDER_ABSENT ? folderAbsent(id) : r)).join(" ; ") };
    const clear = () => rm(p.staging, { recursive: true, force: true });
    // A signing will be needed: without keys, nothing is shown and nothing leaves.
    if ((await this.garde(id))?.empreinte !== p.empreinte && !(await readAmoKey(this.env))) {
      await clear();
      return { ok: false, erreur: KEYS_ABSENT };
    }
    // Already active elsewhere with a narrower grant: the new copy replaces it there too, the card says so.
    const otherProfiles = known?.accord && widenedScope(known.accord, p.analyse.portee) ? known.profils.filter((x) => x !== profile) : [];
    const alsoReplace = nav.espaces.filter((e) => !e.prive && otherProfiles.includes(e.profil)).map((e) => e.nom);
    const card = cardOf(p.analyse, { cle: key, espace: space, espaces: nav.espaces, remplaceAussi: alsoReplace });
    const r = await this.demanderAccord(key, card, win, signal);
    if (!(r.accepte && r.empreinte === card.empreinte)) {
      await clear();
      return { ok: false, erreur: r.retiree ? ACTIVATION_REMOVED : ACTIVATION_DENIED };
    }
    // The state may have changed during the card: checked again on « yes ».
    const after = await this.navigateur();
    const here = after.espaces.find((e) => e.id === space.id);
    const stateAfter = await readExtensionsState(this.o.dossier);
    const denial = !here
      ? SPACE_GONE
      : here.profil !== profile || privateProfilesOf(after).has(profile)
        ? PRIVATE_PROFILE_ERROR
        : stateAfter.toutesCoupees
          ? ALL_CUT_AGENT
          : known && !(key in stateAfter.extensions)
            ? REMOVED_DURING_CARD
            : null;
    if (denial) {
      await clear();
      return { ok: false, erreur: denial };
    }
    const e = await this.envoi(id, key, { accord: p.analyse.portee, activer: { espaceId: space.id, profil: profile, connue: !!known } }, p);
    if (e.ok) this.noterEnvoi(key, e);
    return e.ok ? { ok: true } : { ok: false, erreur: e.erreur };
  }

  /** The card in the chrome (`extensions.accord`); fallen, aborted or unanswerable: « retirée », never a refusal. */
  private async demanderAccord(key: string, card: ExtensionCard, win: string | null, signal?: AbortSignal): Promise<GrantResponse> {
    const removal = new AbortController();
    this.cartes.set(key, removal);
    try {
      const signals = [removal.signal, this.arret.signal, ...(signal ? [signal] : [])];
      return await this.o.rpc.request<GrantResponse>("extensions.accord", { carte: card, fenetre: win }, AbortSignal.any(signals));
    } catch {
      return { accepte: false, empreinte: card.empreinte, retiree: true };
    } finally {
      if (this.cartes.get(key) === removal) this.cartes.delete(key);
    }
  }

  /** `recharger_extension`: within its grant, signed and installed without a card; broadened, disabled (grant kept). */
  private recharger(id: string): Promise<{ etat: "rechargee" | "desactivee" | "refusee"; detail: string[] }> {
    const key = this.cle(id);
    if (!key) return Promise.resolve({ etat: "refusee", detail: [`Identifiant d'extension invalide : ${id}`] });
    // A card left open for it holds its queue: it falls first.
    this.cartes.get(key)?.abort();
    return this.enFile(key, async () => {
      const grant = (await readExtensionsState(this.o.dossier)).extensions[key]?.accord;
      if (!grant) return { etat: "refusee" as const, detail: [NO_GRANT] };
      const r = this.noterEnvoi(key, await this.envoi(id, key, { accord: grant }));
      if (r.ok) return { etat: "rechargee" as const, detail: [] };
      if (r.erreur === DISABLED_SCOPE) return { etat: "desactivee" as const, detail: [DISABLED_SCOPE] };
      return { etat: "refusee" as const, detail: r.refus ?? [r.erreur] };
    });
  }

  /** The Extensions page's « Supprimer »: its storage goes with the add-on, the agent's folder stays. */
  async supprimerPage(key: string): Promise<ExtensionResult> {
    if (!(key in (await readExtensionsState(this.o.dossier)).extensions)) return { ok: false, erreur: `Extension inconnue : ${key}` };
    return this.supprimer(key).then(
      () => ({ ok: true as const }),
      (e: unknown) => ({ ok: false as const, erreur: (e as Error).message }),
    );
  }

  /**
   * « Supprimer »: uninstalled, copy and signed .xpi deleted, registry entry removed; amo-versions.json kept (AMO never reuses a number).
   * `horsWebaios`: about:addons' pending removal, which its Undo may have cancelled since: then nothing changes.
   */
  supprimer(key: string, outsideWebaios = false): Promise<void> {
    const id = this.id(key);
    if (!id) return Promise.reject(new Error(`Identifiant d'extension invalide : ${key}`));
    this.cartes.get(key)?.abort();
    return this.enFile(key, async () => {
      // Uninstalled first: an entry gone while the add-on stays installed would run without a grant.
      const done = await this.o.rpc.request("extensions.desinstaller", outsideWebaios ? { addonId: addonIdOf(id), unlessUndone: true } : { addonId: addonIdOf(id) });
      if (done === false) return;
      await this.modifier((e) => (key in e.extensions ? remove(e, key) : e));
      this.consoles.oublier(addonIdOf(id));
      this.erreursEnvoi.delete(key);
      for (const f of [join("copies", id), join("copies", `${id}.attente`), join("signes", `${id}.xpi`), join("signes", `${id}.json`)])
        await rm(join(this.o.dossier, f), { recursive: true, force: true });
    });
  }

  /** about:addons removed it (« Supprimer », grant deleted) or disabled it (« Désactiver partout ») (decision 6). */
  async horsWebaios(addonId: string, what: "desinstallee" | "desactivee"): Promise<void> {
    if (!addonId.endsWith(ID_SUFFIX)) return;
    const key = this.cle(addonId.slice(0, -ID_SUFFIX.length));
    if (!key || !(key in (await readExtensionsState(this.o.dossier)).extensions)) return;
    if (what === "desinstallee") return this.supprimer(key, true);
    await this.enFile(key, () => this.modifier((e) => (key in e.extensions ? disableEverywhere(e, key) : e)));
  }

  /**
   * The chrome saw it about to run in a tab of `profil` the agent cannot read: its
   * console stays masked to the agent there (`consoleMasquee`), and by add-on id (`consolesMasquees`, never emptied).
   */
  async aTourne(addonId: string, profile: string, readable: boolean): Promise<void> {
    if (readable || typeof addonId !== "string" || typeof profile !== "string" || !addonId.endsWith(ID_SUFFIX)) return;
    const key = this.cle(addonId.slice(0, -ID_SUFFIX.length));
    if (!key) return;
    await this.enFile(key, () =>
      this.modifier((e) => {
        const x = e.extensions[key];
        if (x?.source !== "agent") return e;
        const hidden = e.consolesMasquees?.includes(addonId) ? e.consolesMasquees : [...(e.consolesMasquees ?? []), addonId];
        const profiles = x.consoleMasquee?.includes(profile) ? x.consoleMasquee : [...(x.consoleMasquee ?? []), profile];
        return { ...e, consolesMasquees: hidden, extensions: { ...e.extensions, [key]: { ...x, consoleMasquee: profiles } } };
      }),
    );
  }

  /**
   * The chrome's private profiles (`extensions.profilsPrives`): each agent extension
   * active in one is taken out of it, the tabs of those profiles where it ran are reloaded (A7: its scripts stop), and
   * it is disabled where it is active nowhere else.
   */
  async profilsPrives(privates: string[]): Promise<void> {
    const { retirees: removed } = applyPrivateProfiles(await readExtensionsState(this.o.dossier), new Set(privates));
    if (removed.length === 0) return;
    await this.modifier((e) => e);
    const byKey = new Map<string, string[]>();
    for (const r of removed) byKey.set(r.cle, [...(byKey.get(r.cle) ?? []), r.profil]);
    for (const [key, profiles] of byKey) {
      const id = this.id(key);
      if (!id) continue;
      this.o.rpc.notify("extensions.rechargerOnglets", { addonId: addonIdOf(id), profils: profiles });
      await this.enFile(key, () => this.appliquer(id, key));
    }
  }

  /**
   * The « Extensions » section of a space's settings (the agent's only): registry entries and the
   * agent's folders never granted (their names only), seen from that space's profile.
   */
  async pourEspace(spaceId: string): Promise<SpaceExtensionLine[]> {
    const nav = await this.navigateur();
    const space = nav.espaces.find((e) => e.id === spaceId);
    if (!space) return [];
    const state = await readExtensionsState(this.o.dossier);
    const others = nav.espaces.filter((e) => e.id !== space.id && e.profil === space.profil).map((e) => e.nom);
    const grayed = privateProfilesOf(nav).has(space.profil) ? PRIVATE_PROFILE_ERROR : null;
    const lignes: SpaceExtensionLine[] = Object.entries(state.extensions)
      .filter(([, x]) => x.source === "agent")
      .map(([key, x]) => {
        const active = x.profils.includes(space.profil);
        return { cle: key, nom: x.nom, source: "agent", active, aussiDans: active ? others : [], grisee: grayed, profils: [...x.profils] };
      });
    for (const d of await readdir(this.o.dossierAgent, { withFileTypes: true }).catch(() => [])) {
      const key = this.cle(d.name);
      if (!d.isDirectory() || !key || key in state.extensions) continue;
      lignes.push({ cle: key, nom: d.name, source: "agent", active: false, aussiDans: [], grisee: grayed, profils: [] });
    }
    return lignes.sort((a, b) => a.nom.localeCompare(b.nom) || a.cle.localeCompare(b.cle));
  }

  /**
   * A space settings' switch: off → taken out of the space's profile; on → refused in a private
   * profile, through the card without a grant (or disabled for a broadened scope), else active there at once.
   */
  async basculer(key: string, spaceId: string, active: boolean, win: string | null): Promise<{ ok: true } | { ok: false; erreur: string }> {
    const id = this.id(key);
    if (!id) return { ok: false, erreur: `Extension inconnue : ${key}` };
    const nav = await this.navigateur();
    const space = nav.espaces.find((e) => e.id === spaceId);
    if (!space) return { ok: false, erreur: "Espace inconnu" };
    const profile = space.profil;
    const write = (change: (e: ExtensionsState, privates: ReadonlySet<string>) => ExtensionsState) =>
      this.enFile(key, async () => {
        await this.modifier(change);
        await this.appliquer(id, key);
      }).then(
        () => ({ ok: true as const }),
        (e: unknown) => ({ ok: false as const, erreur: (e as Error).message }),
      );
    if (!active) return write((e) => (key in e.extensions ? disable(e, key, profile) : e));
    if (privateProfilesOf(nav).has(profile)) return { ok: false, erreur: PRIVATE_PROFILE_ERROR };
    const state = await readExtensionsState(this.o.dossier);
    if (state.toutesCoupees) return { ok: false, erreur: ALL_CUT_AGENT };
    const x = state.extensions[key];
    if (!(x?.accord && x.desactivee === null)) {
      const r = await this.demander(id, { espace: space.id, fenetre: win });
      return r.ok ? { ok: true } : { ok: false, erreur: r.erreur };
    }
    // Checked again in the serialized write: everything cut, or a disabling, may have come in between.
    return write((e, privates) => {
      if (e.toutesCoupees) throw new Error(ALL_CUT_AGENT);
      const d = e.extensions[key]?.desactivee;
      if (d) throw new Error(d.raison === "plantages" ? DISABLED_CRASHES : DISABLED_SCOPE);
      return enable(e, key, profile, privates);
    });
  }

  /** Quitting: a signing in progress is dropped (its version number stays taken; the change is signed again at the next startup). */
  arreter(): void {
    this.arret.abort();
  }

  private cle(id: string): string | null {
    try {
      return extensionKey("agent", id);
    } catch {
      return null;
    }
  }

  private id(key: string): string | null {
    return key.startsWith("agent:") && this.cle(key.slice("agent:".length)) === key ? key.slice("agent:".length) : null;
  }

  private enFile<T>(key: string, f: () => Promise<T>): Promise<T> {
    const next = (this.files.get(key) ?? Promise.resolve()).catch(() => {}).then(f);
    this.files.set(key, next);
    void next
      .finally(() => {
        if (this.files.get(key) === next) this.files.delete(key);
      })
      .catch(() => {});
    return next;
  }

  /** Registry change; the profiles of private spaces (asked from Firefox) are taken out of every agent extension. */
  private async modifier(change: (e: ExtensionsState, privates: ReadonlySet<string>) => ExtensionsState): Promise<ExtensionsState> {
    const privates = privateProfilesOf(await this.navigateur());
    const e = await changeExtensionsState(this.o.dossier, change, () => privates);
    this.verifierDeblocages(e, privates);
    this.o.rpc.notify("extensions.portees", scopesOf(e));
    this.o.rpc.notify("extensions.change");
    return e;
  }

  private navigateur(): Promise<Browser> {
    return this.o.rpc.request<Browser>("navigateur.espaces", {});
  }

  private async actif(key: string): Promise<boolean> {
    const e = await readExtensionsState(this.o.dossier);
    return activeIn(e, e.extensions[key]);
  }

  /** As the registry says (decision 4): active → the kept signed .xpi installed if missing, then enabled; inactive → disabled, never installed fresh. */
  private async appliquer(id: string, key: string): Promise<void> {
    const active = await this.actif(key);
    if (active && this.aSigner.delete(key)) return this.signerActivee(id, key);
    const kept = await this.garde(id);
    if (kept) await this.installer(id, join(this.o.dossier, "signes", `${id}.xpi`), kept.version, active);
    await this.o.rpc.request("extensions.activer", { addonId: addonIdOf(id), actif: active });
  }

  /** Active again after a startup that did not sign its changed source: signed now, else the kept version runs. */
  private async signerActivee(id: string, key: string): Promise<void> {
    const x = (await readExtensionsState(this.o.dossier)).extensions[key];
    const r = x?.accord ? this.noterEnvoi(key, await this.envoi(id, key, { accord: x.accord, demarrage: true })) : null;
    // envoi applied it, or disabled it (broadened scope, folder gone); otherwise the kept version runs.
    if (!r?.ok && r?.erreur !== DISABLED_SCOPE && !r?.refus?.includes(FOLDER_ABSENT)) await this.appliquer(id, key);
  }

  /** Active once envoi is done: a scope-disabled one back within its grant runs again. */
  private async actifApresEnvoi(key: string): Promise<boolean> {
    const e = await readExtensionsState(this.o.dossier);
    const x = e.extensions[key];
    return activeIn(e, x?.desactivee?.raison === "portee-elargie" ? { ...x, desactivee: null } : x);
  }

  /** The last signed and installed version (`signes/<id>.json`), if its .xpi is there. */
  private async garde(id: string): Promise<{ version: string; empreinte: string } | null> {
    const signs = join(this.o.dossier, "signes");
    if (!(await lstat(join(signs, `${id}.xpi`)).then(() => true, () => false))) return null;
    return readFile(join(signs, `${id}.json`), "utf8").then((t) => JSON.parse(t) as { version: string; empreinte: string }, () => null);
  }

  /** `actif` false: Firefox installs it only over a present add-on (disabled first), never fresh. */
  private installer(id: string, xpi: string, version: string, active: boolean): Promise<{ version: string } | null> {
    return this.o.rpc.request("extensions.installer", { addonId: addonIdOf(id), xpi, temporaire: !!this.env.WEBAIOS_TEST_AMO_URL, version, actif: active });
  }

  /**
   * `activer`: a grant card was accepted for `accord` (the scope shown) in `profil`: installed active, and only once
   * installed is the grant written (`connue`: an entry existed when the card was shown). A failure leaves no grant.
   */
  private async envoi(
    id: string,
    key: string,
    o: { accord: Scope; demarrage?: boolean; activer?: { espaceId: string; profil: string; connue: boolean } },
    prepare?: Preparation,
  ): Promise<SendResult> {
    const p = prepare ?? (await this.preparer(id));
    if (!p.ok) {
      // Only a missing folder stops the running version.
      if (p.refus.includes(FOLDER_ABSENT)) await this.o.rpc.request("extensions.activer", { addonId: addonIdOf(id), actif: false });
      return { ok: false, erreur: p.refus.map((r) => (r === FOLDER_ABSENT ? folderAbsent(id) : r)).join(" ; "), refus: p.refus };
    }
    const { analyse: analysis, empreinte: hash, staging } = p;
    const clear = () => rm(staging, { recursive: true, force: true });
    if (widenedScope(o.accord, analysis.portee)) {
      await clear();
      await this.modifier((e) => {
        const x = e.extensions[key];
        if (!x || x.desactivee?.raison === "portee-elargie") return e;
        return { ...e, extensions: { ...e.extensions, [key]: { ...x, desactivee: { raison: "portee-elargie", le: new Date().toISOString() } } } };
      });
      await this.appliquer(id, key);
      return { ok: false, erreur: DISABLED_SCOPE };
    }

    const signs = join(this.o.dossier, "signes");
    let change = true;
    // Unchanged since the last signing (startup, a grant in another profile, or a reload): appliquer below reinstalls
    // the kept .xpi if it is missing, nothing is sent; a reload restarts the running one.
    const kept = await this.garde(id);
    if (kept?.empreinte === hash) {
      await clear();
      // A reload still counts as a new start (modifieeLe: its console unlock ends).
      if (!o.demarrage && !o.activer) await this.o.rpc.request("extensions.redemarrer", { addonId: addonIdOf(id) });
      else change = false;
    } else if (o.demarrage && kept && !(await this.actifApresEnvoi(key))) {
      // Active nowhere: nothing leaves for AMO; the kept version stays until it is activated again.
      await clear();
      this.aSigner.add(key);
      await this.appliquer(id, key);
      return { ok: true, analyse: analysis };
    } else {
      const r = await this.signerEtInstaller(id, p, o.activer ? true : await this.actif(key));
      if (!r.ok) {
        await clear();
        return r;
      }
      this.aSigner.delete(key);
      await writeFile(join(signs, `${id}.json`), JSON.stringify({ version: r.version, empreinte: hash }));
      const copy = join(this.o.dossier, "copies", id);
      await rm(copy, { recursive: true, force: true });
      await rename(staging, copy);
    }
    const now = new Date().toISOString();
    const a = o.activer;
    if (a) {
      try {
        // The signing takes minutes: the space is checked again before anything is granted for it.
        const nav = await this.navigateur();
        const here = nav.espaces.find((e) => e.id === a.espaceId);
        if (!here) throw new Error(SPACE_GONE);
        if (here.profil !== a.profil || privateProfilesOf(nav).has(a.profil)) throw new Error(PRIVATE_PROFILE_ERROR);
        await this.modifier((e, privates) => {
          if (e.toutesCoupees) throw new Error(ALL_CUT_AGENT);
          const x = e.extensions[key];
          if (a.connue && !x) throw new Error(REMOVED_DURING_CARD);
          const base: ExtensionEntry = x ?? {
            source: "agent",
            idChrome: null,
            nom: analysis.nom,
            version: analysis.version,
            accord: null,
            profils: [],
            epinglee: false,
            modifieeLe: null,
            desactivee: null,
            majEnAttente: null,
            vues: {},
          };
          const entry: ExtensionEntry = {
            ...base,
            idChrome: addonIdOf(id),
            nom: analysis.nom,
            version: analysis.version,
            accord: o.accord,
            modifieeLe: now,
            desactivee: base.desactivee?.raison === "plantages" ? base.desactivee : null,
          };
          return enable({ ...e, extensions: { ...e.extensions, [key]: entry } }, key, a.profil, privates);
        });
      } catch (err) {
        await this.nonAccordee(id, key, analysis.portee);
        return { ok: false, erreur: (err as Error).message };
      }
      await this.appliquer(id, key);
      return { ok: true, analyse: analysis };
    }
    await this.modifier((e) => {
      const x = e.extensions[key];
      if (!x?.accord) return e;
      const entry: ExtensionEntry = {
        ...x,
        idChrome: addonIdOf(id),
        nom: analysis.nom,
        version: analysis.version,
        modifieeLe: change || !x.modifieeLe ? now : x.modifieeLe,
        // Back within its grant: it runs again. Not after crashes (re-enabled by hand).
        desactivee: x.desactivee?.raison === "portee-elargie" && !widenedScope(x.accord, analysis.portee) ? null : x.desactivee,
      };
      return { ...e, extensions: { ...e.extensions, [key]: entry } };
    });
    await this.appliquer(id, key);
    return { ok: true, analyse: analysis };
  }

  /**
   * A card's grant could not be written after its install: that add-on never runs beyond a grant. No entry →
   * uninstalled; an older, narrower grant → disabled for a broadened scope (grant kept); anything failing → disabled.
   */
  private async nonAccordee(id: string, key: string, scope: Scope): Promise<void> {
    try {
      const x = (await readExtensionsState(this.o.dossier)).extensions[key];
      if (!x) return void (await this.o.rpc.request("extensions.desinstaller", { addonId: addonIdOf(id) }));
      if (!x.accord || widenedScope(x.accord, scope))
        await this.modifier((e) => {
          const y = e.extensions[key];
          if (!y || y.desactivee) return e;
          return { ...e, extensions: { ...e.extensions, [key]: { ...y, desactivee: { raison: "portee-elargie", le: new Date().toISOString() } } } };
        });
      await this.appliquer(id, key);
    } catch (e) {
      console.error(`[extensions] ${key} : accord non écrit, désactivée :`, e);
      await this.o.rpc.request("extensions.activer", { addonId: addonIdOf(id), actif: false }).catch(() => {});
    }
  }

  /** nextVersion → firefoxManifest → zipper → signer (signes/<id>.attente.xpi) → extensions.installer → signes/<id>.xpi. */
  private async signerEtInstaller(id: string, p: { staging: string; fondOriginal: string | undefined }, active: boolean): Promise<{ ok: true; version: string } | { ok: false; erreur: string }> {
    const amoKey = await readAmoKey(this.env);
    if (!amoKey) return { ok: false, erreur: KEYS_ABSENT };
    const n = await nextVersion(this.o.dossier, id);
    const path = join(p.staging, "manifest.json");
    const manifest = firefoxManifest(JSON.parse(await readFile(path, "utf8")), id, n, p.fondOriginal);
    await writeFile(path, JSON.stringify(manifest, null, 2));
    const version = String(manifest.version);
    const signs = join(this.o.dossier, "signes");
    const sending = join(signs, `${id}.envoi.xpi`);
    const waiting = join(signs, `${id}.attente.xpi`);
    await mkdir(signs, { recursive: true });
    try {
      await zipper(p.staging, sending);
      await sign({ xpi: sending, guid: addonIdOf(id), version, cle: amoKey, base: this.env.WEBAIOS_TEST_AMO_URL || AMO_URL, sortie: waiting, signal: this.arret.signal });
    } catch (e) {
      await rm(waiting, { force: true });
      return { ok: false, erreur: e instanceof SignatureError ? e.message : signatureImpossible((e as Error).message) };
    } finally {
      await rm(sending, { force: true });
    }
    try {
      await this.installer(id, waiting, version, active);
    } catch (e) {
      await rm(waiting, { force: true });
      return { ok: false, erreur: installationImpossible((e as Error).message) };
    }
    await rename(waiting, join(signs, `${id}.xpi`));
    return { ok: true, version };
  }

  /**
   * The controlled copy of `<dossierAgent>/<id>` in `copies/<id>.attente` (path without
   * links, checked before and after), plus the Firefox refusals. A refusal leaves no staging copy.
   */
  private async preparer(id: string): Promise<Preparation | { ok: false; refus: string[] }> {
    const staging = join(this.o.dossier, "copies", `${id}.attente`);
    const deny = async (denial: string[]) => (await rm(staging, { recursive: true, force: true }), { ok: false as const, refus: denial });
    await rm(staging, { recursive: true, force: true });
    const before = await pathMarkers(this.o.dossierAgent, id);
    if (typeof before === "string") return { ok: false, refus: [before] };
    let realBefore: string;
    try {
      realBefore = await realpath(this.o.dossierAgent);
    } catch (e) {
      return { ok: false, refus: [`Dossier illisible : ${(e as Error).message}`] };
    }
    let r: Awaited<ReturnType<typeof prepareCopy>>;
    try {
      await mkdir(join(this.o.dossier, "copies"), { recursive: true });
      r = await prepareCopy({ source: join(this.o.dossierAgent, id), cible: staging, dossierGardes: DEFAULT_GUARDS });
    } catch (e) {
      return deny([`Copie impossible : ${(e as Error).message}`]);
    }
    const after = await pathMarkers(this.o.dossierAgent, id);
    const realAfter = await realpath(this.o.dossierAgent).catch(() => "");
    if (typeof after === "string" || !sameMarkers(before, after) || realAfter !== realBefore)
      return deny([typeof after === "string" ? after : "Dossier remplacé pendant la copie"]);
    const lu = before[1]!;
    if (r.racine && (r.racine.chemin !== join(realBefore, id) || r.racine.dev !== lu.dev || r.racine.ino !== lu.ino)) return deny(["Dossier remplacé pendant la copie"]);
    if (r.analyse.refus.length > 0) return deny(r.analyse.refus);
    try {
      const manifest = JSON.parse(await readFile(join(staging, "manifest.json"), "utf8"));
      const denial = firefoxDenial(manifest, await readdir(staging, { recursive: true }));
      if (denial.length > 0) return deny(denial);
      // The original classic background, read from the copy's own generated webaios-fond.js (never the agent's folder again).
      const background = /^importScripts\("webaios-garde-fond\.js", ("(?:[^"\\]|\\.)*")\);$/m.exec(await readFile(join(staging, "webaios-fond.js"), "utf8"));
      return { ok: true, analyse: r.analyse, empreinte: r.empreinte, staging, fondOriginal: background ? (JSON.parse(background[1]!) as string) : undefined };
    } catch (e) {
      return deny([`Copie impossible : ${(e as Error).message}`]);
    }
  }
}
