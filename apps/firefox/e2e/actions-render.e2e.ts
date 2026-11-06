import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openActionPage, tid, uiQueries, writeActionWithResult, type Block } from "./actions";
import { state, waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { click, inUi, missingApi, waitUi } from "./ui";

// An action's page and its built-in components (Electron's actions.spec.ts:102-187, ported): served from a result the
// test writes, with no container and no Gemma. Reopening a page launches nothing.

const TASKS = [
  { nom: "Alpha", priorite: 9, etat: "ouvert", url: "https://exemple.invalide/alpha", image: "https://exemple.invalide/a.png" },
  { nom: "Bravo", priorite: 10, etat: "fermé" },
  { nom: "Charlie", priorite: 2, etat: "ouvert" },
];
const DEMO_BLOCKS: Block[] = [
  { composant: "titre", props: { texte: "<b>gras</b>" } },
  { composant: "paragraphe", props: { texte: "Trois tâches cette semaine." } },
  { composant: "encadre", props: { niveau: "attention", titre: "À voir", elements: "taches", champ: "nom" } },
  { composant: "chiffre", props: { valeur: "compter(taches)", libelle: "Tâches" } },
  { composant: "chiffres", props: { chiffres: [{ valeur: "compter(taches)", libelle: "En tout" }, { valeur: "resume.ouvertes", libelle: "Ouvertes" }] } },
  { composant: "liste", props: { elements: "taches", titre: "nom", sousTitre: "etat", lien: "url" } },
  { composant: "cartes", props: { elements: "taches", titre: "nom", valeur: "priorite", etiquettes: "etat" } },
  { composant: "tableau", props: { elements: "taches", colonnes: [{ champ: "nom", libelle: "Nom" }, { champ: "priorite", libelle: "Priorité" }] } },
  { composant: "champs", props: { objet: "resume" } },
  { composant: "etiquettes", props: { elements: "taches", champ: "etat" } },
  { composant: "lien", props: { objet: "resume", url: "source", texte: "La source" } },
  { composant: "groupe", props: { titre: "Détails" }, blocs: [{ composant: "paragraphe", props: { texte: "Dans le groupe." } }] },
  { composant: "colonnes", props: {}, gauche: [{ composant: "paragraphe", props: { texte: "À gauche." } }], droite: [{ composant: "paragraphe", props: { texte: "À droite." } }] },
];
const DEMO_RESULTS = { taches: TASKS, resume: { ouvertes: 2, semaine: "44", source: "https://exemple.invalide/source" } };

let w: LaunchedWebAiOs;
let m: Marionette;
let q: ReturnType<typeof uiQueries>;

beforeAll(async () => {
  // A permitted link opens a tab: exemple.invalide resolves to the machine, so no lookup leaves it.
  w = await launchWebAiOs({ prefs: { "network.dns.localDomains": "exemple.invalide" } });
  m = w.marionette;
  q = uiQueries(m);
  await m.setContext("chrome");
  await waitReady(m);
  await writeActionWithResult(w.dataDir, "demo", { nom: "Démo", resultats: DEMO_RESULTS, blocs: DEMO_BLOCKS, secours: true });
  await writeActionWithResult(w.dataDir, "simple", { nom: "Simple", resultats: DEMO_RESULTS, blocs: DEMO_BLOCKS });
}, 60_000);

afterAll(async () => {
  expect(await missingApi(m)).toEqual([]);
  await w?.close();
});

describe("action page rendering", () => {
  // actions.spec.ts:102
  it('each built-in component shows (data-testid="bloc-<nom>")', async () => {
    await openActionPage(m, "demo", "Démo");
    const page = tid("rendu-page");
    for (const nom of ["titre", "paragraphe", "encadre", "chiffre", "chiffres", "liste", "cartes", "tableau", "champs", "etiquettes", "lien", "groupe", "colonnes"]) {
      expect(await inUi(m, "const e = doc.querySelector(arguments[0]); return !!e && e.getBoundingClientRect().height > 0;", [`${page} ${tid(`bloc-${nom}`)}`]), nom).toBe(true);
    }
    // A fallback layout: the mention comes first.
    expect(await q.text(tid("mention-secours"))).toBe("mise en page simple");
    expect(await q.text(tid("bloc-chiffre"))).toContain("3");
    expect(await q.text(tid("bloc-encadre"))).toContain("Charlie");
    expect(await q.text(tid("bloc-champs"))).toContain("semaine");
    expect(await q.text(tid("bloc-groupe"))).toContain("Dans le groupe.");
    expect(await q.text(tid("bloc-colonnes"))).toContain("À droite.");
    // The colours follow the theme (Firefox's system theme pref stands in for Playwright's emulateMedia).
    const background = () => inUi<string>(m, "return ui.getComputedStyle(doc.querySelector(arguments[0])).backgroundColor;", [tid("bloc-encadre")]);
    await m.execute("Services.prefs.setIntPref('ui.systemUsesDarkTheme', 1);");
    try {
      await new Promise((r) => setTimeout(r, 300));
      const dark = await background();
      await m.execute("Services.prefs.setIntPref('ui.systemUsesDarkTheme', 0);");
      await waitUi(m, "return ui.getComputedStyle(doc.querySelector(arguments[0])).backgroundColor !== arguments[1];", [tid("bloc-encadre"), dark]);
    } finally {
      await m.execute("Services.prefs.clearUserPref('ui.systemUsesDarkTheme');");
    }
  });

  // actions.spec.ts:131
  it("a « <b>gras</b> » title shows as text", async () => {
    await openActionPage(m, "simple", "Simple");
    await q.waitText(tid("bloc-titre"), "<b>gras</b>");
    expect(await q.count(`${tid("bloc-titre")} b`)).toBe(0);
    expect(await q.count(tid("mention-secours"))).toBe(0);
  });

  // actions.spec.ts:147
  it("clicking the Priorité header sorts the table", async () => {
    await openActionPage(m, "simple", "Simple");
    const column = () => inUi<string[]>(m, "return [...doc.querySelectorAll(arguments[0])].map((e) => e.textContent);", [`${tid("bloc-tableau")} tbody tr td:nth-child(2)`]);
    const sortOf = (libelle: string) =>
      inUi<string | null>(m, "return [...doc.querySelectorAll(arguments[0])].find((th) => th.textContent.includes(arguments[1]))?.getAttribute('aria-sort') ?? null;", [`${tid("bloc-tableau")} th`, libelle]);
    const waitColumn = (v: string[]) => waitUi(m, "return JSON.stringify([...doc.querySelectorAll(arguments[0])].map((e) => e.textContent)) === arguments[1];", [`${tid("bloc-tableau")} tbody tr td:nth-child(2)`, JSON.stringify(v)]);
    expect(await column()).toEqual(["9", "10", "2"]);
    await click(m, `${tid("bloc-tableau")} th button`, { text: "Priorité" });
    await waitColumn(["2", "9", "10"]);
    expect(await sortOf("Priorité")).toBe("ascending");
    await click(m, `${tid("bloc-tableau")} th button`, { text: "Priorité" });
    await waitColumn(["10", "9", "2"]);
    expect(await sortOf("Priorité")).toBe("descending");
    expect(await sortOf("Nom")).toBe("none");
  });

  // actions.spec.ts:170
  it("a link without url is not clickable; an allowed link opens a tab", async () => {
    await openActionPage(m, "simple", "Simple");
    const list = tid("bloc-liste");
    expect(await q.text(list)).toContain("Bravo");
    expect(await inUi(m, "return [...doc.querySelectorAll(arguments[0])].some((b) => b.textContent.includes('Bravo'));", [`${list} button`])).toBe(false);
    expect(await q.count(`${list} a`)).toBe(0);
    const urls = async () => Object.values((await state(m)).onglets).map((o) => o.url);
    expect((await urls()).some((u) => u.includes("exemple.invalide/alpha"))).toBe(false);
    await click(m, `${list} button`, { text: "Alpha" });
    const deadline = Date.now() + 10_000;
    while (!(await urls()).some((u) => u.includes("exemple.invalide/alpha")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect((await urls()).some((u) => u.includes("exemple.invalide/alpha"))).toBe(true);
  });
});
