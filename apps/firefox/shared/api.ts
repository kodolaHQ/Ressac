import { z } from "zod";
import { validFolder, ID_EXECUTION, ID_SITE, type Application, type Warning, type BlockCatalogEntry, type DeclarationWidget, type DirectState, type DraftRead, type SaveResult, type AttemptResult, type DevRight, type AiState, type WidgetState, type Execution, type ResumeExecution, type ActionsState, type PageAction, type LaunchResult, type Owner } from "@webaios/kernel";
import type { BatchState, ProjectId, ExternalProject, TrackedProject } from "@webaios/kernel";
import { PROJECT_ID, type Comment, type DiffFile, type ModifiedFile } from "@webaios/kernel";
import type { ActionShown } from "./actions";
import type { ActionSite, SiteWindowState, MessageToHome, ShownSite } from "./sites";
import type { ExtensionsBar, ExtensionLine, SpaceExtensionLine, SiteExtensionLine } from "./extensions";
import type { LeftZone } from "./revelation";
import type { Decision, PendingRequest, AccessState, BrowserState, SpaceId, WindowId, TabId, Download, Visit } from "./model";

const id = z.string().min(1);
const engine = z.enum(["google", "duckduckgo", "qwant"]);

/** The actions, validated at the entry of the main process: the schema is the source of the type. */
export const SchemaAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ouvrirOnglet"),
    fenetreId: id,
    url: z.string(),
    espaceId: id.optional(),
    activer: z.boolean().optional(),
    ouvertParAgent: z.boolean().optional(),
    apres: id.optional(),
  }),
  z.object({ type: z.literal("fermerOnglet"), id }),
  // garderEspace: the tab becomes its space's tab without the window changing space (an extension's request).
  z.object({ type: z.literal("activerOnglet"), id, garderEspace: z.boolean().optional() }),
  z.object({ type: z.literal("deplacerOnglet"), id, index: z.number().int() }),
  z.object({ type: z.literal("rouvrirOngletFerme"), fenetreId: id }),
  z.object({
    type: z.literal("majOnglet"),
    id,
    champs: z
      .object({
        url: z.string(),
        titre: z.string(),
        favicon: z.string().nullable(),
        chargement: z.boolean(),
        peutReculer: z.boolean(),
        peutAvancer: z.boolean(),
        zoom: z.number(),
        plante: z.boolean(),
        erreur: z.string().nullable(),
      })
      .partial(),
  }),
  z.object({ type: z.literal("ouvrirFavori"), fenetreId: id, genre: z.enum(["essentiel", "epingle"]), id }),
  z.object({ type: z.literal("epinglerOnglet"), id }),
  z.object({ type: z.literal("desepingler"), espaceId: id, favoriId: id }),
  z.object({ type: z.literal("ajouterEssentiel"), id }),
  z.object({ type: z.literal("retirerEssentiel"), favoriId: id }),
  /** `profil`: an existing login profile, or « nouveau » to create one specific to the space. */
  z.object({ type: z.literal("creerEspace"), nom: z.string().min(1), icone: z.string().min(1), prive: z.boolean(), profil: id, fenetreId: id.optional() }),
  z.object({ type: z.literal("reglerEspace"), id, nom: z.string().min(1), icone: z.string().min(1), prive: z.boolean(), profil: id }),
  z.object({ type: z.literal("supprimerEspace"), id }),
  z.object({ type: z.literal("activerEspace"), fenetreId: id, id }),
  z.object({ type: z.literal("ouvrirFenetre"), id: id.optional(), espaceId: id.optional() }),
  z.object({ type: z.literal("fermerFenetre"), id }),
  z.object({
    type: z.literal("cadrerFenetre"),
    id,
    cadre: z.object({ x: z.number(), y: z.number(), largeur: z.number().positive(), hauteur: z.number().positive() }),
  }),
  z.object({ type: z.literal("afficherPageVide"), fenetreId: id }),
  z.object({ type: z.literal("basculerCompact"), fenetreId: id }),
  z.object({ type: z.literal("basculerPanneauAgent"), fenetreId: id }),
  /** Activates the Applications page of the active space, or opens it. */
  z.object({ type: z.literal("ouvrirApplications"), fenetreId: id }),
  /** Activates this window's Extensions page, or opens it (like Applications). */
  z.object({ type: z.literal("ouvrirExtensions"), fenetreId: id }),
  /** Activates the « Voir le workflow » page of widget `id` in this window, or opens it. */
  z.object({
    type: z.literal("ouvrirWorkflow"),
    fenetreId: id,
    id: z.string().regex(/^[a-z0-9-]+$/).max(100),
    nom: z.string().max(60),
    /** An action's workflow (`webaios://workflow/action/<id>`) rather than a widget's. */
    proprietaire: z.literal("action").optional(),
  }),
  /**
   * Activates the page of action `id` in this window (a `webaios://action/<id>[/…]` tab, in a non-private space),
   * or opens it; `execution` shows that result there.
   */
  z.object({
    type: z.literal("ouvrirAction"),
    fenetreId: id,
    id: z.string().regex(/^[a-z0-9-]{1,60}$/),
    nom: z.string().max(60),
    execution: z.string().regex(ID_EXECUTION).max(64).optional(),
  }),
  /** Activates this window's « Actions » page, or opens it. */
  z.object({ type: z.literal("ouvrirActions"), fenetreId: id }),
  /** Automatic opening and closing of the panel by the home page (not an action of the user). */
  z.object({ type: z.literal("panneauAgentAccueil"), fenetreId: id, ouvert: z.boolean() }),
  z.object({ type: z.literal("choisirMoteur"), moteur: engine }),
  z.object({ type: z.literal("choisirProfilAgent"), profil: z.string().regex(/^[\w-]+$/).max(64) }),
  z.object({ type: z.literal("largeurPanneauAgent"), largeur: z.number().finite() }),
  /** Activates this window's project Review page, or opens it (one per project and per window). */
  z.object({ type: z.literal("ouvrirRelecture"), fenetreId: id, projet: z.string().regex(PROJECT_ID), nom: z.string().max(80) }),
]);
export type Action = z.infer<typeof SchemaAction>;

