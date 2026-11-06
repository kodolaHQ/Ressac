import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ID_PROJET, Remarques, type CheminsEspace, type Lot, type ProjetSuivi } from "../../../packages/noyau/src/index";
import { JETON_RELECTURE, ServiceRelecture } from "../../navigateur/src/main/design/relecture";
import { PLAGE_HORS_BLOC } from "../../navigateur/src/commun/modele";
import { TEXTE_REMARQUE_MAX } from "../../navigateur/src/commun/api";
import { raisonEchec as electronRaison } from "../../navigateur/src/main/design/externes";
import { COMPARAISON_INCONNUE, ReviewService } from "../noyau/review";
import * as g from "../shared/design-guards";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const EXT = "ext-0123456789abcdef";
const unknown = `${"a".repeat(40)}:${"b".repeat(40)}`;
const thirty = Array.from({ length: 30 }, (_, i) => `ligne ${i + 1}`);
/** a.txt of 30 lines, with the numbered lines rewritten. */
const text = (...changed: number[]) => thirty.map((l, i) => (changed.includes(i + 1) ? `${l} modifiée` : l)).join("\n") + "\n";

describe.each([["electron", ServiceRelecture], ["firefox", ReviewService]] as const)("review service (%s)", (_name, Service) => {
  function prepare() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "webaios-review-")));
    dirs.push(root);
    const projets = join(root, "projets");
    const sites = join(root, "sites");
    mkdirSync(join(projets, "essai"), { recursive: true });
    mkdirSync(join(sites, "tuning", "retouches"), { recursive: true });
    writeFileSync(join(projets, "essai", "a.txt"), "un\n");
    writeFileSync(join(sites, "tuning", "site.json"), "{}\n");
    writeFileSync(join(sites, "tuning", "retouches", "tuning.css"), "/* rien */\n");
    const dossiers = { remarquesEspace: join(root, "remarques"), prive: join(root, "prive") };
    const remarques = new Remarques({ dossiers });
    const sent: { projet: ProjetSuivi; lot: Lot }[] = [];
    const registre = {
      projets: () => [{ id: EXT.slice(4), nom: "Ext", dossier: join(projets, "essai"), ports: [], client: "client-0001", declare: "" }],
      clients: () => [{ id: "client-0001", nom: "Claude", empreinte: "", cree: "" }],
    };
    const service = new Service({
      dossiers, chemins: { projets, sites } as CheminsEspace, registre: () => registre as never,
      sites: async () => [{ id: "tuning", nom: "Tuning" }], remarques,
      envoyer: async (projet, lot) => void sent.push({ projet, lot }),
    });
    const relecture = join(dossiers.prive, "relecture");
    return { service, remarques, sent, root, projets, sites, relecture, write: (t: string, n = "a.txt") => writeFileSync(join(projets, "essai", n), t) };
  }
  /** Opens once so the project's first snapshot is taken, writes `before` first; returns after `after` is written. */
  async function opened(s: ReturnType<typeof prepare>, before: string, after: string) {
    s.write(before);
    await s.service.ouvrir(EXT);
    s.write(after);
    const v = await s.service.ouvrir(EXT);
    if (v.etat !== "ok") throw new Error(v.raison);
    return v;
  }
  const ok = <T extends { etat: string }>(v: T) => {
    if (v.etat !== "ok") throw new Error(JSON.stringify(v));
    return v as T & { etat: "ok"; jeton: string };
  };

  // Electron relecture.test.ts:35
  it("two opens give two tokens; an unknown token is refused", async () => {
    const s = prepare();
    await s.service.ouvrir(EXT);
    s.write("deux\n");
    const v1 = ok(await s.service.ouvrir(EXT));
    s.write("trois\n");
    const v2 = ok(await s.service.ouvrir(EXT));
    expect(v1.jeton).toMatch(JETON_RELECTURE);
    expect(v2.jeton).not.toBe(v1.jeton);
    const added = async (j: string) => (await s.service.fichier(EXT, j, "a.txt")).blocs.flatMap((b) => b.lignes.filter((l) => l.marque === "+").map((l) => l.texte));
    expect(await added(v1.jeton)).toEqual(["deux"]);
    expect(await added(v2.jeton)).toEqual(["trois"]);
    expect(await s.service.lignes(EXT, v1.jeton, "a.txt", 1, 5)).toEqual(["deux"]);
    s.write("quatre\n");
    expect(await s.service.ouvrir(EXT, v1.jeton)).toMatchObject({ etat: "ok", jeton: v1.jeton });
    expect(await added(v1.jeton)).toEqual(["deux"]);
    await expect(s.service.fichier(EXT, unknown, "a.txt")).rejects.toThrow(COMPARAISON_INCONNUE);
    await expect(s.service.lignes(EXT, unknown, "a.txt", 1, 2)).rejects.toThrow(COMPARAISON_INCONNUE);
  });

  // Electron relecture.test.ts:60
  it("keeps at most 8 comparisons per project: the oldest drops", async () => {
    const s = prepare();
    await s.service.ouvrir(EXT);
    const tokens: string[] = [];
    for (let i = 0; i < 9; i++) {
      s.write(`v${i}\n`);
      tokens.push(ok(await s.service.ouvrir(EXT)).jeton);
    }
    await expect(s.service.fichier(EXT, tokens[0]!, "a.txt")).rejects.toThrow(COMPARAISON_INCONNUE);
    expect((await s.service.fichier(EXT, tokens[1]!, "a.txt")).chemin).toBe("a.txt");
  }, 20_000);

  // Electron relecture.test.ts:84
  it("a range overflowing the block is refused", async () => {
    const s = prepare();
    const v = await opened(s, text(), text(5, 25));
    const c = (debut: number, fin: number, texte: string, j = v.jeton) => s.service.commenter(EXT, j, { fichier: "a.txt", debut, fin, texte });
    expect(await c(5, 25, "trop large")).toEqual({ ok: false, erreur: PLAGE_HORS_BLOC });
    expect(await c(1, 3, "hors du diff")).toEqual({ ok: false, erreur: PLAGE_HORS_BLOC });
    expect(await c(4, 5, "  ")).toMatchObject({ ok: false });
    expect(await c(4, 5, "x", unknown)).toEqual({ ok: false, erreur: COMPARAISON_INCONNUE });
    expect(await c(4, 5, "bien")).toEqual({ ok: true });
    const [first] = await s.service.commentaires(EXT);
    expect(first).toMatchObject({ fichier: "a.txt", debut: 4, fin: 5, texte: "bien", envoye: false, resolu: false });
    expect(first!.lignes).toEqual([{ marque: " ", texte: "ligne 4" }, { marque: "-", texte: "ligne 5" }, { marque: "+", texte: "ligne 5 modifiée" }]);
  });

  // Electron relecture.test.ts:103
  it("relu keeps the tree shown: a file changed after ouvrir() stays in the next diff", async () => {
    const s = prepare();
    const v = await opened(s, "un\n", "deux\n");
    s.write("autre\n", "b.txt");
    const after = ok(await s.service.relu(EXT, v.jeton));
    expect(after.comparaison.fichiers.map((f) => f.chemin)).toEqual(["b.txt"]);
    await expect(s.service.relu(EXT, v.jeton)).rejects.toThrow(COMPARAISON_INCONNUE);
    await expect(s.service.relu(EXT, unknown)).rejects.toThrow(COMPARAISON_INCONNUE);
  });

  // Electron relecture.test.ts:117
  it("relu drops resolved comments and keeps the others", async () => {
    const s = prepare();
    const v = await opened(s, text(), text(15));
    await s.service.commenter(EXT, v.jeton, { fichier: "a.txt", debut: 15, fin: 15, texte: "un" });
    await s.service.commenter(EXT, v.jeton, { fichier: "a.txt", debut: 14, fin: 14, texte: "deux" });
    const [one] = await s.service.commentaires(EXT);
    await s.service.resoudre(EXT, one!.id, true);
    const after = ok(await s.service.relu(EXT, v.jeton));
    expect(after.comparaison.fichiers).toEqual([]);
    expect(after.commentaires.map((c) => [c.texte, c.fichier])).toEqual([["deux", "a.txt"]]);
  });

  // Electron relecture.test.ts:133
  it("envoyer makes a relecture lot with file, lines and marks; a second send takes the unresolved ones", async () => {
    const s = prepare();
    const v = await opened(s, text(), text(15));
    expect(v).toMatchObject({ destination: "Claude Code (Claude)", sansDestination: null });
    expect(await s.service.envoyer(EXT)).toMatchObject({ ok: false });
    await s.service.commenter(EXT, v.jeton, { fichier: "a.txt", debut: 15, fin: 15, texte: "garder l'ancien nom" });
    await s.service.commenter(EXT, v.jeton, { fichier: "a.txt", debut: 13, fin: 14, texte: "et ici" });
    expect(await s.service.envoyer(EXT)).toEqual({ ok: true });
    const lots = await s.remarques.lots(EXT);
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ destination: "mcp" });
    expect(lots[0]!.elements.map((e) => ({ type: e.type, texte: e.texte, contexte: e.contexte }))).toEqual([
      { type: "relecture", texte: "garder l'ancien nom", contexte: { fichier: "a.txt", debut: 15, fin: 15, lignes: [{ marque: "-", texte: "ligne 15" }, { marque: "+", texte: "ligne 15 modifiée" }] } },
      { type: "relecture", texte: "et ici", contexte: { fichier: "a.txt", debut: 13, fin: 14, lignes: [{ marque: " ", texte: "ligne 13" }, { marque: " ", texte: "ligne 14" }] } },
    ]);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.projet).toMatchObject({ type: "externe", projet: EXT, client: "client-0001" });
    expect(s.sent[0]!.lot.id).toBe(lots[0]!.id);
    const left = await s.service.commentaires(EXT);
    expect(left.map((c) => c.envoye)).toEqual([true, true]);
    await s.service.resoudre(EXT, left[0]!.id, true);
    expect(await s.service.envoyer(EXT)).toEqual({ ok: true });
    const all = await s.remarques.lots(EXT);
    expect(all).toHaveLength(2);
    expect(all.find((l) => l.id !== lots[0]!.id)!.elements.map((e) => e.texte)).toEqual(["et ici"]);
  });

  // Electron relecture.test.ts:164
  it("simultaneous comment operations lose nothing", async () => {
    const s = prepare();
    const v = await opened(s, text(), text(15));
    for (let i = 0; i < 8; i++) await s.service.commenter(EXT, v.jeton, { fichier: "a.txt", debut: 15, fin: 15, texte: `n${i}` });
    const ids = (await s.service.commentaires(EXT)).map((c) => c.id);
    await Promise.all([
      ...ids.slice(0, 4).map((id) => s.service.resoudre(EXT, id, true)),
      ...ids.slice(4).map((id, i) => s.service.modifierCommentaire(EXT, id, `modifié ${i}`)),
      s.service.ouvrir(EXT, v.jeton),
      s.service.commenter(EXT, v.jeton, { fichier: "a.txt", debut: 13, fin: 14, texte: "nouveau" }),
    ]);
    const l = await s.service.commentaires(EXT);
    expect(l).toHaveLength(9);
    expect(l.filter((c) => c.resolu).map((c) => c.id)).toEqual(ids.slice(0, 4));
    expect(l.filter((c) => c.texte.startsWith("modifié")).map((c) => c.id)).toEqual(ids.slice(4));
  });

  it("an external project's own folder is never touched: no .git inside, the bare repository is private", async () => {
    const s = prepare();
    await opened(s, "un\n", "deux\n");
    expect(existsSync(join(s.projets, "essai", ".git"))).toBe(false);
    expect(readdirSync(s.relecture).filter((n) => n.endsWith(".git"))).toEqual([`${EXT}.git`]);
    expect((await s.service.projet("ext-ffffffffffffffff"))).toBeNull();
    expect(await s.service.ouvrir("ext-ffffffffffffffff")).toMatchObject({ etat: "indisponible", raison: "projet inconnu" });
  });

  // Electron relecture.test.ts:256
  it("a site folder that is a symlink gives null and creates no repository", async () => {
    for (const to of ["dehors", "dedans"] as const) {
      const s = prepare();
      rmSync(join(s.sites, "tuning"), { recursive: true });
      const target = to === "dehors" ? join(s.root, "dehors") : join(s.sites, "autre");
      mkdirSync(target);
      writeFileSync(join(target, "secret.txt"), "x\n");
      symlinkSync(target, join(s.sites, "tuning"));
      expect(await s.service.projet("site-tuning")).toBeNull();
      await s.service.priseEnChargeSites(["tuning"]);
      await s.service.assurer("site-tuning");
      expect(await s.service.ouvrir("site-tuning")).toMatchObject({ etat: "indisponible", raison: "projet inconnu" });
      expect(existsSync(join(s.relecture, "site-tuning.git"))).toBe(false);
    }
  });

  // Electron relecture.test.ts:272
  it("a real site folder gives its name; an absent site gives null", async () => {
    const s = prepare();
    expect(await s.service.projet("site-tuning")).toEqual({ nom: "Tuning", dossier: join(s.sites, "tuning") });
    expect(await s.service.projet("site-absent")).toBeNull();
    mkdirSync(join(s.sites, "autre"));
    expect(await s.service.projet("site-autre")).toEqual({ nom: "autre", dossier: join(s.sites, "autre") });
  });

  // Electron relecture.test.ts:281
  it("priseEnChargeSites snapshots valid sites only; assurer a second time does not move the reference", async () => {
    const s = prepare();
    await s.service.priseEnChargeSites(["tuning", "../x"]);
    const ref = join(s.relecture, "site-tuning.git", "refs", "webaios", "relu");
    expect(existsSync(ref)).toBe(true);
    expect(readdirSync(s.relecture).filter((n) => n.endsWith(".git"))).toEqual(["site-tuning.git"]);
    const before = readFileSync(ref, "utf8");
    writeFileSync(join(s.sites, "tuning", "site.json"), '{"nom":"Tuning"}\n');
    await s.service.assurer("site-tuning");
    expect(readFileSync(ref, "utf8")).toBe(before);
    expect(existsSync(join(s.sites, "tuning", ".git"))).toBe(false);
    const v = ok(await s.service.ouvrir("site-tuning"));
    expect(v.comparaison.fichiers.map((f) => f.chemin)).toEqual(["site.json"]);
    expect(v).toMatchObject({ nom: "Tuning", destination: "l'agent", sansDestination: null });
  });

  // Electron relecture.test.ts:300
  it("assurer of a site takes its snapshot; of an app id or an unknown site it does nothing", async () => {
    const s = prepare();
    await s.service.assurer("app-essai");
    await s.service.assurer("site-absent");
    expect(existsSync(s.relecture)).toBe(false);
    await s.service.assurer("site-tuning");
    expect(existsSync(join(s.relecture, "site-tuning.git", "refs", "webaios", "relu"))).toBe(true);
  });

  // Electron relecture.test.ts:309
  it("envoyer of a site follows projetPourSite", async () => {
    const s = prepare();
    const css = join(s.sites, "tuning", "retouches", "tuning.css");
    writeFileSync(css, Array.from({ length: 5 }, (_, i) => `/* ${i} */`).join("\n") + "\n");
    await s.service.priseEnChargeSites(["tuning"]);
    writeFileSync(css, ["/* 0 */", "/* 1 */", "a { color: red }", "/* 3 */", "/* 4 */"].join("\n") + "\n");
    const v = ok(await s.service.ouvrir("site-tuning"));
    expect(await s.service.commenter("site-tuning", v.jeton, { fichier: "retouches/tuning.css", debut: 3, fin: 3, texte: "plus doux" })).toEqual({ ok: true });
    expect(await s.service.envoyer("site-tuning")).toEqual({ ok: true });
    expect(s.sent[0]!.projet).toEqual({ type: "site", projet: "site-tuning", id: "tuning", nom: "Tuning" });
  });

  // Electron relecture.test.ts:321
  it("effacer removes the repository and the comments file, and forgets the comparisons", async () => {
    const s = prepare();
    await s.service.priseEnChargeSites(["tuning"]);
    writeFileSync(join(s.sites, "tuning", "site.json"), '{"a":1}\n');
    const v = ok(await s.service.ouvrir("site-tuning"));
    expect(await s.service.commenter("site-tuning", v.jeton, { fichier: "site.json", debut: 1, fin: 1, texte: "à voir" })).toEqual({ ok: true });
    expect(existsSync(join(s.relecture, "site-tuning.commentaires.json"))).toBe(true);
    await s.service.effacer("site-tuning");
    expect(existsSync(join(s.relecture, "site-tuning.git"))).toBe(false);
    expect(existsSync(join(s.relecture, "site-tuning.commentaires.json"))).toBe(false);
    await expect(s.service.fichier("site-tuning", v.jeton, "site.json")).rejects.toThrow(COMPARAISON_INCONNUE);
    expect(await s.service.commentaires("site-tuning")).toEqual([]);
    await s.service.assurer("site-tuning");
    expect(await s.service.ouvrir("site-tuning")).toMatchObject({ etat: "ok", comparaison: { fichiers: [] } });
  });

  // Electron relecture.test.ts:340
  it("a snapshot taken between effacer and the trash is erased by the second effacer, also after the trash", async () => {
    const s = prepare();
    await s.service.priseEnChargeSites(["tuning"]);
    const ref = join(s.relecture, "site-tuning.git", "refs", "webaios", "relu");
    const first = s.service.effacer("site-tuning");
    const photo = s.service.priseEnChargeSites(["tuning"]);
    await Promise.all([first, photo]);
    expect(existsSync(ref)).toBe(true);
    const { renameSync } = await import("node:fs");
    renameSync(join(s.sites, "tuning"), join(s.root, "corbeille-tuning"));
    const late = s.service.priseEnChargeSites(["tuning"]);
    await Promise.all([late, s.service.effacer("site-tuning")]);
    expect(existsSync(join(s.relecture, "site-tuning.git"))).toBe(false);
    expect(existsSync(join(s.relecture, "site-tuning.commentaires.json"))).toBe(false);
    await s.service.priseEnChargeSites(["tuning"]);
    expect(existsSync(join(s.relecture, "site-tuning.git"))).toBe(false);
  });
});

