// Page actor: the parent asks, the child reads the page (Xray view: the page cannot fake what is read).
// Kept small: the build copies this file, so any change here needs a rebuild of the app (build:ui).
export class WebAiOsPageParent extends JSWindowActorParent {}

/** The largest page text the agent reads. */
const TEXT_MAX = 100_000;
/** The body kept for the agent's memory. */
const MEMORY_TEXT_MAX = 20_000;

export class WebAiOsPageChild extends JSWindowActorChild {
  receiveMessage(m: { name: string; data?: any }) {
    const doc = this.document;
    const win = this.contentWindow;
    const el = doc.scrollingElement || doc.documentElement;
    switch (m.name) {
      case "getText":
        return { texte: (doc.body?.innerText ?? "").slice(0, TEXT_MAX), selection: String(win.getSelection() ?? "") };
      // The parts of the page retained for the agent's memory.
      case "getParts": {
        const text = (sel: string) => (doc.querySelector(sel) as HTMLElement | null)?.innerText ?? "";
        const description = (doc.querySelector('meta[name="description"]') as HTMLMetaElement | null)?.content ?? "";
        if (m.data?.video)
          return {
            corps: "",
            video: {
              titre: text("h1.ytd-watch-metadata") || doc.title,
              chaine: text("ytd-watch-metadata #channel-name a") || text("#owner #channel-name a"),
              description: text("#description") || description,
            },
          };
        return { description, corps: (doc.body?.innerText ?? "").slice(0, MEMORY_TEXT_MAX) };
      }
      // Invisible reading. The parent bounds and checks what comes back.
      case "read": {
        const vus = new Set<string>();
        const liens: { texte: string; url: string }[] = [];
        for (const a of doc.querySelectorAll("a[href]") as NodeListOf<HTMLAnchorElement>) {
          if (liens.length >= m.data.liens) break;
          const url = a.href;
          if (typeof url !== "string" || !/^https?:/i.test(url) || vus.has(url)) continue;
          vus.add(url);
          liens.push({ texte: (a.innerText || a.textContent || "").replace(/\s+/g, " ").trim(), url });
        }
        return { titre: doc.title, texte: (doc.body?.innerText ?? "").slice(0, m.data.texte), liens };
      }
      // The page's height, then one screen down: never a click, a key or focus; the page sees an ordinary scroll.
      case "scroll": {
        const hauteur = el ? el.scrollHeight : 0;
        (el ?? win).scrollBy(0, win.innerHeight || 900);
        return { hauteur };
      }
      case "measure":
        if (!el) return { hauteur: 0, bas: true };
        return { hauteur: el.scrollHeight, bas: el.scrollTop + (win.innerHeight || el.clientHeight) >= el.scrollHeight - 2 };
      case "html":
        return (doc.documentElement?.outerHTML ?? "").slice(0, m.data.max);
    }
    return undefined;
  }
}

/**
 * Invisible reads only (messagemanagergroup webaios-reading), in every frame: what a page cannot display is refused
 * (DONT_RETARGET), never downloaded nor handed to an app. Set on each new document, the parent also asks it once
 * before the read loads: a browsing context replaced by a navigation starts without it.
 */
export class WebAiOsReadingParent extends JSWindowActorParent {}
export class WebAiOsReadingChild extends JSWindowActorChild {
  handleEvent() {
    this.docShell.allowContentRetargeting = false;
  }
  receiveMessage() {
    this.docShell.allowContentRetargeting = false;
    return true;
  }
}
