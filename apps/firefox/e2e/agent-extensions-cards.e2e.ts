import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Action } from "../../navigateur/src/commun/api";
import { ecrireExtensionAgent } from "../../navigateur/e2e/extensions/fixtures";
import { signatureRefusee } from "../noyau/extensions/amo";
import { agentAddons, launchWithAmo } from "./agent-extensions";
import { dispatch, newWindow, state, waitFor, waitWindowCount } from "./firefox";
import type { LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { callTool } from "./mcp";
import { click, inUi, pressKeys, waitUi } from "./ui";

// Ported from Electron's extensions-agent.spec.ts (the agent's tools and their card) and extensions-interface.spec.ts
// (the card itself, posed straight through the store's Questions; its answer is written to a file).
const MODALE = '[data-testid="modale-demande"]';
const CARTE = '[data-testid="demande-extension"]';
const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const HOTE = "http://127.0.0.1/*";
const ERREUR_PROFIL_PRIVE = "Donne à cet espace privé son propre profil pour y utiliser des extensions de l'agent";
const FOND_SEUL = {
  "manifest.json": { manifest_version: 3, name: "Fond de l'agent", version: "1.0.0", background: { service_worker: "fond.js" } },
  "fond.js": 'console.log("fond démarré");\n',
};
const cacheur = (matches: string[]) => ({ manifest_version: 3, name: "Cacheur de l'agent", version: "1.0.0", content_scripts: [{ matches, css: ["cache.css"] }] });

const dirs: string[] = [];
const opened: LaunchedWebAiOs[] = [];
afterEach(async () => {
  for (const w of opened.splice(0)) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** WebAiOs with the fake AMO, the agent's session started (a new conversation takes down the cards asked before it). */
async function launch(o: { amo?: Parameters<typeof launchWithAmo>[0]["amo"] } = {}) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "webaios-data-"));
  const profile = mkdtempSync(path.join(os.tmpdir(), "webaios-firefox-"));
  dirs.push(dataDir, profile);
  const w = await launchWithAmo({ dataDir, profile, ...o });
  opened.push(w);
  const config = path.join(dataDir, "espace", ".webaios", "mcp.json");
  for (const deadline = Date.now() + 20_000; !existsSync(config); await new Promise((r) => setTimeout(r, 100)))
    if (Date.now() > deadline) throw new Error("the noyau did not write its MCP config");
  await waitUi(w.marionette, "return doc.querySelector('.xterm-rows')?.textContent.includes('prêt>')", [], 20_000, "agent");
  return { ...w, racine: path.join(dataDir, "espace"), call: (name: string, args: Record<string, unknown> = {}) => callTool(dataDir, name, args) };
}

