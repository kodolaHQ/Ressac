// Page actor: the parent asks, the child reads the page (Xray view: the page cannot fake what is read).
// Kept small: the build copies this file, so any change here needs a rebuild of the app (build:ui).
export class WebAiOsPageParent extends JSWindowActorParent {}

/** Electron reads the same in an isolated world. */
const TEXT_MAX = 100_000;

export class WebAiOsPageChild extends JSWindowActorChild {
  receiveMessage(m: { name: string; data?: any }) {
    const doc = this.document;
    const win = this.contentWindow;
    const el = doc.scrollingElement || doc.documentElement;
    switch (m.name) {
      case "getText":
        return { texte: (doc.body?.innerText ?? "").slice(0, TEXT_MAX), selection: String(win.getSelection() ?? "") };
      // Invisible reading, Electron's lecture-invisible.ts scripts. The parent bounds and checks what comes back.
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
