import type { Avertissement, CatalogueBloc } from "@webaios/noyau";
import type { ApiWebaios, EditionWorkflow } from "../../commun/api";
import { MODELE_CODE, parametresNeufs } from "./ajout";
import { ajouterBloc, deplacer, Historique, memeBrouillon, suivreFichier, versBrouillon, type Brouillon } from "./brouillon";
import { disposer, positionsAffichees, sansDisposition } from "./disposition";

type Position = { x: number; y: number };
export type Validation = { ok: true } | { ok: false; erreur: string; bloc?: string };
export type EtatEnregistrement = "enregistre" | "en-cours" | { invalide: string; bloc?: string } | { erreur: string };
/** `illisible` : `workflow.json` n'est pas lisible à l'ouverture (JSON coupé…) ; `introuvable` : ni widget ni récolte. */
export type Chargement = "chargement" | "pret" | "introuvable" | { illisible: string };
export type Depot = Pick<ApiWebaios["workflow"], "lire" | "enregistrer" | "lireCode" | "enregistrerCode">;
export type Viewport = { x: number; y: number; zoom: number };

const PREFIXE_NON_ENREGISTRE = /^Non enregistré : /;
/** Un geste pendant que le bandeau propose la version de l'agent : rien ne part avant le choix de l'utilisateur. */
export const EN_ATTENTE_DU_CHOIX = "l'agent a modifié le workflow, choisis une version";
const memeJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * L'état d'édition du workflow d'un widget dans cette fenêtre : brouillon, historique, validation, enregistrement.
 * Seul un geste de l'utilisateur passe par `modifier` (et donc enregistre) : ouvrir, relire, réorganiser ou sélectionner
 * n'écrivent jamais.
 */
export class Edition {
  brouillon = $state.raw<Brouillon | null>(null);
  validation = $state.raw<Validation>({ ok: true });
  avertissements = $state.raw<Avertissement[]>([]);
  etatEnregistrement = $state.raw<EtatEnregistrement>("enregistre");
  /** La dernière version vue sur le disque (ou confirmée par un enregistrement). */
  dernierConnu = $state.raw<Brouillon | null>(null);
  bandeau = $state<null | "proposer" | "illisible">(null);
  /** Positions affichées : celles du brouillon, ou la disposition automatique d'un workflow qui n'en a pas. */
  positions = $state.raw<Record<string, Position>>({});
  chargement = $state.raw<Chargement>("chargement");
  widget = $state.raw<EditionWorkflow["widget"] | null>(null);
  origine = $state<"fichier" | "implicite">("fichier");
  /** Le workflow sur le disque est valide : « Lancer » a un sens. */
  disqueValide = $state(false);
  /** Vue du canevas, gardée quand l'onglet change (pas de recadrage au retour). */
  viewport: Viewport | null = null;

  private historique: Historique | null = null;
  /** Version du disque que le bandeau propose. */
  private versionDisque: { brouillon: Brouillon; lecture: EditionWorkflow } | null = null;
  /** Brouillons partis à l'enregistrement, pas encore confirmés : leur écho sur le disque est ignoré. */
  private envoyes: Brouillon[] = [];
  private prochain: Brouillon | null = null;
  /** Brouillon retenu pendant le bandeau « proposer » : envoyé par « Garder la mienne », abandonné sinon. */
  private retenu: Brouillon | null = null;
  private enregistrementEnCours = false;
  private lecture = 0;

  constructor(
    readonly id: string,
    private readonly depot: Depot,
  ) {}

