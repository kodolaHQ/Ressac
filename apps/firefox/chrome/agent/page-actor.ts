// Page actor: the parent asks, the child reads the page (Xray view: the page cannot fake what is read).
// Kept small: the build copies this file, so any change here needs a rebuild of the app (build:ui).
export class WebAiOsPageParent extends JSWindowActorParent {}

/** The largest page text the agent reads. */
const TEXT_MAX = 100_000;
/** The body kept for the agent's memory. */
const MEMORY_TEXT_MAX = 20_000;
const LINKS_MAX = 500;
/** A menu zone's share of LINKS_MAX: a page's 600 menu links never crowd out its content's, which has no quota. */
const LINKS_PER_ZONE = 150;
const QUOTA_ZONES = new Set<Zone>(["nav", "header", "footer", "aside", "lang"]);
const PDF_PAGES_MAX = 60;
const PDF_READ_MS = 5_000;
const BLOCKS_MAX = 6_000;
const BLOCKS_TEXT_MAX = 200_000;
const READER_MS = 3_000;
/** Past this many elements the reader mode would take the whole page's time: the blocks do without it. */
const READER_ELEMENTS_MAX = 20_000;
/** One block's text: a single huge text node never fills the whole budget. */
const BLOCK_TEXT_MAX = 5_000;
/** A JSON-LD script past this size is not parsed (the kernel keeps 20 pairs anyway). */
const JSON_LD_MAX = 50_000;

type Zone = "main" | "other" | "aside" | "header" | "nav" | "footer" | "lang";
const ZONE_TAG: Record<string, Zone> = { NAV: "nav", HEADER: "header", FOOTER: "footer", ASIDE: "aside", MAIN: "main", ARTICLE: "main" };
const ZONE_ROLE: Record<string, Zone> = { navigation: "nav", banner: "header", contentinfo: "footer", complementary: "aside", main: "main", article: "main", search: "nav" };
const ZONE_HINT: [RegExp, Zone][] = [
  [/(^|[-_ ])(interlanguage|lang(uage)?s?[-_ ]?(list|switch|select|menu)|p-lang)/i, "lang"],
  [/(^|[-_ ])(nav|navbar|menu|breadcrumb|toc|sidebar|vector-menu|mw-panel|navigation|editsection)($|[-_ ])/i, "nav"],
  [/(^|[-_ ])(footer|foot|colophon)($|[-_ ])/i, "footer"],
  [/(^|[-_ ])(cookie|consent|banner|advert|ads?)($|[-_ ])/i, "aside"],
];
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "SELECT", "TEXTAREA", "svg"]);

const zoneOwn = (el: Element): Zone | undefined => {
  // The page-wide classes of body and html (« has-main-navigation ») say nothing of where a link sits.
  if (el.tagName === "BODY" || el.tagName === "HTML") return undefined;
  const z = ZONE_TAG[el.tagName] ?? ZONE_ROLE[el.getAttribute("role") ?? ""];
  if (z) return z;
  const hint = `${el.id} ${typeof el.className === "string" ? el.className : ""}`.trim();
  if (hint) for (const [re, zone] of ZONE_HINT) if (re.test(hint)) return zone;
  return undefined;
};

/**
 * The page as displayed, like innerText but through open and closed shadow roots, slots and frames of the page's own
 * origin (another origin's frame is never read: the user's grant is for this one). Its http(s) links, tagged with their
 * zone, at most LINKS_MAX and LINKS_PER_ZONE per menu zone (one per address, fragment dropped, and zone). The text stops at
 * `max`; the walk goes on for the links. Its blocks: the visible text by block, with heading weight and zone, without
 * the text a person cannot see (tiny, transparent, off screen, clipped, the colour of its background), the usual
 * carrier of instructions hidden from the reader. Blocks only with `capture`: the search reads, not every page read.
 * A link a person cannot see is never listed.
 */