export const CommandSchema = z.union([
  z.object({ ongletId: id, c: z.enum(["reculer", "avancer", "recharger", "rechargerSansCache", "arreter", "finRecherche", "outils"]) }),
  z.object({ ongletId: id, c: z.object({ zoom: z.enum(["plus", "moins", "zero"]) }) }),
  z.object({ ongletId: id, c: z.object({ chercher: z.string(), suivant: z.boolean().optional(), precedent: z.boolean().optional() }) }),
]);
export type TabCommand = z.infer<typeof CommandSchema>["c"];

export const BoundsSchema = z.object({ x: z.number(), y: z.number(), largeur: z.number(), hauteur: z.number() });
export type BoundsRange = z.infer<typeof BoundsSchema>;

export type Panel = "historique" | "telechargements";
/**
 * Menu shortcuts meant for the UI (the web page often has focus). `fermerOnglet`: ⌘W on the builder,
 * which first asks whether some code is unsaved.
 */
export type ShortcutAction = "rechercher" | "chercherSuivant" | "chercherPrecedent" | "adresse" | "commande" | "agent" | "fermerOnglet";
export interface SearchResult {
  ongletId: TabId;
  actif: number;
  total: number;
}

/** The API the UI gets as `window.webaios` (ui/install-api.ts). */
export interface ApiWebaios {
  fenetreId: WindowId;
  agir(action: Action): void;
  surEtat(callback: (e: BrowserState) => void): () => void;
  /** `ongletId` null: the input opens a new tab (blank page). */
  naviguer(tabId: TabId | null, input: string): void;
  commande(tabId: TabId, c: TabCommand): void;
  bornesContenu(b: BoundsRange): void;
  /** macOS: the window buttons follow the sidebar (hidden with it in compact mode). */
  boutonsFenetre(visible: boolean): void;
  /** Compact mode: over a web page, the mouse changes zone relative to the left edge (see revelation.ts). */
  surZoneGauche(callback: (zone: LeftZone) => void): () => void;
  /** The menu asks to open a UI panel (⌘Y…). */
  surPanneau(callback: (p: Panel) => void): () => void;
  surRaccourci(callback: (r: ShortcutAction) => void): () => void;
  surResultatRecherche(callback: (r: SearchResult) => void): () => void;
  /** HTML fullscreen (video…): the UI fades away. */
  surPleinEcran(callback: (active: boolean) => void): () => void;
  historique: {
    /** `distinctes`: a single row per URL (address bar); otherwise one per URL and per space. */
    rechercher(text: string, limit?: number, distinct?: boolean): Promise<Visit[]>;
    recents(): Promise<Visit[]>;
    /** `depuis`: ISO date; absent, the whole history. */
    effacer(from?: string): Promise<void>;
    /** Forgets the text kept for a visit (a URL in a space), without deleting the visit. */
    oublierTexte(url: string, spaceId: string): Promise<void>;
  };
  telechargements: {
    liste(): Promise<Download[]>;
    ouvrir(id: string): void;
    montrer(id: string): void;
    annuler(id: string): void;
  };
  surTelechargements(callback: (list: Download[]) => void): () => void;
  permissions: {
    enAttente(): Promise<PendingRequest[]>;
    /** `o.confirme`: the « Je comprends » box of a hardened extension card is checked. */
    repondre(id: string, decision: Decision, rights?: DevRight[], o?: { confirme?: boolean }): void;
  };
  surPermissions(callback: (list: PendingRequest[]) => void): () => void;
  /**
   * A modal opens: the keyboard returns to the UI, and the page shown by `ongletId` is captured (reduced JPEG data URL)
   * to stay visible, blurred, behind the modal. null: no page to show, or capture failed.
   */
  apercuPage(tabId: TabId | null): Promise<string | null>;
  /** This window's ⌃Tab panel: sent 200 ms after the first ⌃Tab if ⌃ is still held; null closes it. */
  surPanneauOnglets(callback: (p: TabsPanel | null) => void): () => void;
  /** The ⌃Tab panel acts on the current cycle (no effect outside a cycle). */
  parcoursOnglets(m: TabCycleMessage): void;
  /** The command bar closes: the keyboard goes back to the displayed page (as soon as the UI shows it again). */
  rendreFocusPage(): void;
  /** This window's agent terminal. */
  agent: {
    /** Starts the session (or finds it again: its state and recent output are returned). */
    demarrer(t: TerminalSize): void;
    ecrire(d: string): void;
    redimensionner(t: TerminalSize): void;
    surDonnees(callback: (d: string) => void): () => void;
    surEtat(callback: (e: AgentPanelState) => void): () => void;
    /** Available agent profiles (the choice goes through the choisirProfilAgent action). */
    profils(): Promise<{ id: string; nom: string }[]>;
  };
  /** The agent's access to tabs (badges and bubble to cut it). */
  acces: {
    etat(): Promise<AccessState>;
    couper(id: TabId, right?: DevRight): void;
  };
  /** The agent's access to a tab changed: the full state is broadcast again. */
  surAcces(callback: (e: AccessState) => void): () => void;
  /** Home page: the widgets of the agent space's accueil/widgets. */
  accueil: {
    lire(): Promise<ShownWidget[]>;
    /** A widget, its layout, its data or its state changed: re-read. */
    surChange(callback: () => void): () => void;
    /** New layout (all placed widgets); refused if a placement leaves the grid or targets an unknown id. */
    placer(placements: Placement[]): void;
    /** Puts the widget in the trash (accueil/.corbeille) and removes its grant. */
    retirer(id: string): void;
    /**
     * Link requested by the display of widget `id`: http(s) only, in a tab of this window. Opened only
     * if a real click of the user just landed in this widget's display (seen by the UI's listener on the frame).
     */
    ouvrir(url: string, id: string): void;
    /** Login profiles a grant can use (never a private space's). */
    profilsPourAccord(): Promise<ProfileForGrant[]>;
    /**
     * The user authorizes the widget to read with their account, in this profile. `compte` and `publiques`: exactly what the
     * card showed them; refused (with the error) if the declaration changed since.
     */
    accorder(a: Grant): Promise<{ ok: true } | { ok: false; erreur: string }>;
    /** The user refuses or removes the grant: the data read with the account is erased. */
    refuserAccord(id: string): void;
    /** « Mettre à jour maintenant ». */
    recolter(id: string): void;
    /** The widget's latest executions, most recent first. */
    executions(id: string): Promise<ResumeExecution[]>;
    /** A complete execution (blocks, outputs, logs); null if it no longer exists or the id is invalid. */
    execution(id: string, execution: string): Promise<Execution | null>;
  };
  /**
   * The visual builder of workflows: a widget's (page `webaios://workflow/<id>`) or an action's
   * (`webaios://workflow/action/<id>`, refused when the window's active space is private).
   */
  workflow: {
    catalogue(): Promise<BlockCatalogEntry[]>;
    /** null: unknown widget or action, or without a workflow. */
    lire(target: Owner): Promise<WorkflowEdit | null>;
    enregistrer(target: Owner, draft: Draft): Promise<SaveResult & { avertissements: Warning[] }>;
    lireCode(target: Owner, name: string): Promise<{ texte: string } | { absent: true } | { erreur: string }>;
    enregistrerCode(target: Owner, name: string, text: string): Promise<{ ok: true } | { ok: false; erreur: string }>;
    /** A trial; for an action, its page shows in the preview, never as the latest result. */
    rejouer(target: Owner, execution: string, block: string): Promise<AttemptResult>;
    /**
     * Starts a real execution now; returns its id (absent if the agent is stopped or nothing ran). An action
     * receives `saisie` and may return the refusal (`erreur`: required input, required grant…).
     */
    lancer(target: Owner, input?: string | null): Promise<{ execution?: string; erreur?: string }>;
    /** The block selected in this window's builder (for workflow_ouvert). */
    selection(target: Owner, block: string | null): void;
    /** The executions of the running widgets (those of actions: `actions.direct`). */
    direct(): Promise<DirectState>;
    surDirect(callback: (e: DirectState) => void): () => void;
  };
  /** Local AI (Kev and Gemma) of the harvests. */
  ia: {
    etat(): Promise<LocalAiStateShown>;
    /** Downloads Kev and Gemma (several gigabytes): only on a click by the user. */
    installer(): Promise<{ ok: boolean; erreur?: string }>;
    surEtat(callback: (e: LocalAiStateShown) => void): () => void;
    /** A line of the install output. */
    surProgres(callback: (line: string) => void): () => void;
  };
  /**
   * The actions (`~/WebAiOs/actions`) and their pages. Refused when the window's active space is private
   * (`ACTIONS_EN_ESPACE_PRIVE`, or nothing: `[]`, `null`).
   */
  actions: {
    liste(): Promise<ActionShown[]>;
    /** An action, a component or a latest result changed: re-read. */
    surChange(callback: () => void): () => void;
    /**
     * Choosing a suggestion: the action's page opens (or the one showing the running execution) and the action is
     * started, unless it is already running or its required input is missing.
     */
    ouvrir(id: string, input: string | null): Promise<{ ok: true } | { ok: false; erreur: string }>;
    /** « Relancer » from the page: returns the outcome of the execution, when it ends. */
    lancer(id: string, input: string | null): Promise<LaunchResult>;
    arreter(id: string): void;
    /** This result (null: the latest), without rerunning anything; null if there is none. */
    page(id: string, execution: string | null): Promise<PageAction | null>;
    executions(id: string): Promise<ResumeExecution[]>;
    /** A complete execution (blocks, outputs, logs), for the builder; null if it no longer exists. */
    execution(id: string, execution: string): Promise<Execution | null>;
    direct(): Promise<ActionsState>;
    surDirect(callback: (e: ActionsState) => void): () => void;
    /** A link from the page: opened in a tab only if the address appears as is in the results. */
    ouvrirLien(id: string, execution: string, url: string): void;
    /** Login profiles a grant can use (never a private space's). */
    profilsPourAccord(): Promise<ProfileForGrant[]>;
    /** As for a widget; nothing is started (the user reruns from the page). */
    accorder(a: Grant): Promise<{ ok: true } | { ok: false; erreur: string }>;
    /** Removes the grant and erases executions, results and memory. */
    refuserAccord(id: string): Promise<void>;
    /** Puts the action in the trash (`actions/.corbeille`) and forgets its grant and its data. */
    supprimer(id: string): Promise<{ ok: true } | { ok: false; erreur: string }>;
    /** Opens the builder on the action's workflow. */
    voirWorkflow(id: string): void;
  };
  /** Applications page (projects of the agent's space). */
  applications: {
    liste(): Promise<ApplicationList>;
    /** A project or an app's state changed: re-read. */
    surChange(callback: () => void): () => void;
    agir(folder: string, action: ActionApplication): void;
  };
  /** « Sites » section of the Applications page: the site apps of the agent's space. */
  sites: {
    liste(): Promise<ShownSite[]>;
    /** A site app appeared, changed, opened or closed: re-read. */
    surChange(callback: () => void): () => void;
    agir(id: string, action: ActionSite): void;
  };
  extensions: {
    /**
     * Installs a Chrome Web Store extension (its page address or id) in this window's active space, after the
     * grant card. Unreadable input: « Adresse ou identifiant du Chrome Web Store attendu ».
     */
    installerStore(input: string): Promise<{ ok: true } | { ok: false; erreur: string }>;
    /** The installed or granted extensions, and the agent's folders never granted, seen from this space. */
    pourEspace(spaceId: SpaceId): Promise<SpaceExtensionLine[]>;
    /** Enables or disables an extension in this space's profile (the agent without a grant goes through the card). */
    basculer(key: string, spaceId: SpaceId, active: boolean): Promise<{ ok: true } | { ok: false; erreur: string }>;
    /** The extension registry changed (or their errors): re-read. */
    surChange(callback: () => void): () => void;
    /** All the registry's extensions (Extensions page). */
    liste(): Promise<ExtensionLine[]>;
    /** Is « Désactiver toutes les extensions » in force? */
    coupees(): Promise<boolean>;
    /** The extensions loaded in the profile of this window's active space. */
    barre(): Promise<ExtensionsBar>;
    epingler(key: string, yes: boolean): Promise<ExtensionResult>;
    /** Removed from all profiles (the grant stays). */
    desactiverPartout(key: string): Promise<ExtensionResult>;
    /** Store: uninstalled; agent: grant and copy erased (the agent's folder stays). */
    supprimer(key: string): Promise<ExtensionResult>;
    /** « Désactiver toutes les extensions »: nothing is loaded while it is true, even after a restart. */
    toutCouper(yes: boolean): Promise<ExtensionResult>;
    /** The card of the pending update (Store) or of the widened scope (agent), in this window. */
    revoir(key: string): Promise<ExtensionResult>;
    /** An extension disabled for its crashes starts again (where it was active). */
    reactiver(key: string): Promise<ExtensionResult>;
    /** « Couper le déblocage » of an agent extension's console. */
    couperDeblocage(key: string): Promise<ExtensionResult>;
  };
  /** Design mode of this window's active tab, and baskets of notes. */
  design: ApiDesign;
  externes: ExternalApi;
  relecture: ReviewApi;
}