  /** Première lecture ; ensuite, `relire`. */
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
    this.widget = l.widget;
    this.origine = l.origine;
    const disque = l.brut === null ? null : versBrouillon(l.brut);
    if (!disque) {
      this.chargement = { illisible: l.validation.ok ? "workflow.json illisible" : l.validation.erreur };
      this.disqueValide = false;
      return;
    }
    this.historique = new Historique(disque);
    this.dernierConnu = disque;
    this.positions = positionsAffichees(disque, null);
    this.adopterLecture(disque, l);
    this.chargement = "pret";
  }

  /** Affiche `disque` tel que lu (validation et avertissements du disque) ; n'écrit rien. */
  private adopterLecture(disque: Brouillon, l: EditionWorkflow): void {
    this.brouillon = disque;
    this.positions = positionsAffichees(disque, this.positions);
    this.dernierConnu = disque;
    this.validation = l.validation;
    this.avertissements = l.avertissements;
    this.etatEnregistrement = l.validation.ok ? "enregistre" : invalide(l.validation.erreur, l.validation.bloc);
    this.disqueValide = l.validation.ok;
    this.bandeau = null;
    this.versionDisque = null;
  }

  /** `workflow.json` a peut-être changé (l'agent l'écrit, ou c'est l'écho d'un enregistrement) : n'écrit rien. */
  async relire(): Promise<void> {
    const n = ++this.lecture;
    const l = await this.depot.lire(this.id);
    if (n !== this.lecture) return;
    // L'agent réécrit peut-être widget.json : le canevas reste tel quel.
    if (!l) return;
    this.widget = l.widget;
    if (this.chargement !== "pret" || !this.brouillon || !this.historique) {
      this.chargement = "chargement";
      this.charger(l);
      return;
    }
    const disque = l.brut === null ? null : versBrouillon(l.brut);
    const decision = suivreFichier({ local: this.brouillon, dernierConnu: this.dernierConnu, disque, envoyes: this.envoyes });
    if (decision === "illisible") {
      this.bandeau = "illisible";
      this.disqueValide = false;
      return;
    }
    if (decision === "adopter") {
      this.origine = l.origine;
      this.historique.faire(disque!);
      this.adopterLecture(disque!, l);
      return;
    }
    if (decision === "proposer") {
      this.versionDisque = { brouillon: disque!, lecture: l };
      this.bandeau = "proposer";
      return;
    }
    // Ignorer : le disque est le brouillon, sa dernière version connue ou un écho.
    this.origine = l.origine;
    if (memeBrouillon(disque!, this.brouillon)) {
      this.dernierConnu = disque;
      this.disqueValide = l.validation.ok;
      this.bandeau = null;
      this.versionDisque = null;
      if (this.retenu) {
        // Le disque a rejoint le brouillon retenu : plus rien à choisir ni à envoyer.
        this.retenu = null;
        this.etatEnregistrement = l.validation.ok ? "enregistre" : invalide(l.validation.erreur, l.validation.bloc);
      }
      if (this.etatEnregistrement !== "en-cours") {
        if (!memeJson(this.validation, l.validation)) this.validation = l.validation;
        if (!memeJson(this.avertissements, l.avertissements)) this.avertissements = l.avertissements;
      }
    } else if (this.bandeau === "illisible") {
      this.bandeau = null;
      this.disqueValide = l.validation.ok;
    }
  }

  /** Bandeau : abandonner le brouillon pour la version du disque. */
  prendreVersionDisque(): void {
    const v = this.versionDisque;
    if (!v || !this.historique) return;
    this.retenu = null;
    this.historique.faire(v.brouillon);
    this.origine = v.lecture.origine;
    this.adopterLecture(v.brouillon, v.lecture);
  }

  /**
   * Bandeau : garder le brouillon. Il part à l'enregistrement (retenu par un geste, ou valide) et remplace alors la
   * version du disque ; invalide, il est refusé et rien n'est écrit.
   */
  garderLaMienne(): void {
    if (this.versionDisque) this.dernierConnu = this.versionDisque.brouillon;
    const envoyer = this.retenu !== null || this.validation.ok;
    this.versionDisque = null;
    this.bandeau = null;
    this.retenu = null;
    if (this.brouillon && envoyer) this.enregistrer(this.brouillon);
  }

  /**
   * Un geste de l'utilisateur : appliqué au brouillon, retenu dans l'historique, enregistré. Les positions affichées sont
   * figées avec lui (un workflow sans disposition garde celle qu'on voit, sans saut ensuite).
   */
  modifier(f: (b: Brouillon) => Brouillon): void {
    this.changer(f, false);
  }

  /** Fin d'un glisser : `positions` sont celles de tous les blocs affichés ; rien n'est écrit si aucune n'a bougé. */
  deplacer(positions: Record<string, Position>): void {
    const bouge = Object.entries(positions).some(([id, p]) => {
      const q = this.positions[id];
      return !q || q.x !== p.x || q.y !== p.y;
    });
    if (!bouge) return;
    this.positions = { ...this.positions, ...positions };
    this.changer((b) => b, true);
  }

  /** `figer` : les positions affichées seules suffisent à enregistrer (un glisser) ; sinon il faut que `f` change le brouillon. */
  private changer(f: (b: Brouillon) => Brouillon, figer: boolean): void {
    const avant = this.brouillon;
    if (!avant || !this.historique) return;
    const base = deplacer(avant, this.positions);
    const apres = f(base);
    if (!figer && (apres === base || memeBrouillon(apres, base))) return;
    if (apres === avant || memeBrouillon(apres, avant)) return;
    this.historique.faire(apres);
    this.appliquer(apres);
  }

  /** Ajoute un bloc du catalogue ; un bloc `code` reçoit son fichier (modèle qui rend son entrée) avant d'exister. */
  async ajouter(c: CatalogueBloc, position: Position): Promise<string> {
    if (!this.brouillon) return "";
    const parametres = parametresNeufs(c);
    if (c.type === "code") {
      const source = await this.fichierLibre(c.type);
      // Jamais le fichier d'un autre : sans nom libre (ou sans pouvoir écrire le modèle), le bloc n'est pas ajouté.
      if (!source) {
        this.etatEnregistrement = { erreur: "aucun nom de fichier libre pour le bloc Code" };
        return "";
      }
      const r = await this.depot.enregistrerCode(this.id, source, MODELE_CODE);
      if (!r.ok) {
        this.etatEnregistrement = { erreur: r.erreur };
        return "";
      }
      parametres.source = source;
    }
    let id = "";
    this.modifier((b) => {
      const r = ajouterBloc(b, c.type, position, parametres);
      id = r.id;
      return r.brouillon;
    });
    return id;
  }

  /** `<id>.mjs` du futur bloc, ou le suivant libre : jamais un fichier existant ni un fichier d'un autre bloc. */
  private async fichierLibre(type: string): Promise<string | null> {
    const b = this.brouillon!;
    const { id } = ajouterBloc(b, type, { x: 0, y: 0 }, {});
    const pris = new Set(b.blocs.map((x) => x.parametres.source).filter((s): s is string => typeof s === "string"));
    for (let n = 1; n <= 50; n++) {
      const nom = `${id}${n === 1 ? "" : `-${n}`}.mjs`;
      if (pris.has(nom)) continue;
      const lu = await this.depot.lireCode(this.id, nom);
      if ("absent" in lu) return nom;
      if ("erreur" in lu) return null;
    }
    return null;
  }

  annuler(): void {
    const b = this.historique?.annuler();
    if (b) this.appliquer(b, true);
  }

  retablir(): void {
    const b = this.historique?.retablir();
    if (b) this.appliquer(b, true);
  }

  /** Refait la disposition automatique : positions affichées seulement, rien n'est enregistré. */
  reorganiser(): void {
    if (this.brouillon) this.positions = disposer(this.brouillon);
  }

  /**
   * `historique` : retour à un état passé ; sans disposition, il reprend la disposition automatique (pas les positions
   * affichées, qui garderaient le déplacement annulé).
   */
  private appliquer(b: Brouillon, historique = false): void {
    this.brouillon = b;
    this.positions = positionsAffichees(b, historique && sansDisposition(b) ? null : this.positions);
    if (this.bandeau === "proposer") {
      this.retenir(b);
      return;
    }
    this.bandeau = null;
    this.versionDisque = null;
    this.enregistrer(b);
  }

  private retenir(b: Brouillon): void {
    this.retenu = b;
    this.etatEnregistrement = { invalide: EN_ATTENTE_DU_CHOIX };
  }

  /** Les enregistrements partent un par un ; un brouillon dépassé avant son départ n'est pas envoyé. */
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
          // Le bandeau est apparu entre-temps : ce brouillon attend le choix de l'utilisateur.
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
        if (!("ok" in r)) {
          this.etatEnregistrement = { erreur: r.erreur };
        } else if (r.ok) {
          this.validation = { ok: true };
          this.avertissements = r.avertissements;
          this.etatEnregistrement = "enregistre";
        } else {
          this.validation = { ok: false, erreur: r.erreur, ...(r.bloc === undefined ? {} : { bloc: r.bloc }) };
          this.avertissements = r.avertissements;
          this.etatEnregistrement = invalide(r.erreur, r.bloc);
        }
      }
    } finally {
      this.enregistrementEnCours = false;
    }
  }
}

