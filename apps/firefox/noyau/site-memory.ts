import type { MemoireSite } from "../../../packages/noyau/src/index.ts";
import type { ReponseMemoire } from "../../navigateur/src/main/sites/injection.ts";

// The host's side of Electron's brancherInjection channels (main/sites/injection.ts): the chrome checks the sender
// (the app view's main document), the accord and the relative address, the host does the memory work.

/** Electron's REFUS_MEMOIRE, copied (injection.ts does not export it). */
export const REFUS_MEMOIRE = "Mémoire de l'appli : seulement depuis la page principale de l'appli";

type DemandeMemoire = { op: "retenir"; cle: string; valeur: unknown } | { op: "lire" | "oublier"; cle: string };

/** Electron's demandeMemoire: the request's shape, or null. */
function demandeMemoire(d: unknown): DemandeMemoire | null {
  if (!d || typeof d !== "object") return null;
  const { op, cle } = d as { op?: unknown; cle?: unknown };
  if (typeof cle !== "string") return null;
  if (op === "retenir") return { op, cle, valeur: (d as { valeur?: unknown }).valeur };
  return op === "lire" || op === "oublier" ? { op, cle } : null;
}

/**
 * `sites.memoireOp {id, adresse, op, cle, valeur?}`: Electron's memory handler past its sender checks. `memoire(id)`
 * rejects while the app is being deleted: nothing is read or written then.
 */
export async function memoireOp(memoire: (id: string) => Promise<MemoireSite>, brute: unknown): Promise<ReponseMemoire> {
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
