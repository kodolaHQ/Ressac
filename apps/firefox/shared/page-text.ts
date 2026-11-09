export function isYoutubeVideo(url: string): boolean {
  try {
    const u = new URL(url);
    return /^((www|m)\.)?youtube\.com$/.test(u.hostname) && u.pathname === "/watch";
  } catch {
    return false;
  }
}

/** What the page actor reads. */
export interface PageParts {
  description?: string;
  corps: string;
  video?: { titre?: string; chaine?: string; description?: string };
}

/** The retained text of a page: its non-empty parts, separated by a blank line. */
export function composeText(p: PageParts): string {
  const parts = p.video ? [p.video.titre, p.video.chaine, p.video.description] : [p.description, p.corps];
  return parts
    .map((s) => s?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n");
}
