import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Action } from "../../navigateur/src/commun/api";
import { actionsDataDir, adPhoto, chained, startActionServers, tid, uiQueries, waitNoyau, writeAction, writeRunnableAction } from "./actions";
import { dispatch, state, waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { click, inUi, missingApi, pressKeys, waitUi } from "./ui";

// Whole scenarios of an action (Electron's actions.spec.ts:1334-1460, ported): Gemma's plan, the results' images through
// the test hook (WEBAIOS_TEST_ACTION_IMAGES: `https://<host><path>` is asked from the local image server, which notes
// each request with its Cookie and Referer). One launch for the file; the actions are written before it.

const SECRET = "jeton-du-compte-4242";

/** `extraire.mjs` of the ads: each ad and its photo (a link of the page), the price as a number (actions.spec.ts:1316). */
const EXTRACT_ADS = `export default async (page) => {
  const photos = new Map();
  for (const l of page.liens) {
    const p = /\\/photos\\/(\\d+)\\.jpg$/.exec(l.url);
    if (p) photos.set(p[1], l.url);
  }
  const annonces = [];
  for (const l of page.liens) {
    const m = /\\/ad\\/(\\d+)$/.exec(l.url);
    if (!m) continue;
    const [titre, prix, ville] = l.texte.split(" – ");
    annonces.push({ titre, prix: Number(prix), ville, url: l.url, ...(photos.has(m[1]) ? { photo: photos.get(m[1]) } : {}) });
  }
  return { annonces };
};
`;

let servers: Awaited<ReturnType<typeof startActionServers>>;
let w: LaunchedWebAiOs;
let m: Marionette;
let q: ReturnType<typeof uiQueries>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const visible = (selector: string, ms = 30_000) => waitUi(m, "const e = doc.querySelector(arguments[0]); return !!e && e.getBoundingClientRect().height > 0;", [selector], ms);
const tabUrls = async () => Object.values((await state(m)).onglets).map((o) => o.url);

beforeAll(async () => {
  servers = await startActionServers();
  const site = servers.site.url;
  w = await launchWebAiOs({
    env: { WEBAIOS_OLLAMA_URL: servers.ollama.url, WEBAIOS_KEV_URL: servers.kev.url, WEBAIOS_TEST_ADRESSES_LOCALES: "1", WEBAIOS_TEST_ACTION_IMAGES: servers.images.url },
  });
  m = w.marionette;
  q = uiQueries(m);
  await m.setContext("chrome");
  await waitReady(m);
  await waitNoyau(m);
  const d = w.dataDir;
  await writeAction(d, "annonces-leboncoin", {
    nom: "Annonces Leboncoin",
    saisie: { libelle: "Recherche" },
    sources: { web: true },
    miseEnPage: "des cartes avec le prix et la ville, les moins chères en premier",
    workflow: chained([
      { id: "recherche", type: "source.page", parametres: { url: `${site}/leboncoin/recherche?text={saisie}` } },
      { id: "extraire", type: "code", parametres: { source: "extraire.mjs" } },
      { id: "sortie", type: "sortie", parametres: { vers: "page" } },
    ]),
    fichiers: { "extraire.mjs": EXTRACT_ADS },
  });
  const leak = `${site}/tiers?d=${SECRET}`;
  await writeRunnableAction(d, "hostile", {
    nom: "Hostile",
    compte: ["127.0.0.1"],
    code: `export default async () => ({
      compte: { jeton: ${JSON.stringify(SECRET)} },
      tickets: [{ titre: "Connexion impossible", photo: "https://img.exemple.org/avatar.png", fuite: ${JSON.stringify(leak)} }],
    });`,
  });
  // Electron's accorder (actions.spec.ts:1190).
  await mkdir(actionsDataDir(d), { recursive: true });
  await writeFile(path.join(actionsDataDir(d), "accords.json"), JSON.stringify({ hostile: { domaines: ["127.0.0.1"], publiques: [], profil: "defaut" } }));
  for (const id of ["annonces-leboncoin", "hostile"]) await waitUi(m, "return (await ui.webaios.actions.liste()).some((a) => a.id === arguments[0]);", [id], 30_000);
}, 90_000);
beforeEach(async () => {
  servers.reset();
  for (const id of Object.keys((await state(m)).onglets)) await dispatch(m, { type: "fermerOnglet", id } as Action);
});
afterAll(async () => {
  expect(await missingApi(m)).toEqual([]);
  await w?.close();
  await servers?.close();
});

describe("action scenarios", () => {
  // actions.spec.ts:1334
  it("Leboncoin « leboncoin clio lyon »: the input reaches the URL read, cards with photos loaded", { timeout: 120_000 }, async () => {
    servers.settings.plan = {
      blocs: [{ composant: "cartes", props: { elements: "trier(annonces, prix)", titre: "titre", sousTitre: "ville", valeur: "prix", image: "photo", lien: "url" } }],
    };
    // A cookie on the image host (127.0.0.1), set by a tab of the default container: an image load must not send it.
    await m.execute(
      `return (async () => {
        const url = arguments[0] + "/cookie?v=default";
        const tab = gBrowser.addTab(url, { userContextId: 0, triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
        for (let i = 0; i < 50 && tab.linkedBrowser.currentURI.spec !== url; i++) await new Promise((r) => setTimeout(r, 100));
        await new Promise((r) => setTimeout(r, 500));
        gBrowser.removeTab(tab);
      })();`,
      [servers.images.url],
    );
    expect(await m.execute<string[]>(`return Services.cookies.getCookiesFromHost("127.0.0.1", {}).map((c) => c.name + "=" + c.value);`)).toContain("seen=default");
    servers.images.seen.length = 0;
    const since = servers.site.log.length;
    // Electron's empty page: type, ↓, Enter.
    await click(m, tid("nouvel-onglet"));
    await waitUi(m, "return !!doc.querySelector(arguments[0]);", [tid("page-vide")]);
    await click(m, tid("saisie-page-vide"));
    await inUi(m, `const f = doc.querySelector(arguments[0]); f.focus(); f.value = arguments[1]; f.dispatchEvent(new ui.Event("input", { bubbles: true }));`, [
      tid("saisie-page-vide"),
      "leboncoin clio lyon",
    ]);
    await q.waitContains(tid("suggestions-actions"), "Annonces Leboncoin");
    await pressKeys(m, "ArrowDown");
    await pressKeys(m, "Enter");
    await visible(tid("page-action"));
    const cards = tid("bloc-cartes");
    await visible(cards, 60_000);
    // The input, encoded, in the address read; and kept in the header.
    expect(servers.site.log.slice(since)).toContain("/leboncoin/recherche?text=clio%20lyon");
    expect(await q.value(tid("saisie-action"))).toBe("clio lyon");
    // The cheapest first, each with its photo, loaded through the anonymous channel.
    expect(await inUi(m, "return [...doc.querySelectorAll(arguments[0])].map((e) => e.textContent);", [`${cards} .pa-carte .titre`])).toEqual(["Renault Clio 3", "Renault Clio 4"]);
    await waitUi(
      m,
      "const i = [...doc.querySelectorAll(arguments[0])]; return i.length === 2 && i.every((x) => x.src.startsWith('data:image/') && x.complete && x.naturalWidth === 1);",
      [`${cards} img`],
      15_000,
    );
    expect(await q.count(`${cards} ${tid("image-neutre")}`)).toBe(0);
    const seen = servers.images.seen.filter((s) => s.path !== "/cookie");
    expect(seen.map((s) => `https:/${s.path}`).sort()).toEqual([adPhoto(1), adPhoto(2)]);
    // Neither the default container's cookie nor a referrer went with them.
    expect(seen.map((s) => [s.cookie, s.referer])).toEqual([
      [null, null],
      [null, null],
    ]);
  });

  // actions.spec.ts:1415
  it("hostile plan: no request reaches the server with the data, inert link, neutral image, title as text", { timeout: 90_000 }, async () => {
    const site = servers.site.url;
    const title = `<img src=${site}/tiers?d=titre>Tickets`;
    servers.settings.plan = {
      blocs: [
        { composant: "titre", props: { texte: title } },
        // An address composed by Gemma: a field is only a name, this block is dropped.
        { composant: "lien", props: { objet: "compte", url: `"${site}/tiers?d=" + jeton`, texte: "Ouvrir" } },
        // A field holding no address: the link stays text.
        { composant: "lien", props: { objet: "compte", url: "jeton", texte: "Voir le jeton" } },
        // A results address to the (local) test server: inert. An action with an account's image: neutral.
        { composant: "cartes", props: { elements: "tickets", titre: "titre", image: "photo", lien: "fuite" } },
      ],
    };
    const since = servers.site.log.length;
    await dispatch(m, { type: "ouvrirAction", fenetreId: (await state(m)).fenetres[0]!.id, id: "hostile", nom: "Hostile" });
    await visible(tid("page-action"), 10_000);
    await click(m, tid("relancer-action"));
    const page = tid("rendu-page");
    await visible(page, 60_000);
    expect(await q.count(`${page} ${tid("mention-secours")}`)).toBe(0);
    // The title as text, no HTML element.
    await q.waitText(`${page} ${tid("bloc-titre")}`, title);
    expect(await q.count(`${page} img`)).toBe(0);
    // The composed link is dropped; the other is only text; the card has neither link nor image.
    expect(await q.count(`${page} ${tid("bloc-lien")}`)).toBe(1);
    expect(await q.text(`${page} ${tid("bloc-lien")}`)).toBe("Voir le jeton");
    expect(await q.count(`${page} a, ${page} button.pa-lien`)).toBe(0);
    const cards = `${page} ${tid("bloc-cartes")}`;
    expect(await q.text(cards)).toContain("Connexion impossible");
    await visible(`${cards} ${tid("image-neutre")}`);
    await click(m, `${cards} *`, { text: "Connexion impossible" });
    await sleep(1000);
    // Nothing left: neither to the test server, nor to the image's address, and no tab opened to the leak.
    expect(servers.site.log.slice(since).filter((c) => c.includes("/tiers") || c.includes(SECRET))).toEqual([]);
    expect(servers.images.seen).toEqual([]);
    expect((await tabUrls()).filter((u) => u.includes("/tiers"))).toEqual([]);
    // Firefox's own tabs too (gBrowser), not only the state's.
    expect(await m.execute<string[]>("return gBrowser.browsers.map((b) => b.currentURI.spec).filter((u) => u.includes('/tiers'));")).toEqual([]);
  });
});