describe("design guards", () => {
  it("copy Electron's constants and messages", () => {
    expect(g.ID_PROJECT.source).toBe(ID_PROJET.source);
    expect(g.REVIEW_TOKEN.source).toBe(JETON_RELECTURE.source);
    expect(g.REMARK_TEXT_MAX).toBe(TEXTE_REMARQUE_MAX);
    expect(g.raisonEchec(new Error("x"))).toBe(electronRaison(new Error("x")));
    expect(g.raisonEchec("y")).toBe(electronRaison("y"));
    const ipc = readFileSync(new URL("../../navigateur/src/main/ipc.ts", import.meta.url), "utf8");
    for (const line of [
      "const ID_EXTERNE = /^[0-9a-f]{16}$/;",
      "const ID_CLIENT = /^[0-9a-f-]{8,64}$/;",
      "const CHEMIN_RELECTURE_MAX = 4096;",
      "const ID_COMMENTAIRE = /^c-[0-9a-f]{8}$/;",
      "nom.length > 200",
    ]) expect(ipc).toContain(line);
    expect([g.EXTERNAL_ID.source, g.CLIENT_ID.source, g.REVIEW_PATH_MAX, g.COMMENT_ID.source, g.CLIENT_NAME_MAX]).toEqual(["^[0-9a-f]{16}$", "^[0-9a-f-]{8,64}$", 4096, "^c-[0-9a-f]{8}$", 200]);
  });

  it("each check accepts its edge case and refuses its neighbour with Electron's message", () => {
    expect(g.checkProject(EXT)).toBe(EXT);
    expect(() => g.checkProject("ext-xyz")).toThrow("projet invalide");
    expect(() => g.checkProject(3)).toThrow("projet invalide");
    expect(g.checkToken(unknown)).toBe(unknown);
    expect(() => g.checkToken(`${"a".repeat(40)}:${"b".repeat(39)}`)).toThrow("jeton invalide");
    expect(g.checkPath("a".repeat(4096))).toHaveLength(4096);
    for (const bad of ["a".repeat(4097), "a\0b", "", 1]) expect(() => g.checkPath(bad)).toThrow("chemin invalide");
    expect(g.checkLines(3, 3)).toEqual([3, 3]);
    for (const [a, b] of [[0, 1], [1.5, 2], [2, 1], [1, 1.5], ["1", 2]]) expect(() => g.checkLines(a, b)).toThrow("lignes invalides");
    expect(g.checkText("a".repeat(4000))).toHaveLength(4000);
    for (const bad of ["a".repeat(4001), true]) expect(() => g.checkText(bad)).toThrow("texte invalide");
    expect(g.checkComment("c-0123abcd")).toBe("c-0123abcd");
    for (const bad of ["c-0123abc", "c-0123abcde", "x-0123abcd", 1]) expect(() => g.checkComment(bad)).toThrow("commentaire invalide");
    expect(g.checkResolved(false)).toBe(false);
    expect(() => g.checkResolved("true")).toThrow("résolu invalide");
    expect(g.checkClientName("a".repeat(200))).toHaveLength(200);
    for (const bad of ["a".repeat(201), 5]) expect(() => g.checkClientName(bad)).toThrow("Nom invalide");
  });
});
