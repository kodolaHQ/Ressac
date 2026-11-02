import { stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { dossierTemporaire } from "../aide/temporaire.js";
import { CommentairesRelecture, REMARQUE_VIDE, recoller, type Commentaire } from "../../src/relecture/commentaires.js";
import { parserDiff } from "../../src/relecture/diff.js";

const ctx = (lignes: string[]) => lignes.map((t) => ` ${t}`);
function patch(debut: number, lignes: string[]): string {
  return [`@@ -${debut},${lignes.length} +${debut},${lignes.length} @@`, ...lignes, ""].join("\n");
}
function com(debut: number, lignes: Commentaire["lignes"]): Commentaire {
  return { id: "c-1", fichier: "f.txt", debut, fin: debut + lignes.length - 1, lignes, texte: "t", cree: "", envoye: false, resolu: false, ligneChangee: false };
}
const L = (marque: " " | "+" | "-", texte: string) => ({ marque, texte });

describe("recoller", () => {
  test("même contenu, décalé de 5 lignes par un ajout au-dessus : recollé 5 lignes plus bas, ligneChangee faux", () => {
    const blocs = parserDiff(patch(15, ctx(["a", "b", "c"])));
    const r = recoller(com(10, [L(" ", "b"), L(" ", "c")]), blocs);
    expect([r.debut, r.fin, r.ligneChangee]).toEqual([16, 17, false]);
  });
  test("deux fenêtres identiques : la plus proche de l'ancien début gagne", () => {
    const blocs = parserDiff(patch(1, ctx(["x", "y", "z", "x", "y"])));
    expect(recoller(com(5, [L(" ", "x"), L(" ", "y")]), blocs).debut).toBe(4);
    expect(recoller(com(1, [L(" ", "x"), L(" ", "y")]), blocs).debut).toBe(1);
  });
  test("contenu modifié : rattaché à la ligne la plus proche, ligneChangee vrai", () => {
    const blocs = parserDiff(patch(1, ctx(["a", "b", "c", "d"])));
    const r = recoller(com(3, [L(" ", "autre")]), blocs);
    expect([r.debut, r.fin, r.ligneChangee]).toEqual([3, 3, true]);
  });
  test("plage de 3 lignes dont une a changé : ramenée à une ligne, ligneChangee vrai", () => {
    const blocs = parserDiff(patch(1, ctx(["a", "b", "CHANGE", "d"])));
    const r = recoller(com(1, [L(" ", "a"), L(" ", "b"), L(" ", "c")]), blocs);
    expect([r.debut, r.fin, r.ligneChangee]).toEqual([1, 1, true]);
  });
  test("commentaire sur une ligne « - » : retrouvé tant que la suppression est affichée", () => {
    const blocs = parserDiff("@@ -1,3 +1,2 @@\n a\n-b\n c\n");
    const r = recoller(com(2, [L("-", "b")]), blocs);
    expect([r.debut, r.ligneChangee]).toEqual([2, false]);
  });
  test("sans aucun bloc : inchangé, ligneChangee vrai", () => {
    const r = recoller(com(7, [L(" ", "a")]), []);
    expect([r.debut, r.fin, r.ligneChangee]).toEqual([7, 7, true]);
  });
});

describe("CommentairesRelecture", () => {
  const brut = { fichier: "f.txt", debut: 1, fin: 1, lignes: [L(" ", "a")], texte: "à revoir" };
  async function depot() {
    const dossier = await dossierTemporaire();
    return { fichier: join(dossier, "p", "x.commentaires.json") };
  }

  test("fichier sans diff (diff null) : le commentaire reste, rattaché au fichier, ligneChangee vrai", async () => {
    const { fichier } = await depot();
    const r = new CommentairesRelecture(fichier);
    await r.ajouter(brut);
    await r.ajouter({ ...brut, fichier: "autre.txt" });
    const res = await r.recollerFichier("f.txt", null);
    expect(res).toHaveLength(1);
    expect(res[0]!.ligneChangee).toBe(true);
    const tous = await r.liste();
    expect(tous).toHaveLength(2);
    expect(tous.find((c) => c.fichier === "autre.txt")!.ligneChangee).toBe(false);
  });
  test("ajouter refuse un texte vide ou d'espaces avec REMARQUE_VIDE", async () => {
    const r = new CommentairesRelecture((await depot()).fichier);
    await expect(r.ajouter({ ...brut, texte: "" })).rejects.toThrow(REMARQUE_VIDE);
    await expect(r.ajouter({ ...brut, texte: "  \n " })).rejects.toThrow(REMARQUE_VIDE);
    expect(await r.liste()).toEqual([]);
  });
  test("aEnvoyer rend les non résolus, envoyés compris ; après marquerEnvoyes, envoye vrai ; un résolu n'est jamais rendu", async () => {
    const r = new CommentairesRelecture((await depot()).fichier);
    const a = await r.ajouter(brut);
    const b = await r.ajouter(brut);
    expect((await r.aEnvoyer()).map((c) => c.id)).toEqual([a.id, b.id]);
    await r.marquerEnvoyes([a.id]);
    const apres = await r.aEnvoyer();
    expect(apres.map((c) => c.envoye)).toEqual([true, false]);
    await r.resoudre(a.id, true);
    expect((await r.aEnvoyer()).map((c) => c.id)).toEqual([b.id]);
  });
  test("apresRelu supprime les résolus et garde les non résolus", async () => {
    const r = new CommentairesRelecture((await depot()).fichier);
    const a = await r.ajouter(brut);
    const b = await r.ajouter(brut);
    await r.resoudre(a.id, true);
    await r.apresRelu();
    expect((await r.liste()).map((c) => c.id)).toEqual([b.id]);
  });
  test("modifier et supprimer", async () => {
    const r = new CommentairesRelecture((await depot()).fichier);
    const a = await r.ajouter(brut);
    await r.modifier(a.id, "autre");
    expect((await r.liste())[0]!.texte).toBe("autre");
    await expect(r.modifier(a.id, " ")).rejects.toThrow(REMARQUE_VIDE);
    await r.supprimer(a.id);
    expect(await r.liste()).toEqual([]);
  });
  test("le fichier a le mode 0600 et survit à une relecture du disque", async () => {
    const { fichier } = await depot();
    await new CommentairesRelecture(fichier).ajouter(brut);
    expect((await stat(fichier)).mode & 0o777).toBe(0o600);
    expect((await new CommentairesRelecture(fichier).liste())[0]!.texte).toBe("à revoir");
  });
});
