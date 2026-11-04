import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cleExtension,
  desactiverPartout,
  GARDES_PAR_DEFAUT,
  lireEtatExtensions,
  modifierEtatExtensions,
  porteeElargie,
  preparerCopie,
  retirer,
  type AnalyseManifeste,
  type EntreeExtension,
  type EtatExtensions,
  type Portee,
} from "../../../../packages/noyau/src/index.ts";
import { DESACTIVEE_PORTEE } from "../../../navigateur/src/commun/extensions-messages.ts";
import type { Rpc } from "../../shared/rpc.ts";
import { AMO_URL, CLES_ABSENTES, ErreurSignature, lireCleAmo, signatureImpossible, signer } from "./amo.ts";
import { addonIdDe, manifesteFirefox, prochaineVersion, refusFirefox, SUFFIXE_ID, zipper } from "./copie-firefox.ts";

// Keep in sync with apps/navigateur/src/main/extensions/agent.ts (texts and reperesDuChemin).
export const DOSSIER_ABSENT = "Dossier absent";
export const ACTIVATION_REFUSEE = "Activation refusée";
export const dossierAbsent = (id: string) => `${DOSSIER_ABSENT} : ~/WebAiOs/extensions/${id} n'existe plus (recrée-le, puis recharger_extension)`;
export const SANS_ACCORD = "Extension sans accord : demande d'abord son activation";

export type ResultatEnvoi = { ok: true; analyse: AnalyseManifeste } | { ok: false; erreur: string; refus?: string[] };

interface Repere {
  chemin: string;
  dev: number;
  ino: number;
}

/** Every element from the agent's extensions folder to `<id>` is a real directory (lstat), never a symbolic link. */
async function reperesDuChemin(dossierAgent: string, id: string): Promise<Repere[] | string> {
  const reperes: Repere[] = [];
  for (const chemin of [dossierAgent, join(dossierAgent, id)]) {
    let info;
    try {
      info = await lstat(chemin);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return DOSSIER_ABSENT;
      return `Dossier illisible : ${(e as Error).message}`;
    }
    if (info.isSymbolicLink()) return `Lien symbolique refusé : ${chemin}`;
    if (!info.isDirectory()) return chemin === dossierAgent ? DOSSIER_ABSENT : `Pas un dossier : ${chemin}`;
    reperes.push({ chemin, dev: info.dev, ino: info.ino });
  }
  return reperes;
}

const memesReperes = (a: Repere[], b: Repere[]) =>
  a.length === b.length && a.every((x, i) => x.chemin === b[i]!.chemin && x.dev === b[i]!.dev && x.ino === b[i]!.ino);

/** Decision 4: installed but disabled unless granted, active in a profile, not disabled, and not everything cut. */
const actifDans = (e: EtatExtensions, x: EntreeExtension | undefined) => !!x?.accord && x.profils.length > 0 && !x.desactivee && !e.toutesCoupees;

/**
 * The agent's extensions (registry `<dossier>/etat.json`, copies, signed .xpi), kept in the noyau host; the chrome
 * installs, enables, disables or uninstalls by RPC. One operation at a time per extension.
 */
