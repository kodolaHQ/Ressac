import type { Warning, CatalogueBloc } from "@webaios/kernel";
import type { ApiWebaios, EditionWorkflow } from "../../shared/api";
import { CODE_MODEL, freshParams } from "./add";
import { addBlock, move, History, sameDraft, followFile, toDraft, type Brouillon } from "./draft";
import { disposer, shownPositions, sansDisposition } from "./layout";
import { isActionKey } from "./target";
import { forgetRunChoices } from "./executions.svelte";

type Position = { x: number; y: number };
export type Validation = { ok: true } | { ok: false; erreur: string; bloc?: string };
export type SaveState = "enregistre" | "en-cours" | { invalide: string; bloc?: string } | { erreur: string };
/** `illisible`: `workflow.json` is not readable at opening (truncated JSON…); `introuvable`: neither widget nor harvest. */
export type Load = "chargement" | "pret" | "introuvable" | { illisible: string };
/** Reading and writing the workflow, addressed by the workflow's key (`cleCible`). */
export type Depot = {
  lire(key: string): ReturnType<ApiWebaios["workflow"]["lire"]>;
  enregistrer(key: string, draft: Brouillon): ReturnType<ApiWebaios["workflow"]["enregistrer"]>;
  lireCode(key: string, name: string): ReturnType<ApiWebaios["workflow"]["lireCode"]>;
  enregistrerCode(key: string, name: string, text: string): ReturnType<ApiWebaios["workflow"]["enregistrerCode"]>;
};
export type Viewport = { x: number; y: number; zoom: number };

const UNSAVED_PREFIX = /^Non enregistré : /;
/** A gesture while the banner offers the agent's version: nothing goes out before the user's choice. */
export const AWAITING_CHOICE = "l'agent a modifié le workflow, choisis une version";
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The editing state of a widget's workflow in this window: draft, history, validation, saving. Only a gesture from
 * the user goes through `modifier` (and so saves): opening, re-reading, rearranging or selecting never write.
 */
export class Edition {
  brouillon = $state.raw<Brouillon | null>(null);
  validation = $state.raw<Validation>({ ok: true });
  avertissements = $state.raw<Warning[]>([]);
  etatEnregistrement = $state.raw<SaveState>("enregistre");
  /** The latest version seen on disk (or confirmed by a save). */
  dernierConnu = $state.raw<Brouillon | null>(null);
  bandeau = $state<null | "proposer" | "illisible">(null);
  /** Displayed positions: the draft's, or the automatic layout of a workflow that has none. */
  positions = $state.raw<Record<string, Position>>({});
  chargement = $state.raw<Load>("chargement");
  widget = $state.raw<NonNullable<EditionWorkflow["widget"]> | null>(null);
  /** What the action whose workflow this is declares; null for a widget. */
  action = $state.raw<NonNullable<EditionWorkflow["action"]> | null>(null);
  origine = $state<"fichier" | "implicite">("fichier");
  /** The workflow on disk is valid: « Lancer » makes sense. */
  disqueValide = $state(false);
  /** Canvas view, kept when the tab changes (no reframing on return). */
  viewport: Viewport | null = null;

  private historique: History | null = null;
  /** Disk version the banner offers. */
  private versionDisque: { brouillon: Brouillon; lecture: EditionWorkflow } | null = null;
  /** Drafts sent for saving, not yet confirmed: their echo on disk is ignored. */
  private envoyes: Brouillon[] = [];
  private prochain: Brouillon | null = null;
  /** Draft held during the « proposer » banner: sent by « Garder la mienne », dropped otherwise. */
  private retenu: Brouillon | null = null;
  private enregistrementEnCours = false;
  private lecture = 0;

  constructor(
    readonly id: string,
    private readonly depot: Depot,
  ) {}

  /** First read; afterwards, `relire`. */
  async ouvrir(): Promise<void> {
    if (this.chargement !== "chargement") return this.relire();
    const n = ++this.lecture;
    const l = await this.depot.lire(this.id);
    if (n !== this.lecture) return;
    if (!l) {
      this.chargement = "introuvable";
      return;
    }
    this.charger(l);
  }

