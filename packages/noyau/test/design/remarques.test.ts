import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { HTML_MAX, PANIER_VIDE, Remarques, TRONQUE, etatLot, tronquerHtml, type ContexteDesign, type ContexteRelecture } from "../../src/design/remarques.js";
import { REMARQUE_VIDE } from "../../src/relecture/commentaires.js";
import { dossierRemarques, type DossiersDesign } from "../../src/design/projets.js";
import { dossierTemporaire } from "../aide/temporaire.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const ctx = (html = "<p>x</p>"): ContexteDesign => ({
  selecteur: "p", etiquette: "p", html, voisinage: { parent: "div", freres: [] }, styles: {}, source: null,
  adresse: "http://localhost:5280/", vue: { largeur: 100, hauteur: 100 },
});
const rel: ContexteRelecture = { fichier: "a.ts", debut: 1, fin: 1, lignes: [{ marque: "+", texte: "x" }] };
const existe = (c: string) => stat(c).then(() => true, () => false);

async function cadre(debut = new Date("2026-11-02T10:00:00Z")) {
  const base = await dossierTemporaire();
  const dossiers: DossiersDesign = { remarquesEspace: join(base, "WebAiOs/.webaios/remarques"), prive: join(base, "design") };
  const horloge = { t: debut };
  const r = new Remarques({ dossiers, maintenant: () => horloge.t });
  return { dossiers, horloge, r };
}
const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

