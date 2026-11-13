// Page actor: the parent asks, the child reads the page (Xray view: the page cannot fake what is read).
// Kept small: the build copies this file, so any change here needs a rebuild of the app (build:ui).
export class WebAiOsPageParent extends JSWindowActorParent {}

/** The largest page text the agent reads. */
const TEXT_MAX = 100_000;
/** The body kept for the agent's memory. */
const MEMORY_TEXT_MAX = 20_000;
const LINKS_MAX = 500;
const PDF_PAGES_MAX = 60;

type Zone = "main" | "other" | "aside" | "header" | "nav" | "footer" | "lang";
const ZONE_TAG: Record<string, Zone> = { NAV: "nav", HEADER: "header", FOOTER: "footer", ASIDE: "aside", MAIN: "main", ARTICLE: "main" };
const ZONE_ROLE: Record<string, Zone> = { navigation: "nav", banner: "header", contentinfo: "footer", complementary: "aside", main: "main", article: "main", search: "nav" };
const ZONE_HINT: [RegExp, Zone][] = [
  [/(^|[-_ ])(interlanguage|lang(uage)?s?[-_ ]?(list|switch|select|menu)|p-lang)/i, "lang"],
  [/(^|[-_ ])(nav|navbar|menu|breadcrumb|toc|sidebar|vector-menu|mw-panel|navigation)($|[-_ ])/i, "nav"],
  [/(^|[-_ ])(footer|foot|colophon)($|[-_ ])/i, "footer"],
  [/(^|[-_ ])(cookie|consent|banner|advert|ads?)($|[-_ ])/i, "aside"],
];
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "SELECT", "TEXTAREA", "svg"]);

const zoneOwn = (el: Element): Zone | undefined => {
  const z = ZONE_TAG[el.tagName] ?? ZONE_ROLE[el.getAttribute("role") ?? ""];
  if (z) return z;
  const hint = `${el.id} ${typeof el.className === "string" ? el.className : ""}`.trim();
  if (hint) for (const [re, zone] of ZONE_HINT) if (re.test(hint)) return zone;
  return undefined;
};

/**
 * The page as displayed, like innerText but through open and closed shadow roots, slots and frames of the page's own
 * origin (another origin's frame is never read: the user's grant is for this one). Its http(s) links, tagged with their
 * zone, at most LINKS_MAX (one per address and zone). The text stops at `max`; the walk goes on for the links.
 */
function readDisplayed(doc: Document, max: number) {
  const origin = (doc as any).nodePrincipal.origin;
  const parts: string[] = [];
  let length = 0;
  let newline = true;
  const links: { text: string; url: string; zone: Zone }[] = [];
  const seen = new Set<string>();
  const add = (t: string) => {
    if (length >= max) return;
    parts.push(t);
    length += t.length;
    newline = t.endsWith("\n");
  };
  const breakLine = () => {
    if (!newline) add("\n");
  };
  const walk = (node: Node, zone: Zone, visible: boolean): void => {
    if (length >= max && links.length >= LINKS_MAX) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.nodeValue ?? "").replace(/\s+/g, " ");
      if (visible && t.trim()) add(newline ? t.trimStart() : t);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) for (const c of node.childNodes) walk(c, zone, visible);
      return;
    }
    const el = node as Element;
    if (SKIP.has(el.tagName)) return;
    const cs = el.ownerDocument.defaultView?.getComputedStyle(el);
    if (!cs || cs.display === "none") return;
    const z = zoneOwn(el) ?? zone;
    const shown = cs.visibility === "visible";
    const block = !cs.display.startsWith("inline") && cs.display !== "contents";
    if (el.tagName === "BR") return add("\n");
    if (block) breakLine();
    if (el.tagName === "A" && shown && links.length < LINKS_MAX) {
      const url = (el as HTMLAnchorElement).href;
      if (typeof url === "string" && /^https?:/i.test(url) && !seen.has(`${z} ${url}`)) {
        seen.add(`${z} ${url}`);
        links.push({ text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200), url, zone: z });
      }
    }
    const shadow = (el as any).openOrClosedShadowRoot as ShadowRoot | null;
    if (shadow) walk(shadow, z, shown);
    else if (el.tagName === "SLOT") {
      const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
      for (const c of assigned.length ? assigned : el.childNodes) walk(c, z, shown);
    } else if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
      let inner: Document | null = null;
      try {
        inner = (el as HTMLIFrameElement).contentDocument;
      } catch {}
      if (inner?.body && (inner as any).nodePrincipal.origin === origin) walk(inner.body, z, shown);
    } else for (const c of el.childNodes) walk(c, z, shown);
    if (block) breakLine();
  };
  const root = doc.body ?? doc.documentElement;
  if (root) walk(root, zoneOwn(root) ?? "other", true);
  return { text: parts.join("").trim().slice(0, max), links };
}

