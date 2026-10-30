// Le réseau des extensions de l'agent, fermé par défaut (spec §5, plan 12 tâche 12).
//
// Branche B (aucun `session.webRequest`) : la CSP imposée à la copie (`connect-src 'self' https://<reseau>`, noyau
// `cspAgent`) suffit ; Electron 45 l'applique au service worker comme aux pages (mesuré : fetch, WebSocket, sendBeacon
// bloqués). La tâche 1 avait choisi la branche A (un `onBeforeRequest` par session de profil, vérification par
// l'initiateur), mais la tâche 12 a mesuré qu'un seul écouteur `session.webRequest` sur une session y coupe tout
// `declarativeNetRequest` (règles statiques, dynamiques, de session : celles du Store comme celles de l'agent) : il
// « coupe » donc quelque chose, ce qui, selon le plan, mène à la branche B. Voir
// docs/superpowers/notes/2026-10-29-essai-webrequest.md (section « Tâche 12 »).
// S'y ajoutent : navigations et ouvertures de ses pages (`brancherPagesAgent`), et les adresses que ses appels à
// `tabs.create`, `tabs.update`, `windows.create` ouvrent (`urlPermiseAgent`, crochets du correctif de la bibliothèque
// et garde webaios-garde-fond.js).
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { app, type WebContents } from "electron";
import type { Portee } from "@webaios/noyau";

export const URL_REFUSEE = "URL refusée par WebAiOs";

/** Accord d'une extension de l'agent par son id Chromium ; null : agent sans accord ; undefined : pas de l'agent. */
export type AccordAgentDe = (idChrome: string) => Portee | null | undefined;

/**
 * L'id que Chromium donne à une extension non empaquetée chargée sans `key` (les copies de l'agent) : SHA-256 du chemin
 * absolu réel, 32 premiers chiffres hexadécimaux écrits de `a` à `p`. Connu avant le chargement : le service worker peut
 * appeler `tabs.create` avant que `loadExtension` ne rende, et ne doit pas passer alors pour une extension du Store.
 */