function invalide(erreur: string, bloc?: string): EtatEnregistrement {
  const texte = erreur.replace(PREFIXE_NON_ENREGISTRE, "");
  return bloc === undefined ? { invalide: texte } : { invalide: texte, bloc };
}

/** Une édition par widget et par fenêtre : changer d'onglet ne perd ni un brouillon invalide ni l'historique. */
const editions = new Map<string, Edition>();

/** Oublie l'édition des widgets qui ne sont plus sur l'accueil : un id réutilisé ne reprend jamais l'ancien historique. */
export function oublierEditions(presents: Iterable<string>): void {
  const ids = new Set(presents);
  for (const id of [...editions.keys()]) if (!ids.has(id)) editions.delete(id);
}

let suivi = false;
/** Une fois par fenêtre : à chaque changement de l'accueil, les éditions des widgets partis sont oubliées. */
export function suivreDisparitions(accueil: Pick<ApiWebaios["accueil"], "lire" | "surChange">): void {
  if (suivi) return;
  suivi = true;
  accueil.surChange(() => {
    void accueil
      .lire()
      // Une liste vide est plutôt un accueil illisible un instant : rien n'est oublié sur elle.
      .then((ws) => ws.length > 0 && oublierEditions(ws.map((w) => w.id)))
      .catch(() => {});
  });
}

export function creerEdition(id: string, depot: Depot): Edition {
  let e = editions.get(id);
  if (!e) {
    e = new Edition(id, depot);
    editions.set(id, e);
  }
  return e;
}
