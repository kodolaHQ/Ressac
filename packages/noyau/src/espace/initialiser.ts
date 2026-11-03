import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CheminsEspace } from "../chemins.js";

/** Dossier des modèles du paquet ; un navigateur qui embarque le noyau peut en fournir un autre. */
export const MODELES_PAR_DEFAUT = join(import.meta.dirname, "..", "..", "modeles");

/**
 * Empreintes sha256 des anciennes versions du modèle AGENTS.md. Un AGENTS.md qui en a une est resté tel
 * quel : il est remplacé par le modèle courant. À compléter à chaque nouvelle version du modèle : chaque version
 * commitée va dans `test/espace/agents-livres/` (un test le vérifie contre l'historique git).
 */
const ANCIENS_AGENTS = new Set([
  "4cb44a141c2e0865ae472910b3f1026b918c2d09d12b96732b7a5556ffcc4681",
  "fc35b4b096def3e0850796b6bf784947adb2092aad8f71da879865891fbb7a27",
  "3117019dee9b14b0cc47dd8aa33edcfbf8f476a9ea521479c15e7a0c1004eca1",
  "00d106e8d934a49848c9e30f569127b2ccbdde91954a98e9fad1c0914b7d822b",
  "6e43cefaf3f1ad8f07dacf4165f66a360e1fd0c3cf3a54c9920de42be25b7ba7",
  "f71dc1f75c8ba571083b9c0929a9d3a07cd31e9918e3686367a43998bf8d0ef8",
  "96e9af1e85b74650b58471fa4433c30d37334adf40d448a0469bec5e3bc16a55",
  "6a12cecc4b6cc13e6fd26f2ec50fda3e3d6381421644e1e5c81d897a3c4ba5c3",
  "129ee6e03468f3fe0e0038f001031901a97283e65dd2fe4fdc1ab22de5d21f41",
  "aeb6f717e6ae38f6ed40d7e51bdb66e667cb54252dbe57affc36aa8d5df0ceec",
  "cf62b40d452d20d454d8d2b836a06c5acf9401b1017314c5f893a913ed37e1fd",
  "9e3b4fb890a077d0e76df482d375ffa1aab5390f1d320d67599e77b7bc58730b",
  "3866a3fd951eb95c9fee1aeae273a9a7eb5ad1b0e09ad8ee85a2f0b3190a634c",
  "68b17b47ac5be1d551a6d4ee01f121095b1db3cef47a9893ad1f592293ef7497",
  "0ccf0a48a1f4b2d39d954382532e0db7e1a84c77640a7eaed7c08dbbfdb88c90",
  "e0dec98e6d7ae2e6b9841cdeaa9d12ea9e216106c67ea3e99c50c18498fee821",
  "bd4c4065842403bf0ad0fcd4f220dd69d5f20c354f0fd514f7f7d79729e89ccd",
  "dc4be1f4faca4a333970d56c03463a35c76efc63e43fb477b9fde3d02f203dec",
  "de412462fce4a0fba4e35d3e506065d9d5f1839a28fe3665b479c3117420b5f5",
  "1efeabab021d5ba8f9298cd91ee5c8b76d0fe6f677f2426ddb195421d140629b",
  "23a63c74e12a096076b15c6e01d54d76d681eb57e3db2c1476fdade0d60f9397",
  "5f67ab38d6cb781fb6d823744d7c2198f33b74c734326f4b75dac7f3b88ca6b3",
  "4aef2f72c6a350aea15f7435843c188d4f18bcce594c7bd94611cebaca7184dd",
  "7f7acaaff80c1afc24df9ee2582d7bdb9addfd8188967367681a4d37a8c8142e",
  "8f7a1bdede8b5b561aeac0b0f6799bc5835c49fbc866fe1074b1dcefeaf8304a",
  "af123302f811fb8f13e61bc1dce6729d03d373cbc31311aa5c5ee20150e6006d",
  "cca85b7cebc75e26d45f31d9ea508c2948d45894f4957f8535a9f7145f5b855c",
  "08a4abd6413648a41ecaf9e8dbda1c158ec62f2ba9a43da62e0c4dcf152f8dfe",
  "269aa441f0d6a59dcf7bd5ff471062413610a41112e6247c4970cc9936c9dc3b",  "dc0f1fafa9ffb41da09cdf4b4e944ad3eeca5433b25b64f36f2d939d79fe05ec",
]);

const empreinte = (contenu: Buffer) => createHash("sha256").update(contenu).digest("hex");

async function agentsRestePourAncien(chemin: string): Promise<boolean> {
  try {
    return ANCIENS_AGENTS.has(empreinte(await readFile(chemin)));
  } catch {
    return false;
  }
}