describe("Remarques", () => {
  test("ajouterAuPanier puis une nouvelle instance : le panier est relu du disque avec la capture <id>.png", async () => {
    const { dossiers, r } = await cadre();
    const e = await r.ajouterAuPanier("app-essai", { texte: "Plus grand", contexte: ctx(), capture: PNG });
    expect(e.id).toMatch(/^e-[0-9a-f]{8}$/);
    const r2 = new Remarques({ dossiers });
    const panier = await r2.panier("app-essai");
    expect(panier).toHaveLength(1);
    expect(panier[0]).toMatchObject({ id: e.id, texte: "Plus grand", capture: `${e.id}.png` });
    expect(await readFile(join(dossierRemarques(dossiers, "app-essai"), `${e.id}.png`))).toEqual(PNG);
  });

  test("texte vide → REMARQUE_VIDE ; html de 5 000 caractères → 4 096 + « … [tronqué] »", async () => {
    const { r } = await cadre();
    await expect(r.ajouterAuPanier("app-essai", { texte: "  ", contexte: ctx(), capture: null })).rejects.toThrow(REMARQUE_VIDE);
    const e = await r.ajouterAuPanier("app-essai", { texte: "ok", contexte: ctx("a".repeat(5000)), capture: null });
    if (e.type !== "design") throw new Error("type");
    expect(e.contexte.html).toBe("a".repeat(HTML_MAX) + TRONQUE);
    expect(TRONQUE).toBe("… [tronqué]");
    expect(tronquerHtml("court")).toBe("court");
  });

  test("retirerDuPanier efface l'élément et sa capture", async () => {
    const { dossiers, r } = await cadre();
    const e = await r.ajouterAuPanier("app-essai", { texte: "a", contexte: ctx(), capture: PNG });
    await r.retirerDuPanier("app-essai", e.id);
    expect(await r.panier("app-essai")).toEqual([]);
    expect(await existe(join(dossierRemarques(dossiers, "app-essai"), `${e.id}.png`))).toBe(false);
  });

  test("envoyerPanier : lot.json avec les deux éléments, captures déplacées, panier vide ; panier vide → PANIER_VIDE", async () => {
    const { dossiers, r } = await cadre();
    await expect(r.envoyerPanier("app-essai", { destination: "agent" })).rejects.toThrow(PANIER_VIDE);
    const a = await r.ajouterAuPanier("app-essai", { texte: "a", contexte: ctx(), capture: PNG });
    const b = await r.ajouterAuPanier("app-essai", { texte: "b", contexte: ctx(), capture: null });
    const lot = await r.envoyerPanier("app-essai", { destination: "agent" });
    expect(lot.id).toMatch(/^20261102T100000Z-[0-9a-f]{4}$/);
    const dossier = r.dossierLot("app-essai", lot.id);
    expect(dossier).toBe(join(dossierRemarques(dossiers, "app-essai"), lot.id));
    const ecrit = JSON.parse(await readFile(join(dossier, "lot.json"), "utf8"));
    expect(ecrit.elements.map((e: { id: string }) => e.id)).toEqual([a.id, b.id]);
    expect(await existe(join(dossier, `${a.id}.png`))).toBe(true);
    expect(await existe(join(dossierRemarques(dossiers, "app-essai"), `${a.id}.png`))).toBe(false);
    expect(await r.panier("app-essai")).toEqual([]);
    await expect(r.envoyerPanier("app-essai", { destination: "agent" })).rejects.toThrow(PANIER_VIDE);
    expect((await r.lots("app-essai")).map((l) => l.id)).toEqual([lot.id]);
  });

  test("app-essai écrit sous remarquesEspace/app-essai ; ext-… sous prive/remarques/ext-…", async () => {
    const { dossiers, r } = await cadre();
    const ext = "ext-0123456789abcdef";
    await r.ajouterAuPanier("app-essai", { texte: "a", contexte: ctx(), capture: null });
    await r.ajouterAuPanier(ext, { texte: "b", contexte: ctx(), capture: PNG });
    expect(await existe(join(dossiers.remarquesEspace, "app-essai", "panier.json"))).toBe(true);
    expect(await existe(join(dossiers.prive, "remarques", ext, "panier.json"))).toBe(true);
    expect(await existe(join(dossiers.prive, "remarques", "app-essai"))).toBe(false);
    expect((await stat(join(dossiers.prive, "remarques", ext, "panier.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dossiers.prive, "remarques", ext))).mode & 0o777).toBe(0o700);
    // côté espace, l'agent du conteneur doit pouvoir lire
    expect((await stat(join(dossiers.remarquesEspace, "app-essai", "panier.json"))).mode & 0o044).not.toBe(0);
  });

  test("états : en-attente → aLire le rend et pose lu → marquerTraites de tous ses éléments → traite ; note gardée", async () => {
    const { r } = await cadre();
    await r.ajouterAuPanier("app-essai", { texte: "a", contexte: ctx(), capture: null });
    await r.ajouterAuPanier("app-essai", { texte: "b", contexte: ctx(), capture: null });
    const envoye = await r.envoyerPanier("app-essai", { destination: "mcp", client: "c1" });
    expect(etatLot(envoye)).toBe("en-attente");
    const lus = await r.aLire("app-essai");
    expect(lus).toHaveLength(1);
    expect(etatLot((await r.lots("app-essai"))[0]!)).toBe("lu");
    const ids = envoye.elements.map((e) => e.id);
    const res = await r.marquerTraites("app-essai", [ids[0]!], "fait");
    expect(res).toEqual({ marques: [ids[0]], inconnus: [] });
    expect(etatLot((await r.lots("app-essai"))[0]!)).toBe("lu");
    await r.marquerTraites("app-essai", [ids[1]!]);
    const lot = (await r.lots("app-essai"))[0]!;
    expect(etatLot(lot)).toBe("traite");
    expect(lot.elements[0]!.traite?.note).toBe("fait");
    expect(lot.elements[1]!.traite?.note).toBeUndefined();
  });

  test("aLire ne rend que les éléments non traités et jamais un lot destination agent", async () => {
    const { r } = await cadre();
    await r.ajouterAuPanier("app-essai", { texte: "x", contexte: ctx(), capture: null });
    await r.envoyerPanier("app-essai", { destination: "agent" });
    expect(await r.aLire("app-essai")).toEqual([]);
    const e1 = await r.ajouterAuPanier("app-essai", { texte: "a", contexte: ctx(), capture: null });
    await r.ajouterAuPanier("app-essai", { texte: "b", contexte: ctx(), capture: null });
    await r.envoyerPanier("app-essai", { destination: "mcp" });
    await r.marquerTraites("app-essai", [e1.id]);
    const lus = await r.aLire("app-essai");
    expect(lus).toHaveLength(1);
    expect(lus[0]!.elements.map((e) => e.texte)).toEqual(["b"]);
  });

  test("marquerTraites avec un id inconnu ou d'un autre projet : rendu dans inconnus, rien d'autre ne change", async () => {
    const { r } = await cadre();
    const autre = await r.ajouterAuPanier("app-autre", { texte: "z", contexte: ctx(), capture: null });
    await r.envoyerPanier("app-autre", { destination: "mcp" });
    const e = await r.ajouterAuPanier("app-essai", { texte: "a", contexte: ctx(), capture: null });
    await r.envoyerPanier("app-essai", { destination: "mcp" });
    const res = await r.marquerTraites("app-essai", ["e-00000000", autre.id]);
    expect(res).toEqual({ marques: [], inconnus: ["e-00000000", autre.id] });
    expect((await r.lots("app-essai"))[0]!.elements[0]!.traite).toBeUndefined();
    expect((await r.lots("app-autre"))[0]!.elements[0]!.traite).toBeUndefined();
    expect(e.id).not.toBe(autre.id);
  });

  test("envoyerRelecture crée un lot d'éléments relecture", async () => {
    const { r } = await cadre();
    const lot = await r.envoyerRelecture("app-essai", [{ texte: "revoir", contexte: rel }], { destination: "mcp", client: "c" });
    expect(lot.elements[0]).toMatchObject({ type: "relecture", texte: "revoir" });
    expect(lot.client).toBe("c");
    await expect(r.envoyerRelecture("app-essai", [{ texte: " ", contexte: rel }], { destination: "agent" })).rejects.toThrow(REMARQUE_VIDE);
    await expect(r.envoyerRelecture("app-essai", [], { destination: "agent" })).rejects.toThrow(PANIER_VIDE);
  });

  test("attendre : réveillé par un lot mcp du même projet, pas par un autre, échéance, abort sans réveil gardé", async () => {
    const { r } = await cadre();
    const envoi = async (p: string, d: "agent" | "mcp" = "mcp") => {
      await r.ajouterAuPanier(p, { texte: "a", contexte: ctx(), capture: null });
      await r.envoyerPanier(p, { destination: d });
    };
    const t0 = Date.now();
    const att = r.attendre("app-essai", 5000);
    await pause(10);
    await envoi("app-essai");
    await att;
    expect(Date.now() - t0).toBeLessThan(100);
    expect(r.nombreAttentes()).toBe(0);

    let fini = false;
    const autre = r.attendre("app-essai", 150).then(() => { fini = true; });
    await pause(10);
    await envoi("app-autre");
    await envoi("app-essai", "agent");
    await pause(30);
    expect(fini).toBe(false);
    await autre; // à l'échéance
    expect(r.nombreAttentes()).toBe(0);

    const ctl = new AbortController();
    const att2 = r.attendre("app-essai", 5000, ctl.signal);
    expect(r.nombreAttentes()).toBe(1);
    ctl.abort();
    await att2;
    expect(r.nombreAttentes()).toBe(0);
    const deja = new AbortController();
    deja.abort();
    await r.attendre("app-essai", 5000, deja.signal);
    expect(r.nombreAttentes()).toBe(0);
  });

  test("deux attentes sur le même projet sont réveillées toutes les deux", async () => {
    const { r } = await cadre();
    const a = r.attendre("app-essai", 5000);
    const b = r.attendre("app-essai", 5000);
    await pause(5);
    await r.ajouterAuPanier("app-essai", { texte: "a", contexte: ctx(), capture: null });
    await r.envoyerPanier("app-essai", { destination: "mcp" });
    await Promise.all([a, b]);
    expect(r.nombreAttentes()).toBe(0);
  });

  test("purger (+31 j) ne supprime que le lot entièrement traité ; à +29 j garde tout", async () => {
    const { dossiers, horloge, r } = await cadre();
    const mk = async (p: string, textes: string[]) => {
      for (const texte of textes) await r.ajouterAuPanier(p, { texte, contexte: ctx(), capture: PNG });
      const lot = await r.envoyerPanier(p, { destination: "mcp" });
      horloge.t = new Date(horloge.t.getTime() + 1000);
      return lot;
    };
    const traite = await mk("app-essai", ["t"]);
    const partiel = await mk("app-essai", ["p1", "p2"]);
    const lu = await mk("app-essai", ["l"]);
    const attente = await mk("app-essai", ["w"]);
    const extTraite = await mk("ext-0123456789abcdef", ["x"]);
    await r.marquerTraites("app-essai", traite.elements.map((e) => e.id));
    await r.marquerTraites("app-essai", [partiel.elements[0]!.id]);
    await r.marquerTraites("ext-0123456789abcdef", extTraite.elements.map((e) => e.id));
    // pose « lu » sur le lot lu seulement : on le fait via aLire puis on remet les autres en attente sur disque
    await r.aLire("app-essai");
    const ecrit = join(dossiers.remarquesEspace, "app-essai", attente.id, "lot.json");
    const brut = JSON.parse(await readFile(ecrit, "utf8"));
    delete brut.lu;
    await writeFile(ecrit, JSON.stringify(brut));
    expect(etatLot((await r.lots("app-essai")).find((l) => l.id === attente.id)!)).toBe("en-attente");
    expect(etatLot((await r.lots("app-essai")).find((l) => l.id === lu.id)!)).toBe("lu");
    const maintenant = horloge.t.getTime();
    horloge.t = new Date(maintenant + 29 * 86_400_000);
    expect(await r.purger()).toBe(0);
    horloge.t = new Date(maintenant + 31 * 86_400_000);
    expect(await r.purger()).toBe(2);
    const restants = (await r.lots("app-essai")).map((l) => l.id).sort();
    expect(restants).toEqual([partiel.id, lu.id, attente.id].sort());
    expect(await existe(join(dossiers.prive, "remarques", "ext-0123456789abcdef", extTraite.id))).toBe(false);
  });

  test("panier.json trafiqué : capture hors du dossier ignorée, aucun fichier extérieur déplacé", async () => {
    const { dossiers, r } = await cadre();
    const dossier = dossierRemarques(dossiers, "app-essai");
    await mkdir(dossier, { recursive: true });
    const victime = join(dossiers.remarquesEspace, "victime.txt");
    await writeFile(victime, "x");
    await writeFile(join(dossier, "panier.json"), JSON.stringify([
      { id: "e-0000000a", type: "design", texte: "a", contexte: ctx(), capture: "../victime.txt" },
      { id: "../mauvais", type: "design", texte: "b", contexte: ctx(), capture: null },
    ]));
    const lot = await r.envoyerPanier("app-essai", { destination: "agent" });
    expect(lot.elements).toHaveLength(1);
    expect(lot.elements[0]).toMatchObject({ capture: null });
    expect(await existe(victime)).toBe(true);
  });

  test("lot.json trafiqué : id et projet imposés par le dossier ; purge et écritures restent chez le lot", async () => {
    const { dossiers, horloge, r } = await cadre();
    const ext = "ext-0123456789abcdef";
    await r.ajouterAuPanier(ext, { texte: "secret", contexte: ctx(), capture: null });
    const lotExt = await r.envoyerPanier(ext, { destination: "mcp" });
    await r.ajouterAuPanier("app-essai", { texte: "a", contexte: ctx(), capture: null });
    const lot = await r.envoyerPanier("app-essai", { destination: "mcp" });
    const f = join(dossiers.remarquesEspace, "app-essai", lot.id, "lot.json");
    const brut = JSON.parse(await readFile(f, "utf8"));
    brut.projet = ext;
    brut.id = lotExt.id;
    await writeFile(f, JSON.stringify(brut));
    const lus = await r.lots("app-essai");
    expect(lus[0]).toMatchObject({ id: lot.id, projet: "app-essai" });
    await r.marquerLotTraite("app-essai", lot.id);
    expect(etatLot((await r.lots(ext))[0]!)).toBe("en-attente");
    expect((await r.lots(ext))[0]!.elements[0]!.traite).toBeUndefined();
    horloge.t = new Date(horloge.t.getTime() + 31 * 86_400_000);
    expect(await r.purger()).toBe(1);
    expect(await r.lots(ext)).toHaveLength(1);
    expect(await r.lots("app-essai")).toEqual([]);
  });

  test("marquerLotTraite traite tous les éléments du lot", async () => {
    const { r } = await cadre();
    await r.ajouterAuPanier("app-essai", { texte: "a", contexte: ctx(), capture: null });
    await r.ajouterAuPanier("app-essai", { texte: "b", contexte: ctx(), capture: null });
    const lot = await r.envoyerPanier("app-essai", { destination: "agent" });
    await r.marquerLotTraite("app-essai", lot.id);
    const apres = (await r.lots("app-essai"))[0]!;
    expect(etatLot(apres)).toBe("traite");
    expect(apres.elements.every((e) => e.traite)).toBe(true);
  });

  test("oublier efface le projet ; surChange notifie panier et lots", async () => {
    const { dossiers, r } = await cadre();
    const vus: string[] = [];
    const arret = r.surChange((p) => vus.push(p));
    await r.ajouterAuPanier("app-essai", { texte: "a", contexte: ctx(), capture: null });
    await r.envoyerPanier("app-essai", { destination: "agent" });
    expect(vus.length).toBeGreaterThanOrEqual(2);
    expect(new Set(vus)).toEqual(new Set(["app-essai"]));
    arret();
    await r.oublier("app-essai");
    expect(await existe(join(dossiers.remarquesEspace, "app-essai"))).toBe(false);
    expect(await r.lots("app-essai")).toEqual([]);
    await mkdir(dossiers.remarquesEspace, { recursive: true });
  });

  test("identifiant de projet invalide refusé", async () => {
    const { r } = await cadre();
    await expect(r.panier("../x")).rejects.toThrow();
    expect(() => r.dossierLot("app-essai", "../x")).toThrow();
  });
});
