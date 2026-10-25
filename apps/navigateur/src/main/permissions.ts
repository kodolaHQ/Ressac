import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Session, WebContents } from "electron";
import { z } from "zod";
import type { Decision, Demande, IdOnglet, Permission } from "../commun/modele";

export type { Decision, Demande, Permission };

const SANS_DEMANDE = new Set<string>(["fullscreen", "clipboard-sanitized-write"]);
const A_DEMANDER = new Set<string>(["notifications", "geolocation"]);
const SchemaFichier = z.record(z.string(), z.enum(["autoriser", "refuser"]));

/** Traduit une permission Electron en permissions WebAiOs ; [] = inconnue. */
function traduire(permission: string, mediaTypes: readonly string[] = []): Permission[] {
  if (permission === "media") {
    const p: Permission[] = [];
    if (mediaTypes.includes("video")) p.push("media-camera");
    if (mediaTypes.includes("audio")) p.push("media-micro");
    return p;
  }
  return A_DEMANDER.has(permission) ? [permission as Permission] : [];
}

/** Autorisations des sites : demandées une fois par (origine, permission), mémorisées dans `permissions.json`. */
export class Permissions {
  private memo: Record<string, Decision>;
  private enAttente = new Map<string, Promise<Decision>>();

  constructor(private readonly o: { fichier: string; demander: (d: Demande) => Promise<Decision> }) {
    this.memo = this.lire();
  }

  brancher(session: Session, ongletDe: (wc: WebContents | null) => IdOnglet | null = () => null): void {
    session.setPermissionRequestHandler((wc, permission, rappel, details) => {
      const origine = origineDe(details.requestingUrl);
      const mediaTypes = "mediaTypes" in details ? details.mediaTypes : undefined;
      if (!origine) return rappel(false);
      void this.traiter({ ongletId: ongletDe(wc), origine, permission, mediaTypes }).then(rappel, () => rappel(false));
    });
    session.setPermissionCheckHandler((_wc, permission, origine, details) =>
      this.verifier(origineDe(origine) ?? "", permission, "mediaType" in details ? details.mediaType : undefined),
    );
  }

  /** Répond à une demande de permission d'une page, en interrogeant l'utilisateur si besoin. */
  async traiter(r: { ongletId: IdOnglet | null; origine: string; permission: string; mediaTypes?: readonly string[] }): Promise<boolean> {
    if (SANS_DEMANDE.has(r.permission)) return true;
    const permissions = traduire(r.permission, r.mediaTypes);
    if (permissions.length === 0) return false;
    const inconnues = permissions.filter((p) => !this.memo[cle(r.origine, p)]);
    if (inconnues.length) {
      const question = cle(r.origine, inconnues.join("+"));
      let reponse = this.enAttente.get(question);
      if (!reponse) {
        reponse = this.o.demander({ ongletId: r.ongletId, origine: r.origine, permissions: inconnues });
        this.enAttente.set(question, reponse);
        void reponse.then(
          (d) => {
            for (const p of inconnues) this.memo[cle(r.origine, p)] = d;
            this.enAttente.delete(question);
            this.ecrire();
          },
          () => this.enAttente.delete(question),
        );
      }
      await reponse;
    }
    return permissions.every((p) => this.memo[cle(r.origine, p)] === "autoriser");
  }

  /** Vérification synchrone (sans demande) : d'après les décisions mémorisées. */
  verifier(origine: string, permission: string, mediaType?: string): boolean {
    if (SANS_DEMANDE.has(permission)) return true;
    const permissions = traduire(permission, mediaType ? [mediaType] : []);
    return permissions.length > 0 && permissions.every((p) => this.memo[cle(origine, p)] === "autoriser");
  }

  decisions(): Record<string, Decision> {
    return { ...this.memo };
  }

  oublier(origine: string): void {
    for (const k of Object.keys(this.memo)) if (k.startsWith(`${origine} `)) delete this.memo[k];
    this.ecrire();
  }

  private lire(): Record<string, Decision> {
    let brut: string;
    try {
      brut = readFileSync(this.o.fichier, "utf8");
    } catch {
      return {};
    }
    try {
      const r = SchemaFichier.safeParse(JSON.parse(brut));
      if (r.success) return r.data;
    } catch {
      // JSON illisible : traité comme un fichier invalide ci-dessous.
    }
    console.warn(`[permissions] ${this.o.fichier} invalide : aucune décision chargée`);
    return {};
  }

  private ecrire(): void {
    mkdirSync(dirname(this.o.fichier), { recursive: true });
    const tmp = `${this.o.fichier}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.memo, null, 2));
    renameSync(tmp, this.o.fichier);
  }
}

const cle = (origine: string, permission: string) => `${origine} ${permission}`;

function origineDe(url: string): string | null {
  try {
    const o = new URL(url).origin;
    return o === "null" ? null : o;
  } catch {
    return null;
  }
}