/** Horodatage ISO sans « : » (valable comme nom de dossier). */
function horodatage(): string {
  return new Date().toISOString().replaceAll(":", "-");
}

async function renommerSiPresent(de: string, vers: string): Promise<void> {
  try {
    await rename(de, vers);
  } catch (e) {
    // Absent, ou déjà déplacé par un lancement simultané : rien à faire.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/** Un `disposition.json` qui n'est pas au format v2 (ancien `{ ordre }`). Illisible : laissé en place. */
async function dispositionAncienne(chemin: string): Promise<boolean> {
  try {
    const v: unknown = JSON.parse(await readFile(chemin, "utf8"));
    return typeof v !== "object" || v === null || (v as { version?: unknown }).version !== 2;
  } catch {
    return false;
  }
}

/** Les anciens blocs et l'ancienne disposition sont mis de côté dans `accueil/.corbeille/blocs-<horodatage>`, jamais détruits. */
async function mettreDeCoteLesBlocs(c: CheminsEspace): Promise<void> {
  const blocs = existsSync(c.blocs);
  const dispo = existsSync(c.disposition) && (await dispositionAncienne(c.disposition));
  if (!blocs && !dispo) return;
  const cible = join(c.accueil, ".corbeille", `blocs-${horodatage()}`);
  await mkdir(dirname(cible), { recursive: true });
  if (blocs) await renommerSiPresent(c.blocs, cible);
  if (dispo) {
    await mkdir(cible, { recursive: true });
    await renommerSiPresent(c.disposition, join(cible, "disposition.json"));
  }
}

async function fichiersDe(dossier: string, prefixe = ""): Promise<string[]> {
  const sortie: string[] = [];
  for (const e of await readdir(dossier, { withFileTypes: true })) {
    const rel = join(prefixe, e.name);
    if (e.isDirectory()) sortie.push(...(await fichiersDe(join(dossier, e.name), rel)));
    else sortie.push(rel);
  }
  return sortie;
}

/**
 * Fichier modèle → destination dans l'espace. Les widgets de départ ne sont posés que si `accueil/widgets/`
 * n'existe pas : un widget supprimé par l'utilisateur ne doit pas revenir.
 */
async function correspondances(c: CheminsEspace, modeles: string): Promise<[string, string][]> {
  const paires: [string, string][] = [
    ["AGENTS.md", join(c.racine, "AGENTS.md")],
    ["CLAUDE.md", join(c.racine, "CLAUDE.md")],
    ["profil-claude.json", join(c.profils, "claude.json")],
    ["disposition.json", c.disposition],
  ];
  if (!existsSync(c.widgets)) {
    for (const f of await fichiersDe(join(modeles, "widgets"))) paires.push([join("widgets", f), join(c.widgets, f)]);
  }
  return paires;
}

/**
 * Empreintes sha256 de chaque version livrée du `recolte.mjs` des widgets de départ (avant les workflows). Un
 * widget de départ dont le `recolte.mjs` en a une est resté tel quel : il passe en workflow au lancement.
 */
export const RECOLTES_LIVREES: Record<"meteo" | "actus-tech" | "daily-dev", ReadonlySet<string>> = {
  meteo: new Set(["c30b449bd9bce4addd59be19e0bdf7bf4010bdc796ce29ca57805be536652f98"]),
  "actus-tech": new Set([
    "64a3c44433f8682395ca70f1586157105a35991ce2bc8ab5b1eff8e332b298d0",
    "7f8ffd4664afd595f2cf470109ab07513403659969d4cb46fa37528553fad184",
    "bfaaa411ccdc9546c4dfc47a7b01ac3c62ad5a64fb05cafcfa9f10fabca66b8f",
  ]),
  "daily-dev": new Set([
    "0b8c31a0b4c06412f82e9a57487774d11e6a3506b186400d46c86b981230b431",
    "e700f36785086198ea2f6beb1d111bfde7441d6d4ff88e1e5e6e5d0d5a475706",
    "07942c89c7f74b6486a53e00684b2ce2d874634c1bdc2d2c898688c68b93d116",
  ]),
};

/** Le contenu d'un fichier ordinaire (jamais un lien symbolique) ; null s'il est absent ou autre chose. */
async function fichierOrdinaire(chemin: string): Promise<Buffer | null> {
  try {
    if (!(await lstat(chemin)).isFile()) return null;
    return await readFile(chemin);
  } catch {
    return null;
  }
}

async function absent(chemin: string): Promise<boolean> {
  try {
    await lstat(chemin);
    return false;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw e;
  }
}

/**
 * Bascule un widget de départ resté tel que livré (`recolte.mjs` d'une version connue, sans `workflow.json`) vers
 * son modèle en workflow : les `.mjs` puis `workflow.json` du modèle sont copiés sans rien écraser, puis
 * `recolte.mjs` part dans `accueil/.corbeille/<id>-recolte-<horodatage>.mjs`. Un widget modifié, ou dont un fichier
 * du modèle existe déjà avec un autre contenu, n'est pas touché. Rien d'autre que ce dossier et la corbeille. Avec
 * déjà le `workflow.json` du modèle (bascule interrompue), seul `recolte.mjs` est rangé.
 */
async function basculerWidgetDeDepart(c: CheminsEspace, modeles: string, id: keyof typeof RECOLTES_LIVREES): Promise<string[]> {
  const dossier = join(c.widgets, id);
  try {
    if (!(await lstat(dossier)).isDirectory()) return [];
  } catch {
    return [];
  }
  const recolte = await fichierOrdinaire(join(dossier, "recolte.mjs"));
  if (!recolte || !RECOLTES_LIVREES[id].has(empreinte(recolte))) return [];
  // Le modèle n'est lu qu'ensuite : des modèles sans ce widget, et rien ne bouge.
  const modele = join(modeles, "widgets", id);
  if (!existsSync(join(modele, "workflow.json"))) return [];
  if (!(await absent(join(dossier, "workflow.json")))) {
    // workflow.json du modèle déjà là : une bascule interrompue avant de ranger recolte.mjs, qu'elle finit.
    const present = await fichierOrdinaire(join(dossier, "workflow.json"));
    if (present && present.equals(await readFile(join(modele, "workflow.json")))) await rangerRecolte(c, id);
    return [];
  }
  const codes = (await readdir(modele)).filter((f) => f.endsWith(".mjs")).sort();
  // Un .mjs du même nom déjà là : seulement s'il est identique au modèle (une bascule interrompue), sinon il est à l'utilisateur.
  for (const f of codes) {
    const present = join(dossier, f);
    if (await absent(present)) continue;
    const contenu = await fichierOrdinaire(present);
    if (!contenu || !contenu.equals(await readFile(join(modele, f)))) return [];
  }

  const crees: string[] = [];
  // workflow.json en dernier : il n'apparaît qu'une fois son code en place.
  for (const f of [...codes, "workflow.json"]) {
    const destination = join(dossier, f);
    try {
      await copyFile(join(modele, f), destination, constants.COPYFILE_EXCL);
      crees.push(destination);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  await rangerRecolte(c, id);
  return crees;
}

/** `recolte.mjs` d'un widget de départ basculé part dans `accueil/.corbeille/<id>-recolte-<horodatage>.mjs`. */
async function rangerRecolte(c: CheminsEspace, id: string): Promise<void> {
  const corbeille = join(c.accueil, ".corbeille");
  await mkdir(corbeille, { recursive: true });
  await renommerSiPresent(join(c.widgets, id, "recolte.mjs"), join(corbeille, `${id}-recolte-${horodatage()}.mjs`));
}

/** Crée l'espace de travail à partir des modèles, sans écraser un fichier existant (sauf un AGENTS.md d'un ancien modèle). */
export async function initialiserEspace(c: CheminsEspace, modeles = MODELES_PAR_DEFAUT): Promise<{ crees: string[] }> {
  const crees: string[] = [];
  await mettreDeCoteLesBlocs(c);
  for (const [modele, destination] of await correspondances(c, modeles)) {
    const miseAJour = modele === "AGENTS.md" && (await agentsRestePourAncien(destination));
    if (existsSync(destination) && !miseAJour) continue;
    await mkdir(dirname(destination), { recursive: true });
    try {
      // COPYFILE_EXCL : si le fichier apparaît entre-temps, on ne l'écrase pas.
      await copyFile(join(modeles, modele), destination, miseAJour ? 0 : constants.COPYFILE_EXCL);
      crees.push(destination);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  for (const id of Object.keys(RECOLTES_LIVREES) as (keyof typeof RECOLTES_LIVREES)[]) {
    // Au mieux, widget par widget : une bascule ratée ne bloque jamais le lancement (le widget garde son recolte.mjs).
    try {
      crees.push(...(await basculerWidgetDeDepart(c, modeles, id)));
    } catch (e) {
      console.error(`[webaios] bascule du widget ${id} en workflow :`, e);
    }
  }
  await mkdir(c.projets, { recursive: true });
  await mkdir(c.extensions, { recursive: true });
  await mkdir(c.actions, { recursive: true });
  await mkdir(c.composants, { recursive: true });
  await mkdir(c.sites, { recursive: true });
  return { crees };
}