export function idChromeDeDossier(chemin: string): string {
  let reel: string;
  try {
    reel = realpathSync(chemin);
  } catch {
    reel = resolve(chemin);
  }
  const hex = createHash("sha256").update(reel).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

function lire(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** `*` d'un chemin de motif : n'importe quelle suite de caractères. */
function cheminCouvre(motif: string, chemin: string): boolean {
  const re = new RegExp("^" + motif.split("*").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(chemin);
}

/**
 * Un motif d'hôte de Chrome (`<all_urls>`, `*://*.exemple.com/*`, `https://exemple.com/chemin*`) couvre-t-il cette
 * adresse http(s) ? Sans port dans le motif, tout port est couvert (comme Chrome).
 */
export function motifCouvre(motif: string, u: URL): boolean {
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (motif === "<all_urls>") return true;
  const m = /^(\*|https?|wss?):\/\/([^/]*)(\/.*)$/.exec(motif);
  if (!m) return false;
  const [, schema, hoteMotif, cheminMotif] = m as unknown as [string, string, string, string];
  if (schema !== "*" && `${schema}:` !== u.protocol) return false;
  const [hote, port] = hoteMotif.split(/:(?=[^:\]]*$)/) as [string, string | undefined];
  if (port !== undefined && port !== "*" && port !== (u.port || (u.protocol === "https:" ? "443" : "80"))) return false;
  const h = u.hostname.toLowerCase();
  const voulu = hote.toLowerCase();
  if (voulu !== "*") {
    if (voulu.startsWith("*.")) {
      const base = voulu.slice(2);
      if (h !== base && !h.endsWith("." + base)) return false;
    } else if (h !== voulu) return false;
  }
  return cheminCouvre(cheminMotif, u.pathname + u.search);
}

/** Un hôte de `accord.reseau` (nom exact). */
function dansReseau(u: URL, accord: Portee): boolean {
  return accord.reseau.includes(u.hostname.toLowerCase());
}

/**
 * Une adresse qu'une extension de l'agent peut ouvrir (onglet, fenêtre, navigation de ses pages) : une page
 * `chrome-extension://` d'elle-même, ou http(s) vers un hôte de `accord.reseau` ou couvert par `accord.hotes`. Tout le
 * reste est refusé (`data:`, `javascript:`, `file:`, `blob:`, une autre extension…).
 */
export function urlPermiseAgent(url: string, accord: Portee, idChrome: string): boolean {
  const u = lire(url);
  if (!u) return false;
  if (u.protocol === "chrome-extension:") return u.host === idChrome;
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  return dansReseau(u, accord) || accord.hotes.some((m) => motifCouvre(m, u));
}

/** L'onglet à l'adresse `url` est-il un site des hôtes accordés (scripts, CSS) ? */
export function hotePermisAgent(url: string, accord: Portee): boolean {
  const u = lire(url);
  return !!u && accord.hotes.some((m) => motifCouvre(m, u));
}

/** L'id d'extension d'une origine ou d'une adresse `chrome-extension://<id>/…`, sinon null. */
export function idExtensionDe(origine: string | undefined): string | null {
  if (!origine || !origine.startsWith("chrome-extension://")) return null;
  return lire(origine)?.host || null;
}

const RTC_POLITIQUE = "disable_non_proxied_udp";

/**
 * Pages d'une extension de l'agent (popup, onglet, toute vue dont le cadre principal est `chrome-extension://<id agent>`) :
 * navigations (`will-navigate`, `will-frame-navigate`) refusées hors `urlPermiseAgent`, ouvertures de fenêtre refusées
 * (elles passent par `chrome.tabs.create`), WebRTC sans UDP direct. Le gestionnaire d'ouverture posé ensuite par
 * WebAiOs (onglets) reste en place pour les autres pages : il est enveloppé, pas remplacé.
 */
export function equiperPagesAgent(wc: WebContents, accordDe: AccordAgentDe): void {
  const accordDePage = (url: string): { id: string; accord: Portee | null } | null => {
    const id = idExtensionDe(url);
    if (!id) return null;
    const accord = accordDe(id);
    return accord === undefined ? null : { id, accord };
  };
  const permise = (page: { id: string; accord: Portee | null }, url: string) => !!page.accord && urlPermiseAgent(url, page.accord, page.id);

  const poser = wc.setWindowOpenHandler.bind(wc);
  type Gestionnaire = Parameters<WebContents["setWindowOpenHandler"]>[0];
  const envelopper =
    (g: Gestionnaire): Gestionnaire =>
    (details) =>
      accordDePage(wc.getURL()) ? { action: "deny" } : g(details);
  let gestionnairePose = false;
  wc.setWindowOpenHandler = (g: Gestionnaire) => {
    gestionnairePose = true;
    poser(envelopper(g));
  };

  wc.on("will-navigate", (e, url) => {
    const page = accordDePage(wc.getURL());
    if (page && !permise(page, url)) e.preventDefault();
  });
  wc.on("will-frame-navigate", (e) => {
    let cadre: string | undefined;
    try {
      cadre = e.frame?.url;
    } catch {
      cadre = undefined;
    }
    const page = accordDePage(wc.getURL()) ?? (cadre ? accordDePage(cadre) : null);
    if (page && !permise(page, e.url)) e.preventDefault();
  });
  let politiquePosee = false;
  wc.on("did-start-navigation", (d) => {
    if (!d.isMainFrame || d.isSameDocument) return;
    const agent = !!accordDePage(d.url);
    // Une vue sans gestionnaire d'ouverture (popup d'action de la bibliothèque) en reçoit un : refus pour ses pages.
    if (agent && !gestionnairePose) wc.setWindowOpenHandler(() => ({ action: "allow" }));
    if (agent && !politiquePosee) {
      wc.setWebRTCIPHandlingPolicy(RTC_POLITIQUE);
      politiquePosee = true;
    } else if (!agent && politiquePosee) {
      wc.setWebRTCIPHandlingPolicy("default");
      politiquePosee = false;
    }
  });
}

let pagesBranchees = false;

/** Équipe chaque vue créée ensuite (`equiperPagesAgent`) ; une fois par processus. */
export function brancherPagesAgent(accordDe: AccordAgentDe): void {
  if (pagesBranchees) return;
  pagesBranchees = true;
  app.on("web-contents-created", (_e, wc) => equiperPagesAgent(wc, accordDe));
}