const cardText = (m: Marionette) => waitUi<string>(m, `return doc.querySelector(${JSON.stringify(CARTE)})?.textContent`, [], 15_000);
const cardGone = (m: Marionette) => waitUi(m, `return !doc.querySelector(${JSON.stringify(MODALE)})`);
const activer = (m: Marionette) => click(m, `${CARTE} button`, { text: "Activer" });
const registry = (dataDir: string) => {
  const f = path.join(dataDir, "extensions", "etat.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as { extensions: Record<string, unknown> }).extensions : {};
};
const waitAddon = (m: Marionette, id: string, version: string) =>
  waitFor(m, `return (async () => {
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const a = await AddonManager.getAddonByID(${JSON.stringify(id)});
    return a && a.isActive ? a.version : null;
  })();`, (v) => v === version, 30_000);
/** demander_extension, then « Activer » on its card once it names the extension. */
async function activerParLAgent(w: Awaited<ReturnType<typeof launch>>, id: string, nom: string): Promise<string> {
  const appel = w.call("demander_extension", { id });
  expect(await cardText(w.marionette)).toContain(nom);
  await activer(w.marionette);
  return (await appel).texte;
}

describe("the agent's tools and their card", () => {
  it("demander_extension shows the card; Activer: signed, installed, « Activée » ; lister_extensions shows it active", async () => {
    const w = await launch();
    ecrireExtensionAgent(w.racine, "fond", FOND_SEUL);
    expect(await activerParLAgent(w, "fond", "Fond de l'agent")).toMatch(/^Activée dans « .+ »\.$/);
    expect(await agentAddons(w.marionette)).toEqual([{ id: "fond@agent.webaios", version: "1.0.0.1", isActive: true }]);
    await cardGone(w.marionette);
    expect((await w.call("lister_extensions")).texte).toMatch(/^agent:fond · Fond de l'agent · 1\.0\.0 · agent · actives dans : [^·]+ · erreurs : aucune$/m);
  });

  it("demander_extension in a private space: refused without a card", async () => {
    const w = await launch();
    const m = w.marionette;
    ecrireExtensionAgent(w.racine, "fond", FOND_SEUL);
    const s = await state(m);
    const e = s.espaces.find((x) => x.id === s.fenetres[0]!.espaceActif)!;
    await dispatch(m, { type: "reglerEspace", id: e.id, nom: e.nom, icone: e.icone, prive: true, profil: e.profil } as Action);
    expect((await w.call("demander_extension", { id: "fond" })).texte).toBe(ERREUR_PROFIL_PRIVE);
    expect(await inUi(m, `return !!doc.querySelector(${JSON.stringify(MODALE)})`)).toBe(false);
    expect(w.amo.envois).toEqual([]);
  });

  it("changed with a new site, recharger_extension disables it and says to call demander_extension; the card comes back", async () => {
    const w = await launch();
    ecrireExtensionAgent(w.racine, "cacheur", { "manifest.json": cacheur([HOTE]), "cache.css": "#cache-moi { display: none !important; }\n" });
    await activerParLAgent(w, "cacheur", "Cacheur de l'agent");
    ecrireExtensionAgent(w.racine, "cacheur", { "manifest.json": cacheur([HOTE, "https://exemple.com/*"]) });
    const r = (await w.call("recharger_extension", { id: "cacheur" })).texte;
    expect(r).toContain("etat : desactivee");
    expect(r).toContain("Désactivée : elle demande plus de droits qu'accordé");
    expect(r).toContain("demander_extension");
    await waitFor(w.marionette, `return (async () => {
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      return (await AddonManager.getAddonByID("cacheur@agent.webaios"))?.isActive;
    })();`, (v) => v === false);
    expect(await activerParLAgent(w, "cacheur", "Cacheur de l'agent")).toMatch(/^Activée dans « .+ »\.$/);
    await waitAddon(w.marionette, "cacheur@agent.webaios", "1.0.0.2");
    expect((await w.call("lister_extensions")).texte).toMatch(/^agent:cacheur · Cacheur de l'agent · 1\.0\.0 · agent · actives dans : [^·]+ · /m);
  });

  it("changed without a new right: recharger_extension reloads it without a card, at the next version", async () => {
    const w = await launch();
    ecrireExtensionAgent(w.racine, "cacheur", { "manifest.json": cacheur([HOTE]), "cache.css": "#cache-moi { display: none !important; }\n" });
    await activerParLAgent(w, "cacheur", "Cacheur de l'agent");
    await cardGone(w.marionette);
    ecrireExtensionAgent(w.racine, "cacheur", { "cache.css": "#cache-moi, #reste { display: none !important; }\n" });
    expect((await w.call("recharger_extension", { id: "cacheur" })).texte).toBe("etat : rechargee");
    expect(await inUi(w.marionette, `return !!doc.querySelector(${JSON.stringify(MODALE)})`)).toBe(false);
    await waitAddon(w.marionette, "cacheur@agent.webaios", "1.0.0.2");
  });

  it("AMO refuses: the agent gets AMO's message; nothing installed", async () => {
    const w = await launch({ amo: { refus: "Validation failed: eval" } });
    ecrireExtensionAgent(w.racine, "fond", FOND_SEUL);
    const r = await activerParLAgent(w, "fond", "Fond de l'agent");
    expect(r).toBe(signatureRefusee("Validation failed: eval"));
    expect(r).not.toContain("test-secret");
    expect(await agentAddons(w.marionette)).toEqual([]);
    expect(registry(w.dataDir)).toEqual({});
  });
});

describe("the grant card", () => {
  /**
   * A card in the current window for its active space (or `espaceId`), posed through the store; `reponse()` is its
   * ReponseAccord once answered (written to a file: the window may be gone by then).
   */
  async function avecCarte(champs: Record<string, unknown> = {}, w?: Awaited<ReturnType<typeof launch>>) {
    w ??= await launch();
    const m = w.marionette;
    const s = await state(m);
    const fenetre = await m.execute<string>("return window.webaiosWindow.fenetreId");
    const espace = s.espaces.find((e) => e.id === (champs.espaceId ?? s.fenetres.find((f) => f.id === fenetre)!.espaceActif))!;
    const carte = {
      cle: "agent:essai", nom: "Essai", source: "agent", version: "1.0.0", droits: ["Modifier l'apparence et le contenu des pages"],
      sites: ["https://exemple.com/*"], tousLesSites: false, reseau: [], renforce: false, espace: espace.nom, espaceId: espace.id,
      autresEspaces: [], remplaceAussi: [], maj: null, empreinte: "0".repeat(64), ...champs,
    };
    const fichier = path.join(w.dataDir, "reponse.json");
    await m.execute(
      `return (async () => {
        const s = await ChromeUtils.importESModule("${STORE}").ready;
        s.questions.askExtension(JSON.parse(arguments[0]), arguments[1]).then((r) => IOUtils.writeUTF8(arguments[2], JSON.stringify(r)));
      })();`,
      [JSON.stringify(carte), fenetre, fichier],
    );
    const reponse = () => (existsSync(fichier) ? (JSON.parse(readFileSync(fichier, "utf8")) as { accepte: boolean; retiree?: boolean }) : null);
    const attendre = async () => {
      for (const deadline = Date.now() + 10_000; !reponse(); await new Promise((r) => setTimeout(r, 100)))
        if (Date.now() > deadline) throw new Error("no answer");
      return reponse()!;
    };
    await cardText(m);
    return { ...w, m, reponse, attendre };
  }
  /** The card has the keyboard and Enter is armed. */
  const armee = (m: Marionette) =>
    waitUi(m, `return !!doc.querySelector('${MODALE}[data-armee]') && !!doc.activeElement?.closest('${MODALE}') && document.activeElement?.id === "webaios-sidebar"`);

  it("an agent card without network says « Elle ne peut rien envoyer vers internet. »", async () => {
    const { m, attendre } = await avecCarte({ autresEspaces: ["Lecture"], remplaceAussi: ["Travail", "Achats"] });
    const c = await cardText(m);
    expect(await inUi(m, `return doc.querySelector('[data-testid="carte-extension-remplace"]').textContent`)).toBe(
      "La nouvelle version remplacera aussi celle de « Travail », « Achats ».",
    );
    for (const t of [
      "Écrite par l'agent",
      "Ce qu'elle veut faire :",
      "Modifier l'apparence et le contenu des pages",
      "Sur : https://exemple.com/*",
      "Elle sera active aussi dans « Lecture » (même profil).",
      "Elle ne peut rien envoyer vers internet.",
      "Ses scripts tournent dans les pages : ils pourraient faire charger une ressource à la page",
      "L'agent ne voit pas ce que cette extension lit sur les onglets que tu ne lui as pas partagés.",
    ])
      expect(c).toContain(t);
    expect(c).toMatch(/Activer\s*« Essai »\s*dans « .+ » \?/);
    expect(c).not.toContain("l'agent pourra voir");
    expect(await inUi(m, `return doc.querySelectorAll('[data-testid="carte-extension-tous-sites"], [data-testid="carte-extension-confirmer"]').length`)).toBe(0);
    await activer(m);
    expect((await attendre()).accepte).toBe(true);
    await cardGone(m);
  });

  it("renforcée: Activer does nothing until the box is ticked; a « yes » without it is refused", async () => {
    const { m, reponse, attendre } = await avecCarte({ renforce: true, tousLesSites: true, sites: ["<all_urls>"] });
    expect(await cardText(m)).toContain("Je comprends : elle lira toutes les pages de cet espace");
    expect(await inUi(m, `return [...doc.querySelectorAll('${CARTE} button')].find((b) => b.textContent.includes("Activer")).disabled`)).toBe(true);
    await activer(m);
    await new Promise((r) => setTimeout(r, 300));
    expect(reponse()).toBeNull();
    // A « yes » sent without the box (a compromised or buggy UI): refused.
    await m.execute(`return (async () => {
      const s = await ChromeUtils.importESModule("${STORE}").ready;
      s.questions.answer(s.questions.pending()[0].id, "autoriser");
    })();`);
    expect((await attendre()).accepte).toBe(false);
  });

  it("renforcée: the box ticked, Activer activates", async () => {
    const { m, attendre } = await avecCarte({ renforce: true, tousLesSites: true, sites: ["<all_urls>"] });
    await click(m, '[data-testid="carte-extension-confirmer"]');
    await waitUi(m, `return doc.querySelector('[data-testid="carte-extension-confirmer"]').checked`);
    await activer(m);
    expect((await attendre()).accepte).toBe(true);
  });

  it("Enter refuses an extension card, even renforcée and ticked", async () => {
    const { m, attendre } = await avecCarte({ renforce: true, tousLesSites: true, sites: ["<all_urls>"] });
    await click(m, '[data-testid="carte-extension-confirmer"]');
    await waitUi(m, `return doc.querySelector('[data-testid="carte-extension-confirmer"]').checked`);
    await armee(m);
    await pressKeys(m, "Enter");
    expect((await attendre()).accepte).toBe(false);
    await cardGone(m);
  });

  it("Escape refuses", async () => {
    const { m, attendre } = await avecCarte();
    await armee(m);
    await pressKeys(m, "Escape");
    expect((await attendre()).accepte).toBe(false);
    await cardGone(m);
  });

  it("the card's window closes: the card moves to another window; no window left: refused", async () => {
    const { m, reponse, attendre } = await avecCarte();
    const first = (await m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
    const second = await newWindow(m);
    await m.command("WebDriver:SwitchToWindow", { handle: second, focus: false });
    expect(await inUi(m, `return !!doc.querySelector(${JSON.stringify(CARTE)})`)).toBe(false);
    await m.command("WebDriver:SwitchToWindow", { handle: first, focus: false });
    await m.execute("window.close()");
    await waitWindowCount(m, 1);
    await m.command("WebDriver:SwitchToWindow", { handle: second, focus: false });
    await cardText(m);
    expect(reponse()).toBeNull();
    await m.execute("window.close()");
    expect(await attendre()).toMatchObject({ accepte: false, retiree: true });
  });

  it("a card gone stale (space deleted) falls and counts as a refusal", async () => {
    const w = await launch();
    const fenetreId = await w.marionette.execute<string>("return window.webaiosWindow.fenetreId");
    const lecture = (await dispatch(w.marionette, { type: "creerEspace", nom: "Lecture", icone: "📚", prive: false, profil: "defaut", fenetreId } as Action)).espaces.at(-1)!;
    const { m, attendre } = await avecCarte({ espaceId: lecture.id }, w);
    await dispatch(m, { type: "supprimerEspace", id: lecture.id } as Action);
    expect(await attendre()).toMatchObject({ accepte: false, retiree: true });
    await cardGone(m);
  });
});