export class ExtensionsAgent {
  private readonly files = new Map<string, Promise<unknown>>();
  private readonly arret = new AbortController();
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly o: { dossier: string; dossierAgent: string; rpc: Rpc; env?: NodeJS.ProcessEnv }) {
    this.env = o.env ?? process.env;
  }

  /** Startup (decision 5): leftovers deleted, every granted one recopied, signed again only if its source changed, then installed. */
  async demarrer(): Promise<void> {
    for (const [sous, reste] of [
      ["copies", /\.(tmp|ancienne|attente)$/],
      ["signes", /\.(attente|envoi)\.xpi$/],
    ] as const) {
      const noms = await readdir(join(this.o.dossier, sous)).catch(() => [] as string[]);
      for (const nom of noms) if (reste.test(nom)) await rm(join(this.o.dossier, sous, nom), { recursive: true, force: true }).catch(() => undefined);
    }
    const etat = await lireEtatExtensions(this.o.dossier);
    await Promise.all(
      Object.entries(etat.extensions).map(async ([cle, x]) => {
        if (x.source !== "agent" || !x.accord) return;
        try {
          const r = await this.preparerEtInstaller(cle.slice("agent:".length), { accord: x.accord, demarrage: true });
          if (!r.ok) console.warn(`[extensions] ${cle} au démarrage : ${r.erreur}`);
        } catch (e) {
          console.error(`[extensions] ${cle} non installée au démarrage :`, e);
        }
      }),
    );
  }

  /**
   * Copy, sign, install. The scope must stay within `accord` (broadened: disabled, grant kept). `demarrage`: an unchanged
   * source reinstalls the kept signed .xpi without sending anything. A failure before the install leaves the registry
   * and the running version untouched.
   */
  preparerEtInstaller(id: string, o: { accord: Portee; demarrage?: boolean }): Promise<ResultatEnvoi> {
    const cle = this.cle(id);
    if (!cle) return Promise.resolve({ ok: false, erreur: `Identifiant d'extension invalide : ${id}` });
    return this.enFile(cle, () => this.envoi(id, cle, o));
  }

  /** « Supprimer »: uninstalled, copy and signed .xpi deleted, registry entry removed; amo-versions.json kept (AMO never reuses a number). */
  supprimer(cle: string): Promise<void> {
    const id = this.id(cle);
    if (!id) return Promise.reject(new Error(`Identifiant d'extension invalide : ${cle}`));
    return this.enFile(cle, async () => {
      // Uninstalled first: an entry gone while the add-on stays installed would run without a grant.
      await this.o.rpc.request("extensions.desinstaller", { addonId: addonIdDe(id) });
      await this.modifier((e) => (cle in e.extensions ? retirer(e, cle) : e));
      for (const f of [join("copies", id), join("copies", `${id}.attente`), join("signes", `${id}.xpi`), join("signes", `${id}.json`)])
        await rm(join(this.o.dossier, f), { recursive: true, force: true });
    });
  }

  /** about:addons removed it (« Supprimer », grant deleted) or disabled it (« Désactiver partout ») (decision 6). */
  async horsWebaios(addonId: string, quoi: "desinstallee" | "desactivee"): Promise<void> {
    if (!addonId.endsWith(SUFFIXE_ID)) return;
    const cle = this.cle(addonId.slice(0, -SUFFIXE_ID.length));
    if (!cle || !(cle in (await lireEtatExtensions(this.o.dossier)).extensions)) return;
    if (quoi === "desinstallee") return this.supprimer(cle);
    await this.enFile(cle, () => this.modifier((e) => (cle in e.extensions ? desactiverPartout(e, cle) : e)));
  }

  /** Quitting: a signing in progress is dropped (its version number stays taken; the change is signed again at the next startup). */
  arreter(): void {
    this.arret.abort();
  }

  private cle(id: string): string | null {
    try {
      return cleExtension("agent", id);
    } catch {
      return null;
    }
  }

  private id(cle: string): string | null {
    return cle.startsWith("agent:") && this.cle(cle.slice("agent:".length)) === cle ? cle.slice("agent:".length) : null;
  }

  private enFile<T>(cle: string, f: () => Promise<T>): Promise<T> {
    const suivante = (this.files.get(cle) ?? Promise.resolve()).catch(() => {}).then(f);
    this.files.set(cle, suivante);
    void suivante
      .finally(() => {
        if (this.files.get(cle) === suivante) this.files.delete(cle);
      })
      .catch(() => {});
    return suivante;
  }

  // shortcut: private profiles are not known to the noyau yet (no agent extension is active in one), the space tasks pass them.
  private modifier(changer: (e: EtatExtensions) => EtatExtensions): Promise<EtatExtensions> {
    return modifierEtatExtensions(this.o.dossier, changer, () => new Set());
  }

  /** Enables or disables the installed add-on as the registry says (decision 4). */
  private async appliquer(id: string, cle: string): Promise<void> {
    const e = await lireEtatExtensions(this.o.dossier);
    await this.o.rpc.request("extensions.activer", { addonId: addonIdDe(id), actif: actifDans(e, e.extensions[cle]) });
  }

  private installer(id: string, xpi: string, version: string): Promise<{ version: string }> {
    return this.o.rpc.request("extensions.installer", { addonId: addonIdDe(id), xpi, temporaire: !!this.env.WEBAIOS_TEST_AMO_URL, version });
  }

  private async envoi(id: string, cle: string, o: { accord: Portee; demarrage?: boolean }): Promise<ResultatEnvoi> {
    const p = await this.preparer(id);
    if (!p.ok) {
      // As Electron: only a missing folder stops the running version.
      if (p.refus.includes(DOSSIER_ABSENT)) await this.o.rpc.request("extensions.activer", { addonId: addonIdDe(id), actif: false });
      return { ok: false, erreur: p.refus.map((r) => (r === DOSSIER_ABSENT ? dossierAbsent(id) : r)).join(" ; "), refus: p.refus };
    }
    const { analyse, empreinte, staging } = p;
    const effacer = () => rm(staging, { recursive: true, force: true });
    if (porteeElargie(o.accord, analyse.portee)) {
      await effacer();
      await this.modifier((e) => {
        const x = e.extensions[cle];
        if (!x || x.desactivee?.raison === "portee-elargie") return e;
        return { ...e, extensions: { ...e.extensions, [cle]: { ...x, desactivee: { raison: "portee-elargie", le: new Date().toISOString() } } } };
      });
      await this.appliquer(id, cle);
      return { ok: false, erreur: DESACTIVEE_PORTEE };
    }

    const signes = join(this.o.dossier, "signes");
    const final = join(signes, `${id}.xpi`);
    const garde = await readFile(join(signes, `${id}.json`), "utf8").then((t) => JSON.parse(t) as { version: string; empreinte: string }, () => null);
    let change = true;
    if (o.demarrage && garde?.empreinte === empreinte && (await lstat(final).then(() => true, () => false))) {
      await effacer();
      await this.installer(id, final, garde.version);
      change = false;
    } else {
      const r = await this.signerEtInstaller(id, p);
      if (!r.ok) {
        await effacer();
        return r;
      }
      await writeFile(join(signes, `${id}.json`), JSON.stringify({ version: r.version, empreinte }));
      const copie = join(this.o.dossier, "copies", id);
      await rm(copie, { recursive: true, force: true });
      await rename(staging, copie);
    }
    await this.modifier((e) => {
      const x = e.extensions[cle];
      if (!x?.accord) return e;
      const entree: EntreeExtension = {
        ...x,
        idChrome: addonIdDe(id),
        nom: analyse.nom,
        version: analyse.version,
        modifieeLe: change || !x.modifieeLe ? new Date().toISOString() : x.modifieeLe,
        // Back within its grant: it runs again. Not after crashes (re-enabled by hand).
        desactivee: x.desactivee?.raison === "portee-elargie" && !porteeElargie(x.accord, analyse.portee) ? null : x.desactivee,
      };
      return { ...e, extensions: { ...e.extensions, [cle]: entree } };
    });
    await this.appliquer(id, cle);
    return { ok: true, analyse };
  }

  /** prochaineVersion → manifesteFirefox → zipper → signer (signes/<id>.attente.xpi) → extensions.installer → signes/<id>.xpi. */
  private async signerEtInstaller(id: string, p: { staging: string; fondOriginal: string | undefined }): Promise<{ ok: true; version: string } | { ok: false; erreur: string }> {
    const cleAmo = await lireCleAmo(this.env);
    if (!cleAmo) return { ok: false, erreur: CLES_ABSENTES };
    const n = await prochaineVersion(this.o.dossier, id);
    const chemin = join(p.staging, "manifest.json");
    const manifeste = manifesteFirefox(JSON.parse(await readFile(chemin, "utf8")), id, n, p.fondOriginal);
    await writeFile(chemin, JSON.stringify(manifeste, null, 2));
    const version = String(manifeste.version);
    const signes = join(this.o.dossier, "signes");
    const envoi = join(signes, `${id}.envoi.xpi`);
    const attente = join(signes, `${id}.attente.xpi`);
    await mkdir(signes, { recursive: true });
    try {
      await zipper(p.staging, envoi);
      await signer({ xpi: envoi, guid: addonIdDe(id), version, cle: cleAmo, base: this.env.WEBAIOS_TEST_AMO_URL || AMO_URL, sortie: attente, signal: this.arret.signal });
    } catch (e) {
      await rm(attente, { force: true });
      return { ok: false, erreur: e instanceof ErreurSignature ? e.message : signatureImpossible((e as Error).message) };
    } finally {
      await rm(envoi, { force: true });
    }
    try {
      await this.installer(id, attente, version);
    } catch (e) {
      await rm(attente, { force: true });
      return { ok: false, erreur: (e as Error).message };
    }
    await rename(attente, join(signes, `${id}.xpi`));
    return { ok: true, version };
  }

  /**
   * The controlled copy of `<dossierAgent>/<id>` in `copies/<id>.attente` (as Electron's preparerAgent: path without
   * links, checked before and after), plus the Firefox refusals. A refusal leaves no staging copy.
   */
  private async preparer(
    id: string,
  ): Promise<{ ok: true; analyse: AnalyseManifeste; empreinte: string; staging: string; fondOriginal: string | undefined } | { ok: false; refus: string[] }> {
    const staging = join(this.o.dossier, "copies", `${id}.attente`);
    const refuser = async (refus: string[]) => (await rm(staging, { recursive: true, force: true }), { ok: false as const, refus });
    await rm(staging, { recursive: true, force: true });
    const avant = await reperesDuChemin(this.o.dossierAgent, id);
    if (typeof avant === "string") return { ok: false, refus: [avant] };
    let reelAvant: string;
    try {
      reelAvant = await realpath(this.o.dossierAgent);
    } catch (e) {
      return { ok: false, refus: [`Dossier illisible : ${(e as Error).message}`] };
    }
    let r: Awaited<ReturnType<typeof preparerCopie>>;
    try {
      await mkdir(join(this.o.dossier, "copies"), { recursive: true });
      r = await preparerCopie({ source: join(this.o.dossierAgent, id), cible: staging, dossierGardes: GARDES_PAR_DEFAUT });
    } catch (e) {
      return refuser([`Copie impossible : ${(e as Error).message}`]);
    }
    const apres = await reperesDuChemin(this.o.dossierAgent, id);
    const reelApres = await realpath(this.o.dossierAgent).catch(() => "");
    if (typeof apres === "string" || !memesReperes(avant, apres) || reelApres !== reelAvant)
      return refuser([typeof apres === "string" ? apres : "Dossier remplacé pendant la copie"]);
    const lu = avant[1]!;
    if (r.racine && (r.racine.chemin !== join(reelAvant, id) || r.racine.dev !== lu.dev || r.racine.ino !== lu.ino)) return refuser(["Dossier remplacé pendant la copie"]);
    if (r.analyse.refus.length > 0) return refuser(r.analyse.refus);
    try {
      const manifeste = JSON.parse(await readFile(join(staging, "manifest.json"), "utf8"));
      const refus = refusFirefox(manifeste, await readdir(staging, { recursive: true }));
      if (refus.length > 0) return refuser(refus);
      // The original classic background, read from the copy's own generated webaios-fond.js (never the agent's folder again).
      const fond = /^importScripts\("webaios-garde-fond\.js", ("(?:[^"\\]|\\.)*")\);$/m.exec(await readFile(join(staging, "webaios-fond.js"), "utf8"));
      return { ok: true, analyse: r.analyse, empreinte: r.empreinte, staging, fondOriginal: fond ? (JSON.parse(fond[1]!) as string) : undefined };
    } catch (e) {
      return refuser([`Copie impossible : ${(e as Error).message}`]);
    }
  }
}