  private charger(l: EditionWorkflow): void {
    this.widget = l.widget ?? null;
    this.action = l.action ?? null;
    this.origine = l.origine;
    const disk = l.brut === null ? null : toDraft(l.brut);
    if (!disk) {
      this.chargement = { illisible: l.validation.ok ? "workflow.json illisible" : l.validation.erreur };
      this.disqueValide = false;
      return;
    }
    this.historique = new History(disk);
    this.dernierConnu = disk;
    this.positions = shownPositions(disk, null);
    this.adopterLecture(disk, l);
    this.chargement = "pret";
  }

  /** Shows `disque` as read (validation and warnings of the disk); writes nothing. */
  private adopterLecture(disk: Brouillon, l: EditionWorkflow): void {
    this.brouillon = disk;
    this.positions = shownPositions(disk, this.positions);
    this.dernierConnu = disk;
    this.validation = l.validation;
    this.avertissements = l.avertissements;
    this.etatEnregistrement = l.validation.ok ? "enregistre" : invalid(l.validation.erreur, l.validation.bloc);
    this.disqueValide = l.validation.ok;
    this.bandeau = null;
    this.versionDisque = null;
  }

  /** `workflow.json` may have changed (the agent writes it, or it is the echo of a save): writes nothing. */
  async relire(): Promise<void> {
    const n = ++this.lecture;
    const l = await this.depot.lire(this.id);
    if (n !== this.lecture) return;
    // The agent may be rewriting widget.json (or action.json): the canvas stays as is.
    if (!l) return;
    this.widget = l.widget ?? null;
    this.action = l.action ?? null;
    if (this.chargement !== "pret" || !this.brouillon || !this.historique) {
      this.chargement = "chargement";
      this.charger(l);
      return;
    }
    const disk = l.brut === null ? null : toDraft(l.brut);
    const decision = followFile({ local: this.brouillon, dernierConnu: this.dernierConnu, disque: disk, envoyes: this.envoyes });
    if (decision === "illisible") {
      this.bandeau = "illisible";
      this.disqueValide = false;
      return;
    }
    if (decision === "adopter") {
      this.origine = l.origine;
      this.historique.faire(disk!);
      this.adopterLecture(disk!, l);
      return;
    }
    if (decision === "proposer") {
      this.versionDisque = { brouillon: disk!, lecture: l };
      this.bandeau = "proposer";
      return;
    }
    // Ignore: the disk is the draft, its last known version or an echo.
    this.origine = l.origine;
    if (sameDraft(disk!, this.brouillon)) {
      this.dernierConnu = disk;
      this.disqueValide = l.validation.ok;
      this.bandeau = null;
      this.versionDisque = null;
      if (this.retenu) {
        // The disk caught up with the held draft: nothing left to choose or send.
        this.retenu = null;
        this.etatEnregistrement = l.validation.ok ? "enregistre" : invalid(l.validation.erreur, l.validation.bloc);
      }
      if (this.etatEnregistrement !== "en-cours") {
        if (!sameJson(this.validation, l.validation)) this.validation = l.validation;
        if (!sameJson(this.avertissements, l.avertissements)) this.avertissements = l.avertissements;
      }
    } else if (this.bandeau === "illisible") {
      this.bandeau = null;
      this.disqueValide = l.validation.ok;
    }
  }

  /** Banner: drop the draft for the disk version. */
  prendreVersionDisque(): void {
    const v = this.versionDisque;
    if (!v || !this.historique) return;
    this.retenu = null;
    this.prochain = null;
    this.historique.faire(v.brouillon);
    this.origine = v.lecture.origine;
    this.adopterLecture(v.brouillon, v.lecture);
  }

  /**
   * Banner: keep the draft. It goes to saving (held by a gesture, or valid) and then replaces the disk version;
   * invalid, it is refused and nothing is written.
   */
  garderLaMienne(): void {
    if (this.versionDisque) this.dernierConnu = this.versionDisque.brouillon;
    const send = this.retenu !== null || this.validation.ok;
    this.versionDisque = null;
    this.bandeau = null;
    this.retenu = null;
    if (this.brouillon && send) this.enregistrer(this.brouillon);
  }

