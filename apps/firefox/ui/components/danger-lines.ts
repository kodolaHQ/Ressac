import { UNLOCK_REASON_LENGTH } from "../../shared/extensions-messages";

/** The most red lines a kernel card holds: a fill's 12 rows, each foreign, framed and posting elsewhere, plus its lock, outflow and tick lines. */
export const DANGER_LINES_MAX = 40;

/** A card's red lines in the kernel's order (most severe first), each bounded on its own: a long line never cuts the next. */
export const dangerLines = (danger: string | undefined): string[] =>
  (danger ?? "").split("\n").filter(Boolean).slice(0, DANGER_LINES_MAX).map((l) => l.slice(0, UNLOCK_REASON_LENGTH));
