import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXECUTION, openActionPage, startActionServers, tid, uiQueries, writeActionWithResult, type Block } from "./actions";
import { state, waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { click, inUi, missingApi, waitUi } from "./ui";

// An action's page and its built-in components (Electron's actions.spec.ts:102-187, ported): served from a result the
// test writes, with no container and no Gemma. Reopening a page launches nothing. Result images go through the test hook
// (WEBAIOS_TEST_ACTION_IMAGES): `https://<host><path>` is asked from the local image server, which notes each request.

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

/** The hostile images of Review Focus 3, and an ordinary one as the control. */
const PHOTOS = {
  ok: "https://img.exemple/ok.png",
  // A 302 to http://127.0.0.1:<port>/secret.
  redirect: "https://img.exemple/x/r",
  html: "https://img.exemple/html.png",
  big: "https://img.exemple/big.png",
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let servers: Awaited<ReturnType<typeof startActionServers>>;
let w: LaunchedWebAiOs;
let m: Marionette;
let q: ReturnType<typeof uiQueries>;

beforeAll(async () => {
  // A permitted link opens a tab: exemple.invalide resolves to the machine, so no lookup leaves it.
  servers = await startActionServers();
  w = await launchWebAiOs({ env: { WEBAIOS_TEST_ACTION_IMAGES: servers.images.url }, prefs: { "network.dns.localDomains": "exemple.invalide" } });
  m = w.marionette;
  q = uiQueries(m);
  await m.setContext("chrome");
  await waitReady(m);
  await writeActionWithResult(w.dataDir, "demo", { nom: "Démo", resultats: DEMO_RESULTS, blocs: DEMO_BLOCKS, secours: true });
  await writeActionWithResult(w.dataDir, "simple", { nom: "Simple", resultats: DEMO_RESULTS, blocs: DEMO_BLOCKS });
  const cards: Block[] = [{ composant: "cartes", props: { elements: "photos", titre: "titre", image: "photo" } }];
  await writeActionWithResult(w.dataDir, "courrier", {
    nom: "Courrier",
    compte: ["mail.exemple.fr"],
    resultats: { photos: [{ titre: "Bonjour", photo: "https://img.exemple/photo.png" }] },
    blocs: cards,
  });
  const many = Array.from({ length: 40 }, (_, i) => ({ titre: `n${i}`, photo: `https://img.exemple/n${i}.png` }));
  await writeActionWithResult(w.dataDir, "lazy", { nom: "Lazy", resultats: { photos: many }, blocs: cards });
  await writeActionWithResult(w.dataDir, "images", { nom: "Images", resultats: { photos: Object.entries(PHOTOS).map(([titre, photo]) => ({ titre, photo })) }, blocs: cards });
}, 60_000);

afterAll(async () => {
  expect(await missingApi(m)).toEqual([]);
  await w?.close();
  await servers?.close();
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

  // actions.spec.ts:190
  it("account action: the image is a neutral placeholder and no request reaches the test server", async () => {
    servers.reset();
    await openActionPage(m, "courrier", "Courrier");
    const cards = tid("bloc-cartes");
    await q.waitContains(cards, "Bonjour");
    await q.waitCount(`${cards} ${tid("image-neutre")}`, 1);
    expect(await q.count(`${cards} img`)).toBe(0);
    // Asked directly, the host refuses it too: an action with an account never loads an image.
    expect(await inUi(m, "return ui.webaios.actions.image('courrier', arguments[0], arguments[1]);", [EXECUTION, "https://img.exemple/photo.png"])).toBeNull();
    await sleep(500);
    expect(servers.images.seen).toEqual([]);
  });

  // Review Focus 3
  it("a result image that redirects to 127.0.0.1, is not an image or is too big stays neutral", async () => {
    servers.reset();
    await openActionPage(m, "images", "Images");
    const cards = tid("bloc-cartes");
    // The control: an ordinary image shows, as a data: URL.
    await q.waitCount(`${cards} img.pa-image`, 1, 15_000);
    expect(await inUi<string>(m, "return doc.querySelector(arguments[0]).src;", [`${cards} img.pa-image`])).toMatch(/^data:image\/png;base64,/);
    const paths = () => servers.images.seen.map((s) => s.path).sort();
    const asked = ["/img.exemple/big.png", "/img.exemple/html.png", "/img.exemple/ok.png", "/img.exemple/x/r"];
    for (const deadline = Date.now() + 15_000; JSON.stringify(paths()) !== JSON.stringify(asked); await sleep(100))
      if (Date.now() > deadline) throw new Error(`images asked: ${JSON.stringify(paths())}`);
    await q.waitCount(`${cards} ${tid("image-neutre")}`, 3);
    expect(await q.count(`${cards} img`)).toBe(1);
    // An address absent from the results: refused by the host, never fetched.
    expect(await inUi(m, "return ui.webaios.actions.image('images', arguments[0], arguments[1]);", [EXECUTION, "https://img.exemple/absent.png"])).toBeNull();
    await sleep(500);
    // The redirect's target (/secret) got no request; none carried a cookie or a referrer.
    expect(paths()).toEqual(asked);
    expect(servers.images.seen.every((s) => s.cookie === null && s.referer === null)).toBe(true);
  });

  // Electron's loading="lazy": an image far below the view is asked only once scrolled near.
  it("an offscreen result image is not requested until it is scrolled near", async () => {
    servers.reset();
    await openActionPage(m, "lazy", "Lazy");
    const cards = tid("bloc-cartes");
    await waitUi(m, "return doc.querySelectorAll(arguments[0]).length > 0;", [`${cards} img.pa-image`], 15_000);
    const n = await q.count(`${cards} .pa-carte`);
    const last = `/img.exemple/n${n - 1}.png`;
    await sleep(1000);
    const before = servers.images.seen.map((s) => s.path);
    expect(before.length).toBeLessThan(n);
    expect(before).not.toContain(last);
    await inUi(m, "const d = doc.querySelector(arguments[0]); d.scrollTop = d.scrollHeight;", [tid("page-action")]);
    for (const deadline = Date.now() + 10_000; !servers.images.seen.some((s) => s.path === last); await sleep(100))
      if (Date.now() > deadline) throw new Error(`not asked after the scroll: ${last}`);
    await waitUi(m, "const c = [...doc.querySelectorAll(arguments[0])].at(-1); return !!c?.querySelector('img.pa-image');", [`${cards} .pa-carte`]);
    // Each image asked once: a page read again does not ask again.
    const paths = servers.images.seen.map((s) => s.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