export type ExtensionResult = { ok: true } | { ok: false; erreur: string };

/** An app as the page displays it: what the manager says, and what the browser kept of it. */
export type ApplicationShown = Application & { favicon?: string; dernierLancement?: string };
export interface ApplicationList {
  atelier: "ok" | "docker-absent";
  applications: ApplicationShown[];
}
/** A single path segment: no separator, no `.`/`..`, no NUL. */
const validSegment = (d: string) => d !== "" && d !== "." && d !== ".." && !/[/\\\0]/.test(d);
/** Possible actions on a « Sans fiche » project whose folder name cannot be launched (`My Project`, `_tmp`…). */
const WHOLE_FOLDER_ACTIONS = new Set(["deboguer", "supprimer", "dossier"]);

export const SchemaActionApplication = z
  .object({
    dossier: z.string(),
    action: z.enum(["lancer", "arreter", "relancer", "ouvrir", "deboguer", "supprimer", "promouvoir", "dossier", "relire"]),
  })
  .refine(({ dossier: folder, action }) => (WHOLE_FOLDER_ACTIONS.has(action) ? validSegment(folder) : validFolder(folder)));
export type ActionApplication = z.infer<typeof SchemaActionApplication>["action"];

/** An action on a site app: its id follows `ID_SITE` (never a path). */
export const SchemaActionSite = z.object({
  id: z.string().regex(ID_SITE),
  action: z.enum(["ouvrir", "modifier", "oublier", "dossier", "supprimer", "relire"]),
});

