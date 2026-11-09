import { sitePacing } from "../shims/kernel";

/** The host of `target` when its paced site differs from `current`'s, else null (same site, or an unreadable address). */
export function pacedTarget(current: string, target: string): string | null {
  try {
    const host = new URL(target).hostname;
    return sitePacing(new URL(current).hostname) === sitePacing(host) ? null : host;
  } catch {
    return null;
  }
}
