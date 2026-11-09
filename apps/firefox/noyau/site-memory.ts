import type { SiteMemory } from "../../../packages/noyau/src/index.ts";
import type { ReponseMemoire } from "../core/sites/injection.ts";

// The host's side of the site apps' injection channels (core/sites/injection.ts): the chrome checks the sender
// (the app view's main document), the grant and the relative address, the host does the memory work.

/** The refusal of a memory request from anywhere but the app's main page. */
export const REFUS_MEMOIRE = "Mémoire de l'appli : seulement depuis la page principale de l'appli";

type DemandeMemoire = { op: "retenir"; cle: string; valeur: unknown } | { op: "lire" | "oublier"; cle: string };

/** The request's shape, or null. */
function demandeMemoire(d: unknown): DemandeMemoire | null {
  if (!d || typeof d !== "object") return null;
  const { op, cle } = d as { op?: unknown; cle?: unknown };
  if (typeof cle !== "string") return null;
  if (op === "retenir") return { op, cle, valeur: (d as { valeur?: unknown }).valeur };
  return op === "lire" || op === "oublier" ? { op, cle } : null;
}

/**
 * `sites.memoireOp {id, adresse, op, cle, valeur?}`: the memory work past the sender checks. `memoire(id)`
 * rejects while the app is being deleted: nothing is read or written then.
 */
export async function memoireOp(memoire: (id: string) => Promise<SiteMemory>, brute: unknown): Promise<ReponseMemoire> {
  const p = brute && typeof brute === "object" ? (brute as { id?: unknown; adresse?: unknown }) : {};
  const d = demandeMemoire(brute);
  if (typeof p.id !== "string" || typeof p.adresse !== "string" || !d) return { ok: false, erreur: REFUS_MEMOIRE };
  const m = await memoire(p.id).catch(() => null);
  if (!m) return { ok: false, erreur: REFUS_MEMOIRE };
  if (d.op === "retenir") {
    const r = m.retenir(d.cle, d.valeur, p.adresse);
    return r.ok ? { ok: true } : r;
  }
  if (d.op === "lire") return { ok: true, valeur: m.lire(d.cle) };
  m.oublier(d.cle);
  return { ok: true };
}

/** Same video within 2 s of duration; a frame's position noted at most once a second. */
export const ECART_DUREE_REPRISE_S = 2;
export const ECART_NOTE_CADRE_MS = 1000;
/** A frame key is "<browsingContext.id>:<innerWindowId>", from the chrome; anything longer is not one. */
const CADRE_MAX = 64;

const fini = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
/** Same video: durations within `ECART_DUREE_REPRISE_S`. */
const memeDuree = (a: number, b: number) => Math.abs(a - b) <= ECART_DUREE_REPRISE_S;

type Cible = { id: string; adresse: string };
const cibleDe = (p: { id?: unknown; adresse?: unknown }): Cible | null => (typeof p.id === "string" && typeof p.adresse === "string" ? { id: p.id, adresse: p.adresse } : null);

/**
 * The position and reprise channels past their sender checks, which the chrome made (view,
 * grant, repriseDansCadre) and whose page address it gives. The host checks the grant again at each write.
 */
export function creerPositions(o: {
  memoire(id: string): Promise<SiteMemory>;
  accorde(id: string): boolean;
  /** Clock and timer (tests). */
  maintenant?: () => number;
  differer?: (f: () => void, ms: number) => void;
}) {
  /** Per app: « Oublier » and « Supprimer » change it, and any note received before (delayed write included) is dropped. */
  const generations = new Map<string, number>();
  const generation = (id: string) => generations.get(id) ?? 0;
  const maintenant = o.maintenant ?? Date.now;
  const differer = o.differer ?? ((f: () => void, ms: number) => void setTimeout(f, ms));
  /** Per app, per frame: when its last note was written, and the last one that came too early (written at the second's end). */
  const cadres = new Map<string, Map<string, { derniere: number; enAttente: (() => void) | null }>>();

  return {
    /**
     * A position noted: it belongs to the page's video of the same duration, another (advert, trailer) neither replaces
     * nor erases it. Without one, the first video long enough notes. Resolves once written (or dropped).
     */
    async position(brute: unknown): Promise<void> {
      const p = brute && typeof brute === "object" ? (brute as { id?: unknown; cadre?: unknown; adresse?: unknown; t?: unknown; duree?: unknown; fin?: unknown }) : {};
      const cible = cibleDe(p);
      if (!cible || typeof p.cadre !== "string" || p.cadre.length > CADRE_MAX || !fini(p.t) || !fini(p.duree) || !o.accorde(cible.id)) return;
      const { t, duree } = p;
      const fin = p.fin === true;
      const generationRecue = generation(cible.id);
      const ecrire = () =>
        o.memoire(cible.id).then(
          (m) => {
            // Forgotten or deleted since the note, or grant withdrawn: nothing is written.
            if (generation(cible.id) !== generationRecue || !o.accorde(cible.id)) return;
            const retenue = m.position(cible.adresse);
            if (retenue && !memeDuree(retenue.duree, duree)) return;
            m.noterPosition(cible.adresse, t, duree);
          },
          (err) => console.error("[sites] position non notée :", err),
        );
      let parCadre = cadres.get(cible.id);
      if (!parCadre) cadres.set(cible.id, (parCadre = new Map()));
      const heure = maintenant();
      const etat = parCadre.get(p.cadre);
      if (!etat) {
        // shortcut: frame keys live until the app closes (fermee), one per document that noted; fine for a session's videos.
        parCadre.set(p.cadre, { derniere: heure, enAttente: null });
        return ecrire();
      }
      if (fin || heure - etat.derniere >= ECART_NOTE_CADRE_MS) {
        etat.derniere = heure;
        etat.enAttente = null;
        return ecrire();
      }
      const attendait = etat.enAttente !== null;
      etat.enAttente = ecrire;
      if (attendait) return;
      differer(() => {
        const f = etat.enAttente;
        etat.enAttente = null;
        if (!f) return;
        etat.derniere = maintenant();
        void f();
      }, ECART_NOTE_CADRE_MS - (heure - etat.derniere));
    },
    /** The page's kept position, for any video of the same duration that asks (recreated player, « Lecteur 2 », reload). */
    async reprise(brute: unknown): Promise<number | null> {
      const p = brute && typeof brute === "object" ? (brute as { id?: unknown; adresse?: unknown; duree?: unknown }) : {};
      const cible = cibleDe(p);
      if (!cible || !fini(p.duree) || p.duree <= 0 || !o.accorde(cible.id)) return null;
      const retenue = (await o.memoire(cible.id).catch(() => null))?.position(cible.adresse);
      return retenue && memeDuree(retenue.duree, p.duree) ? retenue.t : null;
    },
    /** Drops the notes of the app received so far (those waiting for their second included). */
    annulerNotes(id: string): void {
      generations.set(id, generation(id) + 1);
    },
    /** The app's window closed: its frames are gone. */
    fermee(id: string): void {
      cadres.delete(id);
    },
  };
}