/** A card of the ⌃Tab panel: `apercu` is a JPEG data URL, null if the tab was never captured. */
export interface TabsPanelCard {
  id: TabId;
  titre: string;
  favicon: string | null;
  apercu: string | null;
}
/** ⌃Tab panel: at most 7 cards (sliding window), `selection` is an index into `cartes`. */
export interface TabsPanel {
  cartes: TabsPanelCard[];
  selection: number;
}
/** Messages from the ⌃Tab panel to the main process (Esc, click, hover, Tab on the UI's keyboard). */
export const WalkMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("valider") }),
  z.object({ type: z.literal("annuler") }),
  z.object({ type: z.literal("choisir"), id }),
  z.object({ type: z.literal("survoler"), id }),
  z.object({ type: z.literal("avancer"), delta: z.union([z.literal(1), z.literal(-1)]) }),
]);
export type TabCycleMessage = z.infer<typeof WalkMessageSchema>;

/** What a window's agent panel shows. */
export type AgentPanelState =
  | { etat: "preparation" }
  | { etat: "docker-absent" }
  | { etat: "erreur"; message: string }
  | { etat: "actif" }
  | { etat: "termine"; code: number };

const idWidget = z.string().regex(/^[a-z0-9-]+$/).max(100);
/** Id of an action (name of its folder under `~/WebAiOs/actions`). */
export const SchemaIdAction = z.string().regex(/^[a-z0-9-]{1,60}$/);
/** Input of an action coming from the UI: bounded here, cut by the kernel. */
export const ActionInputSchema = z.string().max(2000).nullable();
/** What the builder opens: a widget's workflow or an action's. */
export const TargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("widget"), id: idWidget }).strict(),
  z.object({ type: z.literal("action"), id: SchemaIdAction }).strict(),
]);

