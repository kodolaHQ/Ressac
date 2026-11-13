import { unwrapLink, withoutHash } from "./links.js";

export const SEEN_MAX = 100_000;
const URL_MAX = 4096;

const web = (url: string) => url.length <= URL_MAX && URL.canParse(url) && /^https?:$/.test(new URL(url).protocol);

/**
 * Every web address the agent has read (pages and their links), kernel-wide, least recently used first. A recap may
 * only link to these. `has` is an exact match: dropping a fragment there would let `P#<data>` carry data out to a page P
 * already read.
 */
export class SeenUrls {
  /** Insertion order is recency: the first is the oldest. */
  private readonly urls = new Set<string>();

  add(urls: Iterable<string>): void {
    for (const url of urls) {
      if (!web(url)) continue;
      for (const form of new Set([url, withoutHash(url), unwrapLink(url)])) if (web(form)) this.touch(form);
    }
  }

  has(url: string): boolean {
    if (!this.urls.has(url)) return false;
    this.touch(url);
    return true;
  }

  private touch(url: string): void {
    this.urls.delete(url);
    this.urls.add(url);
    if (this.urls.size > SEEN_MAX) this.urls.delete(this.urls.values().next().value!);
  }
}