function readDisplayed(doc: Document, max: number, capture: boolean) {
  const origin = (doc as any).nodePrincipal.origin;
  const parts: string[] = [];
  let length = 0;
  let newline = true;
  const links: { text: string; url: string; zone: Zone }[] = [];
  const seen = new Set<string>();
  const perZone = new Map<Zone, number>();
  /** Shadow roots or frames were walked: content the reader mode never sees. */
  let deep = false;
  const blocks: { text: string; h: number; zone: Zone; row?: number }[] = [];
  let blocksText = 0;
  let cur: { text: string; h: number; zone: Zone; row?: number; pre?: boolean } | null = null;
  const flush = () => {
    if (cur && blocks.length < BLOCKS_MAX && blocksText < BLOCKS_TEXT_MAX) {
      // Code keeps its lines and indentation in the reduced page too.
      cur.text = cur.pre ? cur.text.replace(/^\n+|\s+$/g, "") : cur.text.replace(/\s+/g, " ").trim();
      delete cur.pre;
      if (cur.text) {
        blocks.push(cur);
        blocksText += cur.text.length;
      }
    }
    cur = null;
  };
  const view = doc.defaultView!;
  const bodySize = parseFloat(view.getComputedStyle(doc.body ?? doc.documentElement).fontSize) || 16;
  // A dark colour scheme may paint the canvas dark: the page's background is then unknown ("").
  // The meta tag does not show in the computed `color-scheme`.
  const scheme = `${view.getComputedStyle(doc.documentElement).colorScheme} ${doc.querySelector('meta[name="color-scheme"]')?.getAttribute("content") ?? ""}`;
  const canvas = /dark/.test(scheme) ? "" : "rgb(255, 255, 255)";
  const backgrounds = new WeakMap<Element, string>();
  /** The colour behind an element's text, "" when unknown (an image or gradient is behind it). */
  const background = (el: Element | null): string => {
    if (!el) return canvas;
    const known = backgrounds.get(el);
    if (known !== undefined) return known;
    const cs = el.ownerDocument.defaultView!.getComputedStyle(el);
    const c = cs.backgroundColor;
    const r = cs.backgroundImage && cs.backgroundImage !== "none" ? "" : !c || alpha(c) < 0.1 ? background(el.parentElement ?? ((el.getRootNode() as ShadowRoot).host ?? null)) : c;
    backgrounds.set(el, r);
    return r;
  };
  const numbers = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
  const rgb = (c: string) => numbers(c).slice(0, 3);
  const alpha = (c: string) => (c === "transparent" ? 0 : (numbers(c)[3] ?? 1));
  /** Text a person cannot see: transparent (but not gradient text, drawn by its background) or its background's colour. */
  const unseen = (el: Element, cs: CSSStyleDeclaration) =>
    (alpha(cs.color) < 0.1 && cs.backgroundClip !== "text") || sameColour(cs.color, background(el));
  const sameColour = (a: string, b: string) => {
    const [x, y] = [rgb(a), rgb(b)];
    return x.length === 3 && y.length === 3 && Math.abs(x[0]! - y[0]!) + Math.abs(x[1]! - y[1]!) + Math.abs(x[2]! - y[2]!) < 24;
  };
  /** Rendered, yet a person cannot see it. */
  const stealthy = (el: Element, cs: CSSStyleDeclaration) => {
    if (Number(cs.opacity) < 0.05 || parseFloat(cs.fontSize) < 4) return true;
    if (/rect\(0|inset\(50%|inset\(100%/.test(cs.clip + cs.clipPath)) return true;
    if (cs.display.startsWith("inline") || cs.display === "contents") return false;
    const r = el.getBoundingClientRect();
    return ((r.width <= 1 || r.height <= 1) && cs.overflow !== "visible") || r.right < -50 || r.bottom + view.scrollY < -50 || r.left < -2000;
  };
  const headingOf = (el: Element, cs: CSSStyleDeclaration, text: string) => {
    for (let e: Element | null = el, i = 0; e && i < 4; e = e.parentElement, i++) {
      const m = /^H([1-6])$/.exec(e.tagName);
      if (m) return Number(m[1]);
      if (e.getAttribute("role") === "heading") return Math.min(6, Math.max(1, Number(e.getAttribute("aria-level")) || 2));
    }
    const size = parseFloat(cs.fontSize) || 0;
    // Visual weight: big or bold short text is a heading even without the tag.
    return text.length < 120 && (size >= bodySize * 1.35 || (Number(cs.fontWeight) >= 600 && size >= bodySize * 1.1)) ? 3 : 0;
  };
  const add = (t: string) => {
    if (length >= max) return;
    parts.push(t);
    length += t.length;
    newline = t.endsWith("\n");
  };
  const breakLine = () => {
    if (!newline) add("\n");
  };
  const walk = (node: Node, zone: Zone, visible: boolean, pre: boolean, stealth: boolean): void => {
    if (length >= max && links.length >= LINKS_MAX && (!capture || blocks.length >= BLOCKS_MAX || blocksText >= BLOCKS_TEXT_MAX)) return;
    if (node.nodeType === Node.TEXT_NODE) {
      if (!visible) return;
      const raw = node.nodeValue ?? "";
      if (!raw.trim()) {
        // Whitespace between inline pieces separates words; in code it is the line breaks and the indentation.
        if (length < max && (pre || !(newline || /\s$/.test(parts.at(-1) ?? "")))) add(pre ? raw : " ");
        if (cur && !stealth && cur.text.length < BLOCK_TEXT_MAX) cur.text += pre ? raw : " ";
        return;
      }
      if (length < max) {
        // Preformatted text (code) keeps its line breaks and indentation, as innerText does.
        const t = pre ? raw : raw.replace(/\s+/g, " ");
        add(newline && !pre ? t.trimStart() : t);
      }
      if (!capture || stealth) return;
      const parent = node.parentElement;
      const cs = parent && parent.ownerDocument.defaultView!.getComputedStyle(parent);
      if (!parent || !cs || unseen(parent, cs)) return;
      if (!cur) {
        const cell = parent.closest("td, th");
        const tr = cell?.parentElement;
        cur = { text: "", h: headingOf(parent, cs, raw.trim()), zone, ...(pre ? { pre } : {}), ...(tr ? { row: [...tr.parentElement!.children].indexOf(tr) } : {}) };
      }
      if (cur.text.length < BLOCK_TEXT_MAX) cur.text += raw.slice(0, BLOCK_TEXT_MAX - cur.text.length);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) for (const c of node.childNodes) walk(c, zone, visible, pre, stealth);
      return;
    }
    const el = node as Element;
    if (SKIP.has(el.tagName)) return;
    const cs = el.ownerDocument.defaultView?.getComputedStyle(el);
    if (!cs || cs.display === "none") return;
    const z = zoneOwn(el) ?? zone;
    const shown = cs.visibility === "visible";
    const keep = cs.whiteSpace.startsWith("pre") || cs.whiteSpace === "break-spaces";
    const block = !cs.display.startsWith("inline") && cs.display !== "contents";
    const hidden = stealth || stealthy(el, cs);
    if (el.tagName === "BR") return add("\n");
    if (block) {
      breakLine();
      flush();
    }
    if (el.tagName === "A" && shown && !hidden && links.length < LINKS_MAX && !unseen(el, cs) && !(QUOTA_ZONES.has(z) && (perZone.get(z) ?? 0) >= LINKS_PER_ZONE)) {
      const url = (el as HTMLAnchorElement).href;
      const key = `${z} ${String(url).split("#")[0]}`;
      if (typeof url === "string" && /^https?:/i.test(url) && !seen.has(key)) {
        seen.add(key);
        perZone.set(z, (perZone.get(z) ?? 0) + 1);
        links.push({ text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200), url, zone: z });
      }
    }
    const shadow = (el as any).openOrClosedShadowRoot as ShadowRoot | null;
    if (shadow) {
      deep = true;
      walk(shadow, z, shown, keep, hidden);
    }
    else if (el.tagName === "SLOT") {
      const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
      for (const c of assigned.length ? assigned : el.childNodes) walk(c, z, shown, keep, hidden);
    } else if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
      let inner: Document | null = null;
      try {
        inner = (el as HTMLIFrameElement).contentDocument;
      } catch {}
      if (inner?.body && (inner as any).nodePrincipal.origin === origin) {
        deep = true;
        walk(inner.body, z, shown, keep, hidden);
      }
    } else for (const c of el.childNodes) walk(c, z, shown, keep, hidden);
    if (block) {
      breakLine();
      flush();
    }
  };
  const root = doc.body ?? doc.documentElement;
  if (root) walk(root, "other", true, false, false);
  flush();
  return { text: parts.join("").trim().slice(0, max), links, blocks, deep };
}