/**
 * Id of a block coming from the UI: bounded in size only (never a path). The engine validates the shape and names
 * the block at fault: an id written by the agent that it refuses must reach it.
 */
export const WorkflowBlockSchema = z.string().min(1).max(200);
/** Name of a widget code file: a `.mjs` at the root of its folder. */
export const NameCodeSchema = z.string().regex(/^[a-z0-9-]+\.mjs$/).max(64);
/** Text of a `.mjs`: 256 KB at most (in bytes, as on write). */
export const SchemaCodeWorkflow = z.string().max(256 * 1024).refine((t) => new TextEncoder().encode(t).length <= 256 * 1024, "code trop gros");
/**
 * Builder draft: bounded but not necessarily valid for the engine (`enregistrerWorkflow` answers).
 * The parameters stay free: the engine validates them.
 */
export const DraftSchema = z.object({
  version: z.literal(1),
  blocs: z
    .array(
      z.object({
        id: WorkflowBlockSchema,
        type: z.string().min(1).max(200),
        nom: z.string().max(200).optional(),
        position: z.object({ x: z.number().finite(), y: z.number().finite() }),
        parametres: z.record(z.string(), z.unknown()),
      }),
    )
    .max(100),
  liens: z.array(z.object({ de: WorkflowBlockSchema, vers: WorkflowBlockSchema })).max(400),
});