/** The text of the PDF the built-in viewer shows, page by page; null when the document is not that viewer. */
async function pdfText(win: Window, max: number): Promise<string | null> {
  const pdf = (win as any).wrappedJSObject?.PDFViewerApplication?.pdfDocument;
  if (!pdf) return null;
  const pages: string[] = [];
  let length = 0;
  for (let i = 1; i <= Math.min(Number(pdf.numPages) || 0, PDF_PAGES_MAX) && length < max; i++) {
    const page = Cu.waiveXrays(await pdf.getPage(i));
    const content = Cu.waiveXrays(await page.getTextContent());
    const text = Array.from(content.items as ArrayLike<any>, (it) => String(it.str ?? "") + (it.hasEOL ? "\n" : "")).join("");
    pages.push(text);
    length += text.length;
  }
  return pages.join("\n\n").slice(0, max);
}

export class WebAiOsPageChild extends JSWindowActorChild {
  receiveMessage(m: { name: string; data?: any }) {
    const doc = this.document;
    // The page's http(s) links, deduplicated, at most `max`.
    const collect = (max: number) => {
      const seen = new Set<string>();
      const links: { text: string; url: string }[] = [];
      for (const a of doc.querySelectorAll("a[href]") as NodeListOf<HTMLAnchorElement>) {
        if (links.length >= max) break;
        const url = a.href;
        if (typeof url !== "string" || !/^https?:/i.test(url) || seen.has(url)) continue;
        seen.add(url);
        links.push({ text: (a.innerText || a.textContent || "").replace(/\s+/g, " ").trim(), url });
      }
      return links;
    };
    const win = this.contentWindow;
    const el = doc.scrollingElement || doc.documentElement;
    switch (m.name) {
      case "getText":
        return (async () => {
          const shown = readDisplayed(doc, TEXT_MAX);
          // The viewer's own text is only its rendered pages: the PDF itself has them all.
          const pdf = await pdfText(win, TEXT_MAX).catch(() => null);
          return { text: pdf ?? shown.text, selection: String(win.getSelection() ?? ""), links: shown.links };
        })();
      // The parts of the page retained for the agent's memory.
      case "getParts": {
        const text = (sel: string) => (doc.querySelector(sel) as HTMLElement | null)?.innerText ?? "";
        const description = (doc.querySelector('meta[name="description"]') as HTMLMetaElement | null)?.content ?? "";
        if (m.data?.video)
          return {
            body: "",
            video: {
              title: text("h1.ytd-watch-metadata") || doc.title,
              channel: text("ytd-watch-metadata #channel-name a") || text("#owner #channel-name a"),
              description: text("#description") || description,
            },
          };
        return { description, body: (doc.body?.innerText ?? "").slice(0, MEMORY_TEXT_MAX) };
      }
      // Invisible reading. The parent bounds and checks what comes back.
      case "read": {
        return { title: doc.title, text: (doc.body?.innerText ?? "").slice(0, m.data.text), links: collect(m.data.links) };
      }
      // The page's height, then one screen down: never a click, a key or focus; the page sees an ordinary scroll.
      case "scroll": {
        const height = el ? el.scrollHeight : 0;
        (el ?? win).scrollBy(0, win.innerHeight || 900);
        return { height: height };
      }
      case "measure":
        if (!el) return { height: 0, bottom: true };
        return { height: el.scrollHeight, bottom: el.scrollTop + (win.innerHeight || el.clientHeight) >= el.scrollHeight - 2 };
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
