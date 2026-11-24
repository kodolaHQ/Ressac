import type { TabInfo } from "../shims/kernel";
import type { Remember } from "./fill";
import type { RememberedSite } from "./questions";

/**
 * « Retenir ce site » (task 13b) once its seal is written, checked again where the file is written: a tab the user
 * reached, of the entry's own profile. Any failure is told on the card's window (`notice`), never to the agent.
 */
export function rememberSite(o: { listed: () => TabInfo[]; addOrigin: (profile: string, id: string, origin: string) => Promise<boolean>; notice: (window: string) => Promise<unknown> }) {
  return async (tab: string, origin: string, r: Remember): Promise<void> => {
    const t = o.listed().find((x) => x.id === tab);
    const ok = t?.agentReached === false && t.profile === r.profile && (await o.addOrigin(r.profile, r.id, origin));
    if (!ok) await o.notice(r.window);
  };
}

/** The fill card's answer for the kernel: its ticks go onto their seals (`remember`) and never leave chrome. */
export function keepTicks<A extends { remember?: RememberedSite[] }>(answer: A, window: string, remember: (seal: string, r: Remember) => void): Omit<A, "remember"> {
  const { remember: ticks, ...rest } = answer;
  for (const r of ticks ?? []) remember(r.seal, { profile: r.profile, id: r.id, window });
  return rest;
}