/** The block selected in a window's builder, and the workflow (widget or action) where it is. */
export type BuilderSelection = { widget: string; bloc: string | null } | { action: string; bloc: string | null };
/**
 * The block selected in the builder: an invalid block becomes « none » (`workflow_ouvert` never shows
 * the old one); null, message ignored, if the target is invalid.
 */
export function builderSelection(v: unknown): BuilderSelection | null {
  const o = v as { cible?: unknown; bloc?: unknown } | null;
  const target = TargetSchema.safeParse(o?.cible);
  if (!target.success) return null;
  const r = WorkflowBlockSchema.safeParse(o?.bloc);
  const block = r.success ? r.data : null;
  return target.data.type === "widget" ? { widget: target.data.id, bloc: block } : { action: target.data.id, bloc: block };
}
export type Draft = z.infer<typeof DraftSchema>;

export type WorkflowEdit = DraftRead & {
  avertissements: Warning[];
  /** What `widget.json` declares, read-only; `recolte` null: the widget declares none. Absent for an action. */
  widget?: {
    nom: string;
    compte: string[];
    publiques: string[];
    config: unknown;
    web: boolean;
    recolte: { minutes: number | null; heures: string[]; dureeMaxMinutes: number | null; notifier: boolean } | null;
  };
  /** What `action.json` declares, read-only (never written by WebAiOs). Absent for a widget. */
  action?: {
    nom: string;
    compte: string[];
    publiques: string[];
    web: boolean;
    saisie: { libelle: string } | null;
    miseEnPage: string | null;
    dureeMaxMinutes: number | null;
  };
};
/** Id of an execution: its ISO start without « : » or « . » (never a path). */
export const SchemaIdExecution = z.string().regex(ID_EXECUTION).max(64);
const domain = z.string().min(1).max(253);
export const GrantSchema = z
  .object({ id: idWidget, profil: z.string().min(1).max(200), compte: z.array(domain).max(100), publiques: z.array(domain).max(100) })
  .strict();
export type Grant = z.infer<typeof GrantSchema>;
export const TerminalSizeSchema = z.object({ cols: z.number().int().min(2).max(1000), rows: z.number().int().min(2).max(1000) });
export type TerminalSize = z.infer<typeof TerminalSizeSchema>;

/** Place of a widget in the 12-column grid (rows of 90 px). */
export interface Placement {
  id: string;
  x: number;
  y: number;
  l: number;
  h: number;
}

/** A home page widget, as the UI displays it. */
export type ShownWidget =
  | {
      id: string;
      nom: string;
      placement: Placement;
      tailles: DeclarationWidget["tailles"];
      /** `webaios-widget://<id>/affichage.html?v=<mtime>`, or null until the agent has written the display. */
      src: string | null;
      donnees: unknown | null;
      exemple: unknown | null;
      etat: WidgetState;
      /** Domains read with the user's account (empty: public sources only). */
      compte: string[];
      /** Public domains the widget may contact; for a widget with an account, covered by the same grant. */
      publiques: string[];
      /** The widget has a harvest (`workflow.json` or `recolte.mjs`): its menu offers « Voir / modifier le workflow ». */
      aRecolte: boolean;
      /** Fixed times of the harvest (« HH:MM »), empty without them. */
      heures: string[];
      /** Harvest frequency in minutes, null without it. */
      minutes: number | null;
    }
  | { id: string; erreur: string; placement: Placement };

export interface ProfileForGrant {
  id: string;
  /** « Profil de « Perso, Travail » »: the spaces that use it. */
  libelle: string;
  /** The profile of the window's active space, if it can be used. */
  parDefaut: boolean;
}

/** State of the local AI for the indicator; `verification`: what is in place (absent if not checked). */
export interface LocalAiStateShown {
  etat: AiState;
  erreur?: string;
  verification?: { kev: boolean; uv: boolean; ollama: boolean; gemma: boolean };
}

