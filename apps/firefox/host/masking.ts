import type { Kernel, Masker, WorkspaceLock } from "../../../packages/kernel/src/index.ts";
import { PassportStore } from "../../../packages/kernel/src/mask/passport.ts";
import { originOf, passportReady } from "../../../packages/kernel/src/mcp/server.ts";
import { maskedRuns, type MaskedRun } from "../../../packages/kernel/src/mask/mask.ts";
import { guessField, PASSPORT_LIMITS, splitName, type PassportField } from "../../../packages/kernel/src/mask/passport-fields.ts";
import { LABEL_SOURCE } from "../../../packages/kernel/src/mask/table.ts";
import { nameAgreement } from "../../../packages/kernel/src/mask/names.ts";
import { hostLocale } from "./locale.ts";
import { SITE_PREFIX } from "../core/agent/bridge.ts";
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

// shortcut: a refresh sends a page's visible text only, these caps keep a bad call cheap; raise them if long pages lose marks.
const RUNS_TEXTS = 2000;
const RUNS_CHARS = 200_000;

/**
 * Where the window's agent would see labels in each of `texts`, read from tab `tab` on `url` (chrome's marks): the
 * session's table, the zone the kernel gives its reads of that tab (`agentReached`: chrome's flag; a site app the agent
 * navigated in this conversation is no source either). Issues no label. `window: null` asks for the main token's table
 * (no conversation: its zone and the passport's sites now). No session (or no kernel): `runs: null`, so a caller asking
 * several windows can tell « no conversation » from « nothing masked ».
 */
export function maskRuns(kernel: Pick<Kernel, "masker" | "tabZone"> | null, p: unknown): { runs: MaskedRun[][] | null } {
  const { window: win, tab, url, agentReached, texts } = (p ?? {}) as Record<string, unknown>;
  if ((typeof win !== "string" && win !== null) || typeof tab !== "string" || typeof url !== "string" || typeof agentReached !== "boolean" || !Array.isArray(texts) || texts.length > RUNS_TEXTS || !texts.every((t) => typeof t === "string" && t.length <= RUNS_CHARS))
    throw new Error("mask.runs: invalid params");
  if (!kernel) return { runs: null };
  const session = win === null ? null : kernel.masker.sessionOf(win);
  if (win !== null && session === null) return { runs: null };
  // A site app's window is the tab `site:<id>` (`siteTab`).
  const site = tab.startsWith(SITE_PREFIX) ? tab.slice(SITE_PREFIX.length) : undefined;
  const zone = kernel.tabZone(session, { id: tab, url, agentReached, ...(site !== undefined ? { site } : {}) });
  const ctx = { table: kernel.masker.table(session), zone, origin: originOf(url) };
  return { runs: (texts as string[]).map((t) => maskedRuns(t, ctx)) };
}

/** The passport field a clicked text looks like, and its name parts when it is a name. */
export function maskGuess(p: unknown): { field: PassportField; name?: { given: string; family: string } } {
  const text = (p as { text?: unknown } | null)?.text;
  if (typeof text !== "string") throw new Error("mask.guess: invalid params");
  const field = text.length > PASSPORT_LIMITS.value ? "libre" : guessField(text);
  return field === "nom" ? { field, name: splitName(text) } : { field };
}