/** The structured data the page publishes for engines: its JSON-LD, then its meta tags and microdata as objects. */
function structuredData(doc: Document): unknown[] {
  const out: unknown[] = [];
  for (const s of [...doc.querySelectorAll('script[type="application/ld+json"]')].slice(0, 20)) {
    const raw = s.textContent ?? "";
    if (raw.length > JSON_LD_MAX) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {}
  }
  const meta: Record<string, string> = {};
  for (const m of [...doc.querySelectorAll("meta[property], meta[name]")].slice(0, 200)) {
    const k = m.getAttribute("property") || m.getAttribute("name") || "";
    const v = m.getAttribute("content") ?? "";
    if (/^(og:|article:|product:|description$|author$|date$)/i.test(k) && v) meta[k] = v.slice(0, 500);
  }
  if (Object.keys(meta).length) out.push(meta);
  const micro: Record<string, string> = {};
  for (const e of [...doc.querySelectorAll("[itemprop]")].slice(0, 80)) {
    // Attributes only: an element's text may be hidden from the person, the blocks carry what is shown.
    const v = (e.getAttribute("content") || e.getAttribute("datetime") || "").replace(/\s+/g, " ").trim();
    const k = e.getAttribute("itemprop") ?? "";
    if (k && v && v.length < 300) micro[k] ??= v;
  }
  if (Object.keys(micro).length) out.push(micro);
  return out;
}