/** What an app window's badge UI gets (ui/badge-api.ts): the agent's access and its app's design mode. */
export type BadgeApi = Pick<ApiWebaios, "acces" | "surAcces"> & {
  /** Asks the main process to enlarge (bubble open) or shrink the badge's view. */
  pastilleTaille(opened: boolean): void;
  /** The design mode of the app window; « Panier » opens it in the window's overlay. */
  design: { etat(): Promise<DesignState>; basculer(): void; panier(): void; relire(): void };
};

/**
 * The single API of a site app window's UI (`site.html`). The main process recognizes the app by
 * the sender, never by what the UI says.
 */
export interface ApiSite {
  etat(): Promise<SiteWindowState | null>;
  surEtat(callback: (e: SiteWindowState) => void): () => void;
  /** « Entrer dans le site »: the site view, loaded on the start address the first time only. */
  entrer(): void;
  /** ⌂: back to the home screen, the site page stays loaded underneath. */
  accueil(): void;
  precedent(): void;
  suivant(): void;
  recharger(): void;
  /** « Ouvrir dans un onglet »: the last blocked link, in a tab of the main window. */
  ouvrirBloque(): void;
  /** « Chercher la nouvelle adresse »: reads the reference page (at most once a minute); no effect if the app has none. */
  chercherAdresse(): void;
  /**
   * The tweaks grant card. yes: the grant is kept, then the next view (home or site) with tweaks;
   * no: the next view without tweaks or resume, for this opening only (the card comes back at the next one).
   * `empreinte`: that of the clicked card; if the rights changed since, nothing is granted and the card comes back up to date.
   */
  accorder(yes: boolean, hash: string): Promise<void>;
  /** For the home screen: the app's memory and its resume positions (read), and the current domain. */
  memoire(): Promise<MessageToHome & { type: "memoire" }>;
  /** Each change of the app's memory; returns the unsubscribe. */
  surMemoire(callback: (m: MessageToHome & { type: "memoire" }) => void): () => void;
  /**
   * The home asks for a site address (relative or on one of its domains): the site view goes there, on the
   * current domain. False if it is refused, or if another was just opened (one per `ECART_OUVERTURE_ACCUEIL_MS`).
   */
  ouvrir(url: string): Promise<boolean>;
  /** An image of an app domain, loaded with its session, as `data:`; null if it is refused. */
  image(url: string): Promise<string | null>;
  /** The bar's « Extensions » menu (plan 16): the Store extensions, enabled for this app only. */
  extensions: {
    /** The Store extensions, and their state in this app. */
    liste(): Promise<SiteExtensionLine[]>;
    /** The switch: the site view is reloaded after a success (the already loaded page only). */
    basculer(key: string, active: boolean): Promise<ExtensionResult>;
    /** Partition `persist:site-<id>`, tab = id of the view in « site » view (otherwise null), and the loaded extensions. */
    barre(): Promise<ExtensionsBar>;
    /** `CANAUX.extensionsChange`; returns the unsubscribe. */
    surChange(callback: () => void): () => void;
    /** The Extensions page, in a main window. */
    gerer(): void;
    /** Height of the open menu panel under the bar (0: closed), bounded by `PANNEAU_EXTENSIONS_MAX`. */
    panneau(height: number): void;
    /** The main process asks to close the menu (click in the site view, fullscreen); returns the unsubscribe. */
    surFermer(callback: () => void): () => void;
  };
  /**
   * The app's design mode (plan 18), ✎ button and chevron of the bar: the main process recognizes the app by
   * the sender. `surChange` only listens to `CANAUX.designChange` (the counter follows), without any action.
   */
  design: {
    etat(): Promise<DesignState>;
    basculer(): void;
    relire(): void;
    ouvrirPanier(): void;
    surChange(callback: () => void): () => void;
  };
}

