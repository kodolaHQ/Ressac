import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { downloadExtensionFromURL } from "electron-chrome-web-store";

export const ERREUR_STORE = "Le Chrome Web Store n'a pas fourni l'extension (réseau coupé, ou le Store a changé sa façon de les servir)";
export const CRX_INVALIDE = "Fichier d'extension invalide ou mal signé : installation refusée";

/** Adresse du CRX3 d'une extension du Store ; en test, le faux Store local de `WEBAIOS_TEST_STORE_URL`. */
export function urlCrx(id: string): string {
  const test = process.env.WEBAIOS_TEST_STORE_URL;
  if (test) return `${test.replace(/\/+$/, "")}/${id}.crx`;
  const x = encodeURIComponent(`id=${id}&uc`);
  return `https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx3&prodversion=${process.versions.chrome ?? ""}&x=${x}`;
}

/** Codes d'erreur de Node pour un réseau coupé ou un serveur injoignable. */
const CODES_RESEAU = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);

/** Vrai si l'échec vient du téléchargement (réseau, HTTP), pas du fichier reçu. */
function erreurReseau(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.message === "Failed to download extension") return true; // réponse HTTP non 2xx (bibliothèque)
  if (e instanceof TypeError && /^(fetch failed|terminated)$/.test(e.message)) return true; // fetch de Node
  const code = (e as { code?: unknown }).code ?? (e.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && CODES_RESEAU.has(code);
}

/**
 * Télécharge, vérifie (signature CRX3, identifiant attendu) et décompresse une extension du Store dans
 * `<dossier>/<id>/<version>_0`, dont le chemin est rendu. Un échec lève `ERREUR_STORE` (réseau, HTTP) ou
 * `CRX_INVALIDE` (tout le reste : signature, format, identifiant, manifeste), le détail en `cause`, et ne laisse
 * rien de nouveau dans `<dossier>/<id>/` (les versions déjà là restent).
 */
export async function telechargerStore(id: string, dossier: string, url?: string): Promise<string> {
  const dossierId = join(dossier, id);
  const avant = existsSync(dossierId) ? new Set(readdirSync(dossierId)) : null;
  try {
    return await downloadExtensionFromURL(url ?? urlCrx(id), dossier, id);
  } catch (e) {
    nettoyer(dossierId, avant);
    throw new Error(erreurReseau(e) ? ERREUR_STORE : CRX_INVALIDE, { cause: e });
  }
}

/** Retire ce que la bibliothèque a laissé (dossier temporaire `<id>/<uuid>`) sans toucher aux versions d'avant. */
function nettoyer(dossierId: string, avant: Set<string> | null): void {
  if (!existsSync(dossierId)) return;
  if (avant === null) return void rmSync(dossierId, { recursive: true, force: true });
  for (const nom of readdirSync(dossierId)) if (!avant.has(nom)) rmSync(join(dossierId, nom), { recursive: true, force: true });
}
