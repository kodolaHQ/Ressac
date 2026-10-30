import { accordRenforce, empreintePortee, libellesPortee, type AnalyseManifeste, type SourceExtension } from "@webaios/noyau";
import type { Espace, EtatNavigateur } from "./modele";

/** Réponse à une saisie qui n'est ni un id d'extension, ni l'adresse de sa page du Chrome Web Store. */
export const SAISIE_INVALIDE = "Adresse ou identifiant du Chrome Web Store attendu";

// Dans un module sans dépendance au noyau : l'interface les importe (le noyau n'entre pas dans son bundle).
export { CONSOLE_DEBLOQUEE_PAGE, DESACTIVEE_PLANTAGES, DESACTIVEE_PORTEE, LONGUEUR_RAISON_DEBLOCAGE, texteDeblocageConsole } from "./extensions-messages";

/** Une ligne de la section « Extensions » des réglages d'un espace (tout y est affiché en texte). */
export interface LigneExtensionEspace {
  cle: string;
  nom: string;
  source: "store" | "agent";
  /** Active dans le profil de cet espace. */
  active: boolean;
  /** Si active : les noms des autres espaces du même profil, où elle tourne aussi. */
  aussiDans: string[];
  /** Non null : l'interrupteur est désactivé, et cette phrase dit pourquoi. */
  grisee: string | null;
  /** Les profils où elle est active (pour prévenir de ce que change un espace privé). */
  profils: string[];
}

/** Ce que montre la carte d'accord d'une extension (DemandeExtension.svelte) : tout y est affiché en texte. */
export interface CarteExtension {
  cle: string;
  nom: string;
  source: SourceExtension;
  version: string;
  /** Libellés de la portée (`libellesPortee`), dans leur ordre. */
  droits: string[];
  sites: string[];
  tousLesSites: boolean;
  /** Agent : domaines où elle peut envoyer (`[]` : nulle part) ; Store : null. */
  reseau: string[] | null;
  /** Accord renforcé : une case à cocher avant « Activer ». */
  renforce: boolean;
  /** Nom de l'espace où elle est activée. */
  espace: string;
  /** Son id : la carte tombe si l'espace disparaît (ou, pour l'agent, si son profil devient privé). */
  espaceId: string;
  /** Les autres espaces du même profil, où elle sera active aussi. */
  autresEspaces: string[];
  /** Mise à jour : la version installée. */
  maj: { de: string } | null;
  /** `empreintePortee` de la portée montrée : l'appelant n'écrit l'accord que pour une portée de même empreinte. */
  empreinte: string;
}

/** Réponse de la carte : `empreinte` est celle de la portée montrée (la première carte, si la demande l'a rejointe). */
export interface ReponseAccord {
  accepte: boolean;
  empreinte: string;
}

/** La carte d'accord d'une extension analysée, pour l'activer dans `espace` (pur). */
export function carteDe(
  a: AnalyseManifeste,
  o: { cle: string; source: SourceExtension; espace: Espace; etat: EtatNavigateur; maj?: { de: string } },
): CarteExtension {
  const p = a.portee;
  return {
    cle: o.cle,
    nom: a.nom,
    source: o.source,
    version: a.version,
    droits: libellesPortee(p, o.source),
    sites: [...p.hotes],
    tousLesSites: p.tousLesSites,
    reseau: o.source === "agent" ? [...p.reseau] : null,
    // Plus large que la règle « scripts sur tous les sites » : `scripting` avec un accès à tous les sites injecte partout.
    renforce: accordRenforce(p, o.source),
    espace: o.espace.nom,
    espaceId: o.espace.id,
    autresEspaces: o.etat.espaces.filter((e) => e.profil === o.espace.profil && e.id !== o.espace.id).map((e) => e.nom),
    maj: o.maj ? { de: o.maj.de } : null,
    empreinte: empreintePortee(p),
  };
}

/** Une ligne de la page Extensions (tout y est affiché en texte : c'est de la donnée venue d'un manifeste ou d'une console). */
export interface LigneExtension {
  cle: string;
  nom: string;
  source: SourceExtension;
  version: string;
  /** Libellés de la portée accordée (`libellesPortee`). */
  droits: string[];
  sites: string[];
  tousLesSites: boolean;
  /** Les espaces dont le profil l'a active. */
  espaces: { nom: string; profil: string }[];
  /** Erreurs de préparation, de chargement, de mise à jour, et erreurs de sa console. */
  erreurs: string[];
  /** Agent : dernière copie rechargée (ISO). */
  modifieeLe: string | null;
  /** Le message de sa désactivation (`DESACTIVEE_PLANTAGES`, `DESACTIVEE_PORTEE`), ou null. */
  desactivee: string | null;
  /** Store : la version d'une mise à jour qui attend l'accord de l'utilisateur. */
  majEnAttente: string | null;
  /** Droits et clés du manifeste que WebAiOs ne prend pas en charge. */
  nonPrisEnCharge: string[];
  epinglee: boolean;
  /** Agent : L'utilisateur a débloqué sa console pour l'agent (en mémoire, jusqu'à ce que l'un d'eux la referme). */
  consoleDebloquee: boolean;
}

/** La barre d'une fenêtre : les extensions chargées dans le profil de son espace actif. */
export interface BarreExtensions {
  /** Partition de la session du profil (attribut `partition` des `<button is="browser-action">`). */
  partition: string;
  /** Id de l'onglet affiché pour la bibliothèque (son `webContents.id`), ou null. */
  onglet: number | null;
  actions: { cle: string; idChrome: string; nom: string; epinglee: boolean }[];
}

/** Droits du manifeste que WebAiOs ne prend pas en charge (Electron ou WebAiOs ne les fournissent pas). */
const DROITS_NON_PRIS = ["activeTab", "nativeMessaging", "userScripts", "sidePanel", "identity", "tabCapture", "desktopCapture", "pageCapture", "debugger", "proxy", "ttsEngine", "tts"];
/** Clés du manifeste sans effet dans WebAiOs, et le nom montré. */
const CLES_NON_PRISES: Record<string, string> = { side_panel: "sidePanel", devtools_page: "devtools_page", omnibox: "omnibox", chrome_url_overrides: "chrome_url_overrides" };

/** Ce que le manifeste demande et que WebAiOs ne prend pas en charge, dans l'ordre des listes, sans doublon (pur). */
export function nonPrisEnCharge(manifeste: unknown): string[] {
  if (typeof manifeste !== "object" || manifeste === null) return [];
  const m = manifeste as Record<string, unknown>;
  const droits = new Set<string>();
  for (const champ of ["permissions", "optional_permissions"])
    if (Array.isArray(m[champ])) for (const d of m[champ] as unknown[]) if (typeof d === "string") droits.add(d);
  const r: string[] = DROITS_NON_PRIS.filter((d) => droits.has(d));
  for (const [cle, nom] of Object.entries(CLES_NON_PRISES)) if (Object.hasOwn(m, cle) && !r.includes(nom)) r.push(nom);
  return r;
}