  /**
   * A gesture from the user: applied to the draft, kept in the history, saved. The displayed positions are frozen with
   * it (a workflow without a layout keeps the one we see, with no jump afterwards). `fusion`: successive gestures with
   * the same key (keystrokes of the same field) make only one history entry.
   */
  modifier(f: (b: Brouillon) => Brouillon, fusion?: string): void {
    this.changer(f, false, fusion);
  }

  /** End of a drag: `positions` are those of all displayed blocks; nothing is written if none moved. */
  deplacer(positions: Record<string, Position>): void {
    const bouge = Object.entries(positions).some(([id, p]) => {
      const q = this.positions[id];
      return !q || q.x !== p.x || q.y !== p.y;
    });
    if (!bouge) return;
    this.positions = { ...this.positions, ...positions };
    this.changer((b) => b, true);
  }

  /** `figer`: the displayed positions alone are enough to save (a drag); otherwise `f` must change the draft. */
  private changer(f: (b: Brouillon) => Brouillon, freeze: boolean, fusion?: string): void {
    const before = this.brouillon;
    if (!before || !this.historique) return;
    const base = move(before, this.positions);
    const after = f(base);
    if (!freeze && (after === base || sameDraft(after, base))) return;
    if (after === before || sameDraft(after, before)) return;
    this.historique.faire(after, fusion);
    this.appliquer(after);
  }

  /** Adds a catalog block; a `code` block gets its file (template that returns its input) before existing. */
  async ajouter(c: CatalogueBloc, position: Position): Promise<string> {
    if (!this.brouillon) return "";
    const params = freshParams(c);
    if (c.type === "code") {
      const source = await this.fichierLibre(c.type);
      // Never another block's file: without a free name (or without being able to write the template), the block is not added.
      if (!source) {
        this.etatEnregistrement = { erreur: "aucun nom de fichier libre pour le bloc Code" };
        return "";
      }
      const r = await this.depot.enregistrerCode(this.id, source, CODE_MODEL);
      if (!r.ok) {
        this.etatEnregistrement = { erreur: r.erreur };
        return "";
      }
      params.source = source;
    }
    let id = "";
    this.modifier((b) => {
      const r = addBlock(b, c.type, position, params);
      id = r.id;
      return r.brouillon;
    });
    return id;
  }

  /** `<id>.mjs` of the future block, or the next free one: never an existing file nor another block's file. */
  private async fichierLibre(type: string): Promise<string | null> {
    const b = this.brouillon!;
    const { id } = addBlock(b, type, { x: 0, y: 0 }, {});
    const taken = new Set(b.blocs.map((x) => x.parametres.source).filter((s): s is string => typeof s === "string"));
    for (let n = 1; n <= 50; n++) {
      const name = `${id}${n === 1 ? "" : `-${n}`}.mjs`;
      if (taken.has(name)) continue;
      const lu = await this.depot.lireCode(this.id, name);
      if ("absent" in lu) return name;
      if ("erreur" in lu) return null;
    }
    return null;
  }

  /**
   * The file `source` was just saved: if the draft was refused for lack of this file (a `code` block reading it is
   * the cause), it goes to saving again. Otherwise nothing (no disk echo would do it).
   */
  codeEnregistre(source: string): void {
    const v = this.validation;
    if (v.ok || v.bloc === undefined || !this.brouillon || this.bandeau === "proposer" || this.etatEnregistrement === "en-cours") return;
    const b = this.brouillon.blocs.find((x) => x.id === v.bloc);
    if (b?.type === "code" && b.parametres.source === source) this.enregistrer(this.brouillon);
  }

  annuler(): void {
    const b = this.historique?.annuler();
    if (b) this.appliquer(b, true);
  }

  retablir(): void {
    const b = this.historique?.retablir();
    if (b) this.appliquer(b, true);
  }

  /** Redoes the automatic layout: displayed positions only, nothing is saved. */
  reorganiser(): void {
    if (this.brouillon) this.positions = disposer(this.brouillon);
  }

