import { grantStrengthened, scopeHash, scopeLabels, type ManifestAnalysis } from "../../../../packages/noyau/src/index.ts";
import type { CarteExtension } from "../../shared/extensions.ts";
import type { Space } from "../../shared/modele.ts";

/** The grant card of an agent extension, to activate it in `espace` (pure). */
export function carteDe(
  a: ManifestAnalysis,
  o: { cle: string; espace: Space; espaces: Space[]; maj?: { de: string }; remplaceAussi?: string[] },
): CarteExtension {
  const p = a.portee;
  return {
    cle: o.cle,
    nom: a.nom,
    source: "agent",
    version: a.version,
    droits: scopeLabels(p, "agent"),
    sites: [...p.hotes],
    tousLesSites: p.tousLesSites,
    reseau: [...p.reseau],
    renforce: grantStrengthened(p, "agent"),
    espace: o.espace.nom,
    espaceId: o.espace.id,
    autresEspaces: o.espaces.filter((e) => e.profil === o.espace.profil && e.id !== o.espace.id).map((e) => e.nom),
    remplaceAussi: [...(o.remplaceAussi ?? [])],
    maj: o.maj ? { de: o.maj.de } : null,
    empreinte: scopeHash(p),
  };
}

// Shown on the Extensions page as « Non pris en charge ».
const UNSUPPORTED_RIGHTS = ["activeTab", "nativeMessaging", "userScripts", "sidePanel", "identity", "tabCapture", "desktopCapture", "pageCapture", "debugger", "proxy", "ttsEngine", "tts"];
const KEYS_NOT_TAKEN: Record<string, string> = { side_panel: "sidePanel", devtools_page: "devtools_page", omnibox: "omnibox", chrome_url_overrides: "chrome_url_overrides" };

/** What the manifest asks for that WebAiOs does not support, in list order, without duplicates (pure). */
export function unsupported(manifest: unknown): string[] {
  if (typeof manifest !== "object" || manifest === null) return [];
  const m = manifest as Record<string, unknown>;
  const droits = new Set<string>();
  for (const champ of ["permissions", "optional_permissions"])
    if (Array.isArray(m[champ])) for (const d of m[champ] as unknown[]) if (typeof d === "string") droits.add(d);
  const r: string[] = UNSUPPORTED_RIGHTS.filter((d) => droits.has(d));
  for (const [key, name] of Object.entries(KEYS_NOT_TAKEN)) if (Object.hasOwn(m, key) && !r.includes(name)) r.push(name);
  return r;
}
