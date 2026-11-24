import type { SiteMemory } from "../../../packages/kernel/src/index.ts";
import type { MemoryResponse } from "../core/sites/injection.ts";

// The host's side of the site apps' injection channels (core/sites/injection.ts): the chrome checks the sender
// (the app view's main document), the grant and the relative address, the host does the memory work.

/** The refusal of a memory write while the workspace is locked after a reveal (another space would read it back). */
export const MEMORY_LOCKED = "Mémoire de l'appli : l'atelier est verrouillé depuis une révélation, rien ne s'écrit tant que le verrou n'est pas levé";

/** The refusal of a memory request from anywhere but the app's main page. */
export const MEMORY_DENIAL = "Mémoire de l'appli : seulement depuis la page principale de l'appli";

type MemoryRequest = { op: "remember"; key: string; value: unknown } | { op: "read" | "forget"; key: string };

/** The request's shape, or null. */
function memoryRequest(d: unknown): MemoryRequest | null {
  if (!d || typeof d !== "object") return null;
  const { op, key } = d as { op?: unknown; key?: unknown };
  if (typeof key !== "string") return null;
  if (op === "remember") return { op, key: key, value: (d as { value?: unknown }).value };
  return op === "read" || op === "forget" ? { op, key: key } : null;
}

/**
 * `sites.memoryOp {id, url, op, key, value?}`: the memory work past the sender checks. `memory(id)`
 * rejects while the app is being deleted: nothing is read or written then.
 */
export async function memoryOp(memory: (id: string) => Promise<SiteMemory>, raw: unknown, locked: () => boolean = () => false): Promise<MemoryResponse> {
  const p = raw && typeof raw === "object" ? (raw as { id?: unknown; url?: unknown }) : {};
  const d = memoryRequest(raw);
  if (typeof p.id !== "string" || typeof p.url !== "string" || !d) return { ok: false, error: MEMORY_DENIAL };
  // A forget writes too: one bit is still a channel.
  if (d.op !== "read" && locked()) return { ok: false, error: MEMORY_LOCKED };
  const m = await memory(p.id).catch(() => null);
  if (!m) return { ok: false, error: MEMORY_DENIAL };
  if (d.op === "remember") {
    const r = m.keep(d.key, d.value, p.url);
    return r.ok ? { ok: true } : r;
  }
  if (d.op === "read") return { ok: true, value: m.read(d.key) };
  m.forget(d.key);
  return { ok: true };
}

/** Same video within 2 s of duration; a frame's position noted at most once a second. */
export const RESUME_DURATION_GAP_S = 2;
export const FRAME_NOTE_GAP_MS = 1000;
/** A frame key is "<browsingContext.id>:<innerWindowId>", from the chrome; anything longer is not one. */
const FRAME_MAX = 64;

const finished = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
/** Same video: durations within `RESUME_DURATION_GAP_S`. */
const sameDuration = (a: number, b: number) => Math.abs(a - b) <= RESUME_DURATION_GAP_S;

type Target = { id: string; url: string };
const targetOf = (p: { id?: unknown; url?: unknown }): Target | null => (typeof p.id === "string" && typeof p.url === "string" ? { id: p.id, url: p.url } : null);

/**
 * The position and resume channels past their sender checks, which the chrome made (view,
 * grant, resumeInFrame) and whose page address it gives. The host checks the grant again at each write.
 */
export function createPositions(o: {
  memory(id: string): Promise<SiteMemory>;
  granted(id: string): boolean;
  /** Clock and timer (tests). */
  now?: () => number;
  defer?: (f: () => void, ms: number) => void;
}) {
  /** Per app: « Oublier » and « Supprimer » change it, and any note received before (delayed write included) is dropped. */
  const generations = new Map<string, number>();
  const generation = (id: string) => generations.get(id) ?? 0;
  const now = o.now ?? Date.now;
  const defer = o.defer ?? ((f: () => void, ms: number) => void setTimeout(f, ms));
  /** Per app, per frame: when its last note was written, and the last one that came too early (written at the second's end). */
  const frames = new Map<string, Map<string, { last: number; waiting: (() => void) | null }>>();

  return {
    /**
     * A position noted: it belongs to the page's video of the same duration, another (advert, trailer) neither replaces
     * nor erases it. Without one, the first video long enough notes. Resolves once written (or dropped).
     */
    async position(raw: unknown): Promise<void> {
      const p = raw && typeof raw === "object" ? (raw as { id?: unknown; frame?: unknown; url?: unknown; t?: unknown; duration?: unknown; end?: unknown }) : {};
      const target = targetOf(p);
      if (!target || typeof p.frame !== "string" || p.frame.length > FRAME_MAX || !finished(p.t) || !finished(p.duration) || !o.granted(target.id)) return;
      const { t, duration } = p;
      const end = p.end === true;
      const generationReceived = generation(target.id);
      const write = () =>
        o.memory(target.id).then(
          (m) => {
            // Forgotten or deleted since the note, or grant withdrawn: nothing is written.
            if (generation(target.id) !== generationReceived || !o.granted(target.id)) return;
            const kept = m.position(target.url);
            if (kept && !sameDuration(kept.duration, duration)) return;
            m.notePosition(target.url, t, duration);
          },
          (err) => console.error("[sites] position not noted:", err),
        );
      let byFrame = frames.get(target.id);
      if (!byFrame) frames.set(target.id, (byFrame = new Map()));
      const hour = now();
      const state = byFrame.get(p.frame);
      if (!state) {
        // shortcut: frame keys live until the app closes (fermee), one per document that noted; fine for a session's videos.
        byFrame.set(p.frame, { last: hour, waiting: null });
        return write();
      }
      if (end || hour - state.last >= FRAME_NOTE_GAP_MS) {
        state.last = hour;
        state.waiting = null;
        return write();
      }
      const awaited = state.waiting !== null;
      state.waiting = write;
      if (awaited) return;
      defer(() => {
        const f = state.waiting;
        state.waiting = null;
        if (!f) return;
        state.last = now();
        void f();
      }, FRAME_NOTE_GAP_MS - (hour - state.last));
    },
    /** The page's kept position, for any video of the same duration that asks (recreated player, « Lecteur 2 », reload). */
    async resume(raw: unknown): Promise<number | null> {
      const p = raw && typeof raw === "object" ? (raw as { id?: unknown; url?: unknown; duration?: unknown }) : {};
      const target = targetOf(p);
      if (!target || !finished(p.duration) || p.duration <= 0 || !o.granted(target.id)) return null;
      const kept = (await o.memory(target.id).catch(() => null))?.position(target.url);
      return kept && sameDuration(kept.duration, p.duration) ? kept.t : null;
    },
    /** Drops the notes of the app received so far (those waiting for their second included). */
    cancelNotes(id: string): void {
      generations.set(id, generation(id) + 1);
    },
    /** The app's window closed: its frames are gone. */
    closed(id: string): void {
      frames.delete(id);
    },
  };
}
