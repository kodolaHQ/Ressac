import type { Masker, WorkspaceLock } from "../../../packages/kernel/src/index.ts";
import { PassportStore } from "../../../packages/kernel/src/mask/passport.ts";
import { passportReady } from "../../../packages/kernel/src/mcp/server.ts";
import { LABEL_SOURCE } from "../../../packages/kernel/src/mask/table.ts";
import { nameAgreement } from "../../../packages/kernel/src/mask/names.ts";
import { hostLocale } from "./locale.ts";
import type { MaskingStatus } from "../shared/api.ts";

/** A label as the masker issues it: anything else is not looked up. */
const LABEL = new RegExp(`^${LABEL_SOURCE}$`);

/**
 * What the window's agent panel says about masking: the workspace lock (read from its file), a conversation not covered,
 * the kernel's notice for this conversation (`notices`, by session: a new conversation has none).
 */
export function maskingStatus(
  masker: Pick<Masker, "uncoveredCause" | "sessionOf"> | null,
  lock: Pick<WorkspaceLock, "info">,
  notices: ReadonlyMap<string, string>,
  win: string,
  extensionReads: boolean,
  passport: Pick<PassportStore, "unreadable">,
): MaskingStatus {
  const session = masker?.sessionOf(win) ?? null;
  const names = lock.info()?.names ?? null;
  const cause = masker?.uncoveredCause(win);
  return {
    locked: names,
    lockedAgreement: nameAgreement(names ?? [], hostLocale()).agreement,
    uncovered: cause?.resumed ?? false,
    uncoveredPassport: cause?.passport ?? [],
    notice: (session !== null && notices.get(session)) || null,
    extensionReads,
    passportUnreadable: [...passport.unreadable()],
  };
}

/**
 * The host's one passport store (design § 5.4, ruling F1): it outlives every kernel, and no tool answers before the
 * chrome's `passport.ready`. The loopback seam comes only from RESSAC_TEST_LOCAL_ADDRESSES, which a packaged host deletes.
 */
export function hostPassport(env: Record<string, string | undefined>): PassportStore {
  return new PassportStore({ awaitReady: true, localAddresses: env.RESSAC_TEST_LOCAL_ADDRESSES === "1" });
}

/** The value behind a label of the window's own session, for its card or bubble: never logged, never sent to the agent. */
export function revealLocal(masker: Pick<Masker, "lookupForUser"> | null, win: unknown, label: unknown): string | null {
  if (typeof win !== "string" || typeof label !== "string" || !LABEL.test(label)) return null;
  return masker?.lookupForUser(win, label)?.value ?? null;
}

/**
 * A paste into the window's terminal, masked as the user's own data (the sources zone, no origin) with what it hid named
 * for the bubble; the original never comes back from here. Waits for the passports (design § 5.2), at most `ms`. null
 * without a kernel or at the cap: the UI then never pastes on its own.
 */
export async function maskPaste(masker: () => Pick<Masker, "maskTyped"> | null, passport: Pick<PassportStore, "ready">, win: unknown, text: unknown, ms?: number): Promise<{ text: string; names: string[] } | null> {
  if (typeof win !== "string" || typeof text !== "string" || !masker()) return null;
  if (!(await passportReady(passport, ms))) return null;
  // Read again: the kernel may have restarted while the passports came.
  return masker()?.maskTyped(win, text) ?? null;
}
