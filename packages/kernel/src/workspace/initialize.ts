import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SpacePaths } from "../paths.js";

/** Templates folder of the package; a browser that embeds the kernel can provide another. */
export const DEFAULT_MODELS = join(import.meta.dirname, "..", "..", "modeles");

/**
 * sha256 hashes of old versions of the AGENTS.md template. An AGENTS.md that has one is left as
 * is: it is replaced by the current template. To complete with each new template version: add
 * the old version's hash (`shasum -a 256 modeles/AGENTS.md`) before modifying it.
 */
export const OLD_AGENTS = new Set([
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
  "269aa441f0d6a59dcf7bd5ff471062413610a41112e6247c4970cc9936c9dc3b",
  "dc0f1fafa9ffb41da09cdf4b4e944ad3eeca5433b25b64f36f2d939d79fe05ec",
  "4311b14265ae65e1b5821a649677271466a89eed0e95413ac32839f9d51b1c8e",
  "55902f3a55b0494f90112284ad0fb76b589165773b3a4b6979dedea41e5ad4b7",
  "a37f2860c52cf15e21562f6b84c0b84f432f3841f091b04b60ad522ce9f5d58f",
  "977bba92e8209de62e939b1235bdbcd3b368e2f222865205ba927c3ad8592f5b",
  "f38be067fe3d2554a6cbac4478ce6273fb67dbee0cbce8816afd744b41a1f823",
  "eaf40a1f51b1e62226e5087c7d7a73cf8b48b84e1e4fb214e89a119d0eb71d96",
]);

const hash = (content: Buffer) => createHash("sha256").update(content).digest("hex");

async function agentsRestForOld(path: string): Promise<boolean> {
  try {
    return OLD_AGENTS.has(hash(await readFile(path)));
  } catch {
    return false;
  }
}

/** ISO timestamp without « : » (valid as a folder name). */
function timestamp(): string {
  return new Date().toISOString().replaceAll(":", "-");
}

async function renameIfPresent(de: string, to: string): Promise<void> {
  try {
    await rename(de, to);
  } catch (e) {
    // Absent, or already moved by a simultaneous launch: nothing to do.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/**
 * A `disposition.json` in another format (old `{ ordre }` or unknown version). v2 (the 12-column grid) and v3 (the free
 * layout) are kept. Unreadable: left in place.
 */
async function oldLayout(path: string): Promise<boolean> {
  try {
    const v: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof v !== "object" || v === null) return true;
    const version = (v as { version?: unknown }).version;
    return version !== 2 && version !== 3;
  } catch {
    return false;
  }
}

/** Old blocks and the old layout are set aside in `accueil/.corbeille/blocs-<timestamp>`, never destroyed. */
async function setAsideBlocks(c: SpacePaths): Promise<void> {
  const blocs = existsSync(c.blocs);
  const available = existsSync(c.disposition) && (await oldLayout(c.disposition));
  if (!blocs && !available) return;
  const target = join(c.accueil, ".corbeille", `blocs-${timestamp()}`);
  await mkdir(dirname(target), { recursive: true });
  if (blocs) await renameIfPresent(c.blocs, target);
  if (available) {
    await mkdir(target, { recursive: true });
    await renameIfPresent(c.disposition, join(target, "disposition.json"));
  }
}

async function filesOf(dossier: string, prefix = ""): Promise<string[]> {
  const sortie: string[] = [];
  for (const e of await readdir(dossier, { withFileTypes: true })) {
    const rel = join(prefix, e.name);
    if (e.isDirectory()) sortie.push(...(await filesOf(join(dossier, e.name), rel)));
    else sortie.push(rel);
  }
  return sortie;
}

/**
 * Template file → destination in the workspace. Starter widgets are only placed if `accueil/widgets/`
 * does not exist: a widget deleted by the user must not come back.
 */
async function matches(c: SpacePaths, models: string): Promise<[string, string][]> {
  const pairs: [string, string][] = [
    ["AGENTS.md", join(c.racine, "AGENTS.md")],
    ["CLAUDE.md", join(c.racine, "CLAUDE.md")],
    ["profil-claude.json", join(c.profils, "claude.json")],
    ["disposition.json", c.disposition],
  ];
  if (!existsSync(c.widgets)) {
    for (const f of await filesOf(join(models, "widgets"))) pairs.push([join("widgets", f), join(c.widgets, f)]);
  }
  return pairs;
}

/**
 * sha256 hashes of each shipped version of the starter widgets' `recolte.mjs` (before workflows). A
 * starter widget whose `recolte.mjs` has one is left as is: it switches to a workflow at launch.
 */
export const HARVESTS_SHIPPED: Record<"meteo" | "actus-tech" | "daily-dev", ReadonlySet<string>> = {
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

/**
 * sha256 hashes of the shipped versions of the starter widgets' `affichage.html` (the first two: before the Firefox
 * forms, listening without comparing `e.source`, links through `webaiosOuvrir`). A display left at one of them is replaced by the
 * current template; a display modified by the user or the agent (unknown hash) is not touched.
 */
export const DISPLAYS_SHIPPED: Record<"meteo" | "actus-tech" | "daily-dev", ReadonlySet<string>> = {
  meteo: new Set([
    "437c53d9ec9db7261bf1b90258ebfc4a2febed3b0c44fc49e5a79e68a022f449",
    "41b7f74fbbd384ab88ba8e31a57d0c2b7ee4df1f6081a588f23c888fa3721257",
    "a7e25ca8a7b10d0f48812bef3130fc16a2d6a05799d56a512171a7861e594c56",
  ]),
  "actus-tech": new Set([
    "da8afce4e0676662aa65787df9c913f684f5f6b1c2bf2bf8961a69fa531ba209",
    "0f8306d6c64698eb1a5252075fb273e99fca1811748943e6986591caf18dd081",
    "9057aa911e1fcfe0641d2943fa867ecba587b2e6f04974b17512fe57c552574e",
  ]),
  "daily-dev": new Set([
    "9bc668a4f1515d8f66b9a040a828099432f659ba976263af43aea2696b3a9e99",
    "12184cdd667940b894a9c86e980eb5cfb0da60acc20591665b726124c9a741b1",
    "c5e7c446b7df1754c52e88857daf71f286419d2585d9903ebbb25a650d857ebe",
  ]),
};

/** The content of an ordinary file (never a symbolic link); null if it is absent or something else. */
async function ordinaryFile(path: string): Promise<Buffer | null> {
  try {
    if (!(await lstat(path)).isFile()) return null;
    return await readFile(path);
  } catch {
    return null;
  }
}

async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw e;
  }
}

