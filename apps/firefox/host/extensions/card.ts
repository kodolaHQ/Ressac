import { grantStrengthened, scopeHash, scopeLabels, type ManifestAnalysis } from "../../../../packages/kernel/src/index.ts";
import type { ExtensionCard } from "../../shared/extensions.ts";
import type { Space } from "../../shared/model.ts";

/** The grant card of an agent extension, to activate it in `espace` (pure). */
export function cardOf(
  a: ManifestAnalysis,
  o: { key: string; space: Space; spaces: Space[]; update?: { from: string }; alsoReplaces?: string[] },
): ExtensionCard {
  const p = a.scope;
  return {
    key: o.key,
    name: a.name,
    source: "agent",
    version: a.version,
    rights: scopeLabels(p, "agent"),
    sites: [...p.hosts],
    allSites: p.allSites,
    network: [...p.network],
    hardened: grantStrengthened(p, "agent"),
    space: o.space.name,
    spaceId: o.space.id,
    otherSpaces: o.spaces.filter((e) => e.profile === o.space.profile && e.id !== o.space.id).map((e) => e.name),
    alsoReplaces: [...(o.alsoReplaces ?? [])],
    update: o.update ? { from: o.update.from } : null,
    hash: scopeHash(p),
  };
}

// Shown on the Extensions page as « Non pris en charge ».
const UNSUPPORTED_RIGHTS = ["activeTab", "nativeMessaging", "userScripts", "sidePanel", "identity", "tabCapture", "desktopCapture", "pageCapture", "debugger", "proxy", "ttsEngine", "tts"];
const KEYS_NOT_TAKEN: Record<string, string> = { side_panel: "sidePanel", devtools_page: "devtools_page", omnibox: "omnibox", chrome_url_overrides: "chrome_url_overrides" };

/** What the manifest asks for that Ressac does not support, in list order, without duplicates (pure). */
export function unsupported(manifest: unknown): string[] {
  if (typeof manifest !== "object" || manifest === null) return [];
  const m = manifest as Record<string, unknown>;
  const rights = new Set<string>();
  for (const field of ["permissions", "optional_permissions"])
    if (Array.isArray(m[field])) for (const d of m[field] as unknown[]) if (typeof d === "string") rights.add(d);
  const r: string[] = UNSUPPORTED_RIGHTS.filter((d) => rights.has(d));
  for (const [key, name] of Object.entries(KEYS_NOT_TAKEN)) if (Object.hasOwn(m, key) && !r.includes(name)) r.push(name);
  return r;
}
