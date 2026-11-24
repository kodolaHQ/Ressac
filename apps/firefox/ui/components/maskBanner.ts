import type { MaskingStatus } from "../../shared/api";

/**
 * The « non couverte » banner's text, by cause: a conversation resumed from an uncovered one (step 1) may have seen
 * anything, which says more than a passport addition (design § 5.3) and so wins.
 */
export function uncoveredText(m: Pick<MaskingStatus, "uncovered" | "uncoveredPassport">): "agent-mask-uncovered" | "agent-mask-uncovered-passport" | null {
  return m.uncovered ? "agent-mask-uncovered" : m.uncoveredPassport.length ? "agent-mask-uncovered-passport" : null;
}

/** The passport banner's tooltip: one line per added entry, its card name and masked display (never the value). */
export function passportTip(shown: readonly { field: string | null; display: string | null }[], t: (id: string) => string): string {
  const lines = shown.map((s) => (s.field === null ? t("agent-mask-passport-unknown") : [t(`agent-mask-passport-field-${s.field}`), s.display].filter(Boolean).join(" · ")));
  return [...new Set(lines)].join("\n");
}