/** The reader mode's text of the main content, or undefined (none found, or not within READER_MS). */
async function readerText(doc: Document, win: Window): Promise<string | undefined> {
  const { ReaderMode } = ChromeUtils.importESModule("moz-src:///toolkit/components/reader/ReaderMode.sys.mjs") as any;
  const late = new Promise<null>((ok) => win.setTimeout(() => ok(null), READER_MS));
  const article = await Promise.race([ReaderMode.parseDocument(doc), late]);
  return article?.textContent ? String(article.textContent).slice(0, BLOCKS_TEXT_MAX) : undefined;
}

/** What the document's channel says: response status and the addresses it was redirected from. */
function channelFacts(docShell: any): { status?: number; redirects?: string[] } {
  const out: { status?: number; redirects?: string[] } = {};
  try {
    const ch = docShell.currentDocumentChannel;
    try {
      out.status = ch.QueryInterface(Ci.nsIHttpChannel).responseStatus;
    } catch {}
    try {
      out.redirects = ch.loadInfo.redirectChain.map((e: any) => String(e.principal?.spec ?? "")).filter(Boolean);
    } catch {}
  } catch {}
  return out;
}

/**
 * The text of the PDF the built-in viewer shows, page by page; null for any other document. Only a PDF document is asked
 * (a web page could define a fake viewer to replace the text read), and never beyond PDF_READ_MS.
 */
async function pdfText(doc: Document, win: Window, max: number): Promise<string | null> {
  if (doc.contentType !== "application/pdf") return null;
  const pdf = (win as any).wrappedJSObject?.PDFViewerApplication?.pdfDocument;
  if (!pdf) return null;
  const pages: string[] = [];
  let length = 0;
  for (let i = 1; i <= Math.min(Number(pdf.numPages) || 0, PDF_PAGES_MAX) && length < max; i++) {
    const page = Cu.waiveXrays(await pdf.getPage(i));
    const content = Cu.waiveXrays(await page.getTextContent());
    const items = Array.prototype.slice.call(content.items, 0, max) as any[];
    const text = items.map((it) => String(it.str ?? "") + (it.hasEOL ? "\n" : "")).join("").slice(0, max - length);
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
          let shown: { text: string; links: { text: string; url: string; zone?: string }[]; blocks?: unknown[]; deep?: boolean };
          const capture = m.data?.capture === true;
          try {
            shown = readDisplayed(doc, TEXT_MAX, capture);
          } catch {
            // A page the walk cannot go through (nested far too deep): what innerText gives. No blocks: innerText
            // keeps the text a person cannot see, which the blocks exist to leave out.
            shown = { text: (doc.body?.innerText ?? "").slice(0, TEXT_MAX), links: collect(LINKS_MAX), ...(capture ? { blocks: [] } : {}) };
          }
          // The viewer's own text is only its rendered pages: the PDF itself has them all. Xray: the page's own timers cannot be swapped in.
          const late = new Promise<null>((ok) => win.setTimeout(() => ok(null), PDF_READ_MS));
          const pdf = await Promise.race([pdfText(doc, win, TEXT_MAX), late]).catch(() => null);
          const read = { text: pdf ?? shown.text, selection: String(win.getSelection() ?? ""), links: shown.links };
          if (!capture) return read;
          // The reader mode works on a copy without shadow roots nor frames: on such a page it would drop their text.
          const reader =
            pdf === null && !shown.deep && doc.getElementsByTagName("*").length <= READER_ELEMENTS_MAX ? await readerText(doc, win).catch(() => undefined) : undefined;
          const passwords = [...doc.querySelectorAll('input[type="password"]')].filter((i) => (i as any).checkVisibility?.({ opacityProperty: true, visibilityProperty: true })).length;
          return {
            ...read,
            ...(pdf === null && shown.blocks ? { blocks: shown.blocks } : {}),
            structured: structuredData(doc),
            ...(reader ? { reader } : {}),
            ...channelFacts(this.docShell),
            contentType: doc.contentType,
            passwords,
          };
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
