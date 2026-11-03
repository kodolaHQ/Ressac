import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Session, WebContents } from "electron";
import { z } from "zod";
import type { Decision, Demande, IdOnglet, Issue, Permission } from "../commun/modele";
import { estInvisible } from "./contenus-invisibles";

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
  private enAttente = new Map<string, Promise<Issue>>();

  constructor(private readonly o: { fichier: string; demander: (d: Demande) => Promise<Issue> }) {
    this.memo = this.lire();
  }

  brancher(session: Session, ongletDe: (wc: WebContents | null) => IdOnglet | null = () => null): void {
    session.setPermissionRequestHandler((wc, permission, rappel, details) => {
      // Une lecture invisible (widget) partage la session du profil : tout lui est refusé, sans rien demander.
      if (estInvisible(wc)) return rappel(false);
      const origine = origineDe(details.requestingUrl);
      const mediaTypes = "mediaTypes" in details ? details.mediaTypes : undefined;
      const lienExterne = "externalURL" in details ? details.externalURL : undefined;
      if (!origine) return rappel(false);
      void this.traiter({ ongletId: ongletDe(wc), origine, permission, mediaTypes, lienExterne }).then(rappel, () => rappel(false));
    });
    session.setPermissionCheckHandler((wc, permission, origine, details) =>
      !estInvisible(wc) && this.verifier(origineDe(origine) ?? "", permission, "mediaType" in details ? details.mediaType : undefined),
    );
  }

  /** Répond à une demande de permission d'une page, en interrogeant l'utilisateur si besoin. */
  async traiter(r: {
    ongletId: IdOnglet | null;
    origine: string;
    permission: string;
    mediaTypes?: readonly string[];
    lienExterne?: string;
  }): Promise<boolean> {
    if (SANS_DEMANDE.has(r.permission)) return true;
    // Confier un lien à une autre application : demandé à chaque fois, avec le lien sous les yeux.
    if (r.permission === "openExternal") {
      if (!r.lienExterne) return false;
      const d = await this.o.demander({ ongletId: r.ongletId, origine: r.origine, permissions: ["ouvrir-application"], lien: r.lienExterne });
      return d === "autoriser";
    }
    const permissions = traduire(r.permission, r.mediaTypes);
    if (permissions.length === 0) return false;
    const inconnues = permissions.filter((p) => !this.memo[cle(r.origine, p)]);
    // Une question en attente par (origine, permission) : on ne redemande pas ce qu'un autre bandeau demande déjà.
    const nouvelles = inconnues.filter((p) => !this.enAttente.has(cle(r.origine, p)));
    if (nouvelles.length) {
      const reponse = this.o.demander({ ongletId: r.ongletId, origine: r.origine, permissions: nouvelles });
      for (const p of nouvelles) this.enAttente.set(cle(r.origine, p), reponse);
      const finir = () => nouvelles.forEach((p) => this.enAttente.delete(cle(r.origine, p)));
      void reponse.then((d) => {
        finir();
        // Retirée sans réponse (onglet fermé) : refusée cette fois, redemandée la prochaine.
        if (d === "retiree") return;
        for (const p of nouvelles) this.memo[cle(r.origine, p)] = d;
        this.ecrire();
      }, finir);
    }
    await Promise.all(inconnues.map((p) => this.enAttente.get(cle(r.origine, p))));
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

  /** Le profil de connexion est effacé (son fichier avec lui) : plus aucune décision en mémoire. */
  toutOublier(): void {
    this.memo = {};
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

/**
 * Session d'une appli lancée par l'agent (code non relu) : ce qu'un onglet a sans demander (ou moins, `permises`), rien
 * d'autre. Ni caméra, ni micro, ni position, ni notifications, ni périphériques (HID, série, USB), ni lien confié à une
 * autre application.
 */
export function refuserPermissions(session: Session, permises: ReadonlySet<string> = SANS_DEMANDE): void {
  session.setPermissionRequestHandler((_wc, permission, rappel) => rappel(permises.has(permission)));
  session.setPermissionCheckHandler((_wc, permission) => permises.has(permission));
  session.setDevicePermissionHandler(() => false);
  // Un choix de périphérique annulé : aucun n'est donné à la page.
  session.on("select-hid-device", (e, _d, rappel) => (e.preventDefault(), rappel()));
  session.on("select-serial-port", (e, _d, _wc, rappel) => (e.preventDefault(), rappel("")));
  session.on("select-usb-device", (e, _d, rappel) => (e.preventDefault(), rappel()));
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
