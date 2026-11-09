import type { SiteMemory } from "../../../packages/kernel/src/index.ts";
import type { MemoryResponse } from "../core/sites/injection.ts";

// The host's side of the site apps' injection channels (core/sites/injection.ts): the chrome checks the sender
// (the app view's main document), the grant and the relative address, the host does the memory work.

/** The refusal of a memory request from anywhere but the app's main page. */
export const MEMORY_DENIAL = "Mémoire de l'appli : seulement depuis la page principale de l'appli";

type MemoryRequest = { op: "retenir"; cle: string; valeur: unknown } | { op: "lire" | "oublier"; cle: string };

/** The request's shape, or null. */
function memoryRequest(d: unknown): MemoryRequest | null {
  if (!d || typeof d !== "object") return null;
  const { op, cle: key } = d as { op?: unknown; cle?: unknown };
  if (typeof key !== "string") return null;
  if (op === "retenir") return { op, cle: key, valeur: (d as { valeur?: unknown }).valeur };
  return op === "lire" || op === "oublier" ? { op, cle: key } : null;
}

/**
 * `sites.memoireOp {id, adresse, op, cle, valeur?}`: the memory work past the sender checks. `memoire(id)`
 * rejects while the app is being deleted: nothing is read or written then.
 */
export async function memoryOp(memory: (id: string) => Promise<SiteMemory>, raw: unknown): Promise<MemoryResponse> {
  const p = raw && typeof raw === "object" ? (raw as { id?: unknown; adresse?: unknown }) : {};
  const d = memoryRequest(raw);
  if (typeof p.id !== "string" || typeof p.adresse !== "string" || !d) return { ok: false, erreur: MEMORY_DENIAL };
  const m = await memory(p.id).catch(() => null);
  if (!m) return { ok: false, erreur: MEMORY_DENIAL };
  if (d.op === "retenir") {
    const r = m.retenir(d.cle, d.valeur, p.adresse);
    return r.ok ? { ok: true } : r;
  }
  if (d.op === "lire") return { ok: true, valeur: m.lire(d.cle) };
  m.oublier(d.cle);
  return { ok: true };
}

/** Same video within 2 s of duration; a frame's position noted at most once a second. */
export const RESUME_DURATION_GAP_S = 2;
export const FRAME_NOTE_GAP_MS = 1000;
/** A frame key is "<browsingContext.id>:<innerWindowId>", from the chrome; anything longer is not one. */
const FRAME_MAX = 64;

const finished = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
/** Same video: durations within `ECART_DUREE_REPRISE_S`. */
const sameDuration = (a: number, b: number) => Math.abs(a - b) <= RESUME_DURATION_GAP_S;

type Target = { id: string; adresse: string };
const targetOf = (p: { id?: unknown; adresse?: unknown }): Target | null => (typeof p.id === "string" && typeof p.adresse === "string" ? { id: p.id, adresse: p.adresse } : null);

/**
 * The position and reprise channels past their sender checks, which the chrome made (view,
 * grant, repriseDansCadre) and whose page address it gives. The host checks the grant again at each write.
 */
export function createPositions(o: {
  memoire(id: string): Promise<SiteMemory>;
  accorde(id: string): boolean;
  /** Clock and timer (tests). */
  maintenant?: () => number;
  differer?: (f: () => void, ms: number) => void;
}) {
  /** Per app: « Oublier » and « Supprimer » change it, and any note received before (delayed write included) is dropped. */
  const generations = new Map<string, number>();
  const generation = (id: string) => generations.get(id) ?? 0;
  const now = o.maintenant ?? Date.now;
  const defer = o.differer ?? ((f: () => void, ms: number) => void setTimeout(f, ms));
  /** Per app, per frame: when its last note was written, and the last one that came too early (written at the second's end). */
  const frames = new Map<string, Map<string, { derniere: number; enAttente: (() => void) | null }>>();

  return {
    /**
     * A position noted: it belongs to the page's video of the same duration, another (advert, trailer) neither replaces
     * nor erases it. Without one, the first video long enough notes. Resolves once written (or dropped).
     */
    async position(raw: unknown): Promise<void> {
      const p = raw && typeof raw === "object" ? (raw as { id?: unknown; cadre?: unknown; adresse?: unknown; t?: unknown; duree?: unknown; fin?: unknown }) : {};
      const target = targetOf(p);
      if (!target || typeof p.cadre !== "string" || p.cadre.length > FRAME_MAX || !finished(p.t) || !finished(p.duree) || !o.accorde(target.id)) return;
      const { t, duree: duration } = p;
      const end = p.fin === true;
      const generationReceived = generation(target.id);
      const write = () =>
        o.memoire(target.id).then(
          (m) => {
            // Forgotten or deleted since the note, or grant withdrawn: nothing is written.
            if (generation(target.id) !== generationReceived || !o.accorde(target.id)) return;
            const kept = m.position(target.adresse);
            if (kept && !sameDuration(kept.duree, duration)) return;
            m.noterPosition(target.adresse, t, duration);
          },
          (err) => console.error("[sites] position non notée :", err),
        );
      let byFrame = frames.get(target.id);
      if (!byFrame) frames.set(target.id, (byFrame = new Map()));
      const hour = now();
      const state = byFrame.get(p.cadre);
      if (!state) {
        // shortcut: frame keys live until the app closes (fermee), one per document that noted; fine for a session's videos.
        byFrame.set(p.cadre, { derniere: hour, enAttente: null });
        return write();
      }
      if (end || hour - state.derniere >= FRAME_NOTE_GAP_MS) {
        state.derniere = hour;
        state.enAttente = null;
        return write();
      }
      const awaited = state.enAttente !== null;
      state.enAttente = write;
      if (awaited) return;
      defer(() => {
        const f = state.enAttente;
        state.enAttente = null;
        if (!f) return;
        state.derniere = now();
        void f();
      }, FRAME_NOTE_GAP_MS - (hour - state.derniere));
    },
    /** The page's kept position, for any video of the same duration that asks (recreated player, « Lecteur 2 », reload). */
    async reprise(raw: unknown): Promise<number | null> {
      const p = raw && typeof raw === "object" ? (raw as { id?: unknown; adresse?: unknown; duree?: unknown }) : {};
      const target = targetOf(p);
      if (!target || !finished(p.duree) || p.duree <= 0 || !o.accorde(target.id)) return null;
      const kept = (await o.memoire(target.id).catch(() => null))?.position(target.adresse);
      return kept && sameDuration(kept.duree, p.duree) ? kept.t : null;
    },
    /** Drops the notes of the app received so far (those waiting for their second included). */
    annulerNotes(id: string): void {
      generations.set(id, generation(id) + 1);
    },
    /** The app's window closed: its frames are gone. */
    fermee(id: string): void {
      frames.delete(id);
    },
  };
}