/** The design mode of a target (a window's active tab, or an app window). */
export interface DesignState {
  actif: boolean;
  projet: TrackedProject | null;
  /** Reason why design mode is not offered here; null if it is. */
  indisponible: string | null;
  /** « l'agent », « Claude Code (<nom>) »; null if nobody can receive the notes. */
  destination: string | null;
  /** Why `destination` is null (no Claude Code connected). */
  sansDestination: string | null;
  /** Number of notes in the project's basket. */
  panier: number;
  /** Name of the project to display. */
  nom: string;
}
/** A note as the basket and the history display it: text, never HTML. */
export interface ShownElement {
  id: string;
  type: "design" | "relecture";
  etiquette: string;
  texte: string;
  source: string | null;
  traite: { quand: string; note?: string } | null;
}
export interface BatchShown {
  id: string;
  cree: string;
  etat: BatchState;
  destination: "agent" | "mcp";
  elements: ShownElement[];
}
export interface ApiDesign {
  etat(): Promise<DesignState>;
  /** ⌘⇧D: no effect where the mode is unavailable. */
  basculer(): void;
  panier(project: ProjectId): Promise<ShownElement[]>;
  retirer(project: ProjectId, id: string): Promise<void>;
  envoyer(project: ProjectId): Promise<ExtensionResult>;
  lots(project: ProjectId): Promise<BatchShown[]>;
  traite(project: ProjectId, batch: string): Promise<void>;
  /** « Relire ce projet » (`app` and `externe` projects). */
  relire(): void;
  surChange(callback: () => void): () => void;
}
/** What the overlay shows: a note's bubble (targeted element) or an app window's basket. */
export interface OverlayContext {
  /** « message »: why ⌘⇧D does nothing in the tab (empty project, never a basket). */
  mode: "bulle" | "panier" | "message";
  /** The text of the « message » mode; null elsewhere. */
  message: string | null;
  projet: ProjectId;
  etiquette: string;
  source: string | null;
  destination: string | null;
  sansDestination: string | null;
  /** Bubble of a site app: what will go to the agent (excerpt, capture); null elsewhere. */
  avertissement: string | null;
}
/** The single API of the design mode overlay (`design.html`); the main process recognizes its target by the sender. */
export type OverlayApi = {
  contexte(): Promise<OverlayContext | null>;
  ajouter(text: string): Promise<ExtensionResult>;
  /** Esc or « Annuler » in the bubble; « Fermer » of the basket. */
  annuler(): void;
} & Pick<ApiDesign, "panier" | "retirer" | "envoyer" | "lots" | "traite" | "surChange">;
/** Text of a note: bounded at the entry of the main process. */
export const REMARK_TEXT_MAX = 4000;

/** « Projets externes » section of the Applications page: the external MCP, its projects and its clients (never a token). */
export interface ExternalsState {
  serveur: { etat: "pret"; port: number } | { etat: "eteint"; raison: string };
  projets: (ExternalProject & { client: string | null; nomClient: string | null })[];
  clients: { id: string; nom: string; cree: string }[];
}
export interface ExternalApi {
  liste(): Promise<ExternalsState>;
  /** The command to copy into Claude Code's terminal: the token appears there only once. */
  brancher(name: string): Promise<{ commande: string }>;
  revoquer(id: string): Promise<void>;
  oublier(id: string): Promise<void>;
  /** « Relire »: the project's review page. */
  relire(id: string): void;
  surChange(callback: () => void): () => void;
}

/** Review page: what it shows of a project (the diff since the last review), or why it cannot. */
export type ReviewView =
  | {
      etat: "ok"; nom: string; jeton: string; comparaison: { fichiers: ModifiedFile[] }; commentaires: Comment[];
      /** Who the comments go to (« l'agent », « Claude Code (…) »); otherwise why they cannot be sent. */
      destination: string | null; sansDestination: string | null;
    }
  | { etat: "indisponible"; nom: string; raison: string };
export type { DiffFile as DiffFichier, ModifiedFile as FichierModifie, Comment as Commentaire };
export interface ReviewApi {
  /**
   * Compares the project to its last review and returns the token of that comparison (kept by the main process).
   * With the token of a comparison still kept: that one, without comparing again; « Rafraîchir » does not pass one.
   */
  ouvrir(project: ProjectId, token?: string): Promise<ReviewView>;
  /** The diff of one file of the token's comparison (never another path); a token no longer kept is refused. */
  fichier(project: ProjectId, token: string, path: string): Promise<DiffFile>;
  /** Lines `debut`..`fin` (from 1) of the current version of a file of the token's comparison. */
  lignes(project: ProjectId, token: string, path: string, start: number, end: number): Promise<string[]>;
  /** The project's comments, as saved. */
  commentaires(project: ProjectId): Promise<Comment[]>;
  /** A comment on lines of a single block of the token's diff; the lines are read by the main process. */
  commenter(project: ProjectId, token: string, c: { fichier: string; debut: number; fin: number; texte: string }): Promise<ExtensionResult>;
  modifierCommentaire(project: ProjectId, id: string, text: string): Promise<void>;
  resoudre(project: ProjectId, id: string, resolved: boolean): Promise<void>;
  supprimerCommentaire(project: ProjectId, id: string): Promise<void>;
  /** Unresolved comments go out as one batch (agent: pre-filled, never sent; external: MCP queue). */
  envoyer(project: ProjectId): Promise<ExtensionResult>;
  /** « Marquer comme relu »: keeps the tree shown by the token's comparison, then returns a new comparison. */
  relu(project: ProjectId, token: string): Promise<ReviewView>;
}
