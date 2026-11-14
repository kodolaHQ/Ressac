import { say, KERNEL_LOCALES } from "./i18n.js";

/** The text of kernel error `id` in every shipped language: what a stored error may say, whenever it was written. */
export const inEveryLanguage = (id: string, args?: Record<string, string | number>): string[] => KERNEL_LOCALES.map((l) => say(l, id, args));

/** Matches the grant-required error whatever its language (the text before the domains is the language's own). */
export function grantRequiredPatterns(): RegExp[] {
  const mark = "\u0000";
  return KERNEL_LOCALES.map((l) => {
    const prefix = say(l, "kernel-err-grant-required", { domains: mark }).split(mark)[0]!;
    // The declared domains only have [a-z0-9.-]; the message may have been truncated (« … »).
    return new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[a-z0-9., -]*…?$`);
  });
}