/**
 * Switches a starter widget left as shipped (`recolte.mjs` of a known version, without `workflow.json`) to
 * its workflow template: the template's `.mjs` then `workflow.json` are copied without overwriting anything, then
 * `recolte.mjs` goes to `accueil/.corbeille/<id>-recolte-<timestamp>.mjs`. A modified widget, or one where a file
 * of the template already exists with other content, is not touched. Nothing other than this folder and the trash. With
 * the template's `workflow.json` already there (interrupted switch), only `recolte.mjs` is put away.
 */
async function toggleStartWidget(c: SpacePaths, models: string, id: keyof typeof HARVESTS_SHIPPED): Promise<string[]> {
  const dossier = join(c.widgets, id);
  try {
    if (!(await lstat(dossier)).isDirectory()) return [];
  } catch {
    return [];
  }
  const harvest = await ordinaryFile(join(dossier, "recolte.mjs"));
  if (!harvest || !HARVESTS_SHIPPED[id].has(hash(harvest))) return [];
  // The template is read only afterwards: templates without this widget, and nothing moves.
  const model = join(models, "widgets", id);
  if (!existsSync(join(model, "workflow.json"))) return [];
  if (!(await absent(join(dossier, "workflow.json")))) {
    // template's workflow.json already there: a switch interrupted before putting recolte.mjs away, which it finishes.
    const present = await ordinaryFile(join(dossier, "workflow.json"));
    if (present && present.equals(await readFile(join(model, "workflow.json")))) await storeHarvest(c, id);
    return [];
  }
  const codes = (await readdir(model)).filter((f) => f.endsWith(".mjs")).sort();
  // A .mjs of the same name already there: only if identical to the template (an interrupted switch), otherwise it is the user's.
  for (const f of codes) {
    const present = join(dossier, f);
    if (await absent(present)) continue;
    const content = await ordinaryFile(present);
    if (!content || !content.equals(await readFile(join(model, f)))) return [];
  }

  const crees: string[] = [];
  // workflow.json last: it appears only once its code is in place.
  for (const f of [...codes, "workflow.json"]) {
    const destination = join(dossier, f);
    try {
      await copyFile(join(model, f), destination, constants.COPYFILE_EXCL);
      crees.push(destination);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  await storeHarvest(c, id);
  return crees;
}

/** `recolte.mjs` of a switched starter widget goes to `accueil/.corbeille/<id>-recolte-<timestamp>.mjs`. */
async function storeHarvest(c: SpacePaths, id: string): Promise<void> {
  const trash = join(c.accueil, ".corbeille");
  await mkdir(trash, { recursive: true });
  await renameIfPresent(join(c.widgets, id, "recolte.mjs"), join(trash, `${id}-recolte-${timestamp()}.mjs`));
}

/**
 * Replaces the `affichage.html` of a starter widget left at a shipped version (known hash) with the template's.
 * A modified display, a symbolic link or an absent widget are not touched.
 */
async function migrateStartDisplay(c: SpacePaths, models: string, id: keyof typeof DISPLAYS_SHIPPED): Promise<boolean> {
  const file = join(c.widgets, id, "affichage.html");
  const content = await ordinaryFile(file);
  if (!content || !DISPLAYS_SHIPPED[id].has(hash(content))) return false;
  const model = join(models, "widgets", id, "affichage.html");
  if (!existsSync(model)) return false;
  await copyFile(model, file);
  return true;
}

/** Creates the workspace from the templates, without overwriting an existing file (except an AGENTS.md of an old template). */
export async function initSpace(c: SpacePaths, models = DEFAULT_MODELS): Promise<{ crees: string[] }> {
  const crees: string[] = [];
  await setAsideBlocks(c);
  for (const [model, destination] of await matches(c, models)) {
    const update = model === "AGENTS.md" && (await agentsRestForOld(destination));
    if (existsSync(destination) && !update) continue;
    await mkdir(dirname(destination), { recursive: true });
    try {
      // COPYFILE_EXCL: if the file appears in the meantime, we do not overwrite it.
      await copyFile(join(models, model), destination, update ? 0 : constants.COPYFILE_EXCL);
      crees.push(destination);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  for (const id of Object.keys(DISPLAYS_SHIPPED) as (keyof typeof DISPLAYS_SHIPPED)[]) {
    // Best effort, widget by widget: a failed display never blocks launch.
    try {
      if (await migrateStartDisplay(c, models, id)) crees.push(join(c.widgets, id, "affichage.html"));
    } catch (e) {
      console.error(`[webaios] migration de l'affichage du widget ${id} :`, e);
    }
  }
  for (const id of Object.keys(HARVESTS_SHIPPED) as (keyof typeof HARVESTS_SHIPPED)[]) {
    // Best effort, widget by widget: a failed switch never blocks launch (the widget keeps its recolte.mjs).
    try {
      crees.push(...(await toggleStartWidget(c, models, id)));
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