  /**
   * `historique`: return to a past state; without a layout, it takes the automatic layout again (not the displayed
   * positions, which would keep the undone move).
   */
  private appliquer(b: Brouillon, hist = false): void {
    this.brouillon = b;
    this.positions = shownPositions(b, hist && sansDisposition(b) ? null : this.positions);
    if (this.bandeau === "proposer") {
      this.retenir(b);
      return;
    }
    this.bandeau = null;
    this.versionDisque = null;
    this.enregistrer(b);
  }

  /** The banner offers the agent's version (re-read after each wait: it may have appeared meanwhile). */
  private choixAttendu(): boolean {
    return this.bandeau === "proposer";
  }

  private retenir(b: Brouillon): void {
    this.retenu = b;
    this.etatEnregistrement = { invalide: AWAITING_CHOICE };
  }

  /** Saves go out one by one; a draft outdated before its turn is not sent. */
  private enregistrer(b: Brouillon): void {
    this.prochain = b;
    this.etatEnregistrement = "en-cours";
    if (!this.enregistrementEnCours) void this.vider();
  }

  private async vider(): Promise<void> {
    this.enregistrementEnCours = true;
    try {
      while (this.prochain) {
        if (this.bandeau === "proposer") {
          // The banner appeared meanwhile: this draft awaits the user's choice.
          this.retenir(this.prochain);
          this.prochain = null;
          break;
        }
        const b = this.prochain;
        this.prochain = null;
        this.envoyes.push(b);
        let r: Awaited<ReturnType<Depot["enregistrer"]>> | { erreur: string };
        try {
          r = await this.depot.enregistrer(this.id, b);
        } catch (e) {
          r = { erreur: (e as Error).message || "Enregistrement impossible" };
        }
        this.envoyes = this.envoyes.filter((x) => x !== b);
        if ("ok" in r && r.ok) {
          this.dernierConnu = b;
          this.disqueValide = true;
        }
        if (this.prochain) continue;
        if (this.choixAttendu()) {
          // The banner appeared in flight: the header keeps waiting for the user's choice.
          this.etatEnregistrement = { invalide: AWAITING_CHOICE };
        } else if (!("ok" in r)) {
          this.etatEnregistrement = { erreur: r.erreur };
        } else if (r.ok) {
          this.validation = { ok: true };
          this.avertissements = r.avertissements;
          this.etatEnregistrement = "enregistre";
        } else {
          this.validation = { ok: false, erreur: r.erreur, ...(r.bloc === undefined ? {} : { bloc: r.bloc }) };
          this.avertissements = r.avertissements;
          this.etatEnregistrement = invalid(r.erreur, r.bloc);
        }
      }
    } finally {
      this.enregistrementEnCours = false;
    }
  }
}

function invalid(error: string, bloc?: string): SaveState {
  const text = error.replace(UNSAVED_PREFIX, "");
  return bloc === undefined ? { invalide: text } : { invalide: text, bloc };
}

/** One edit per widget and per window: changing tab loses neither an invalid draft nor the history. */
const editions = new Map<string, Edition>();

/**
 * Forgets the edits of widgets no longer on home: a reused id never picks up the old history. Actions' edits (key
 * `action:<id>`) do not depend on home: they stay.
 */
export function forgetEdits(presents: Iterable<string>): void {
  const ids = new Set(presents);
  for (const id of [...editions.keys()]) if (!ids.has(id) && !isActionKey(id)) editions.delete(id);
  forgetRunChoices(ids);
}

let tracking = false;
/** Once per window: on each change of home, the edits of departed widgets are forgotten. */
export function followDisappearances(home: Pick<ApiWebaios["accueil"], "lire" | "surChange">): void {
  if (tracking) return;
  tracking = true;
  home.surChange(() => {
    void home
      .lire()
      // An empty list is more likely a home unreadable for a moment: nothing is forgotten on it.
      .then((ws) => ws.length > 0 && forgetEdits(ws.map((w) => w.id)))
      .catch(() => {});
  });
}

export function createEdit(id: string, depot: Depot): Edition {
  let e = editions.get(id);
  if (!e) {
    e = new Edition(id, depot);
    editions.set(id, e);
  }
  return e;
}
