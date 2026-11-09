// The bar's « Lien vers X bloqué » mention of a site app.
// The request guard itself is in sites.ts (one observer for every app container).
import type { BarNotice } from "../../shared/sites";

/** At most one change of the mention per 500 ms. */
export const NOTICE_GAP_MS = 500;

/** The host of an http(s) address, else null (about:blank, javascript:, an unreadable address). */
export function httpHost(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname : null;
  } catch {
    return null;
  }
}

export interface BlockedNotice {
  readonly notice: BarNotice | null;
  /** A navigation or an open was refused: its URL is kept for « Ouvrir dans un onglet », the bar shows its domain. */
  block(url: string): void;
  /** « Ouvrir dans un onglet »: the last blocked URL, once; the mention falls (the caller broadcasts). */
  take(): string | null;
  /** A new page: the mention and the URL fall (the caller broadcasts). */
  clear(): void;
  dispose(): void;
}

/** `broadcast` sends the window's state, the mention in it: the first change at once, the last one always (deferred). */
export function blockedNotice(broadcast: () => void): BlockedNotice {
  let url: string | null = null;
  let notice: BarNotice | null = null;
  let sent = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const send = () => {
    timer = undefined;
    sent = Date.now();
    broadcast();
  };
  return {
    get notice() {
      return notice;
    },
    block(u) {
      const domain = httpHost(u);
      // Nothing to open in a tab: refused without a mention.
      if (!domain) return;
      url = u;
      if (notice?.kind === "lien-bloque" && notice.domain === domain) return;
      notice = { kind: "lien-bloque", domain: domain };
      if (timer) return;
      const wait = sent + NOTICE_GAP_MS - Date.now();
      if (wait <= 0) send();
      else timer = setTimeout(send, wait);
    },
    take() {
      const u = url;
      url = null;
      if (notice?.kind === "lien-bloque") notice = null;
      return u;
    },
    clear() {
      url = null;
      notice = null;
    },
    dispose() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
