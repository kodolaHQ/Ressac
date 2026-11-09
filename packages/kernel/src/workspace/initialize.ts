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
  "1adea27921eb609aca3b73c58b690fe912c78a3eeba08a4c930f400862b6be36",
]);

const hash = (content: Buffer) => createHash("sha256").update(content).digest("hex");

async function agentsRestForOld(path: string, template: string): Promise<boolean> {
  try {
    const h = hash(await readFile(path));
    return OLD_AGENTS.has(h) && h !== hash(await readFile(template));
  } catch {
    return false;
  }
}

/** ISO timestamp without « : » (valid as a folder name). */
function timestamp(): string {
  return new Date().toISOString().replaceAll(":", "-");
}

async function renameIfPresent(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (e) {
    // Absent, or already moved by a simultaneous launch: nothing to do.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/**
 * A `layout.json` in another format (old `{ ordre }` or unknown version). v2 (the 12-column grid) and v3 (the free
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

/** Old blocks and the old layout are set aside in `home/.trash/blocks-<timestamp>`, never destroyed. */
async function setAsideBlocks(c: SpacePaths): Promise<void> {
  const blocks = existsSync(c.blocks);
  const available = existsSync(c.layout) && (await oldLayout(c.layout));
  if (!blocks && !available) return;
  const target = join(c.home, ".trash", `blocks-${timestamp()}`);
  await mkdir(dirname(target), { recursive: true });
  if (blocks) await renameIfPresent(c.blocks, target);
  if (available) {
    await mkdir(target, { recursive: true });
    await renameIfPresent(c.layout, join(target, "layout.json"));
  }
}

async function filesOf(folder: string, prefix = ""): Promise<string[]> {
  const output: string[] = [];
  for (const e of await readdir(folder, { withFileTypes: true })) {
    const rel = join(prefix, e.name);
    if (e.isDirectory()) output.push(...(await filesOf(join(folder, e.name), rel)));
    else output.push(rel);
  }
  return output;
}

/**
 * Template file → destination in the workspace. Starter widgets are only placed if `home/widgets/`
 * does not exist: a widget deleted by the user must not come back.
 */
async function matches(c: SpacePaths, models: string): Promise<[string, string][]> {
  const pairs: [string, string][] = [
    ["AGENTS.md", join(c.root, "AGENTS.md")],
    ["CLAUDE.md", join(c.root, "CLAUDE.md")],
    ["agent-profile.json", join(c.profiles, "claude.json")],
    ["layout.json", c.layout],
  ];
  if (!existsSync(c.widgets)) {
    for (const f of await filesOf(join(models, "widgets"))) pairs.push([join("widgets", f), join(c.widgets, f)]);
  }
  return pairs;
}

/**
 * sha256 hashes of each shipped version of the starter widgets' harvest script (`recolte.mjs`, `harvest.mjs` after the English
 * migration; before workflows). A starter widget whose `harvest.mjs` has one is left as is: it switches to a workflow at launch.
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
 * sha256 hashes of the shipped versions of the starter widgets' display (`affichage.html`, `display.html` after the English migration; the first two: before the Firefox
 * forms, listening without comparing `e.source`, links through `webaiosOuvrir`). A display left at one of them is replaced by the
 * current template; a display modified by the user or the agent (unknown hash) is not touched.
 */
export const DISPLAYS_SHIPPED: Record<"meteo" | "actus-tech" | "daily-dev", ReadonlySet<string>> = {
  meteo: new Set([
    "437c53d9ec9db7261bf1b90258ebfc4a2febed3b0c44fc49e5a79e68a022f449",
    "41b7f74fbbd384ab88ba8e31a57d0c2b7ee4df1f6081a588f23c888fa3721257",
    "a7e25ca8a7b10d0f48812bef3130fc16a2d6a05799d56a512171a7861e594c56",
    "19a96d4ff1e7fe19e115d61b15d86cf37ef69832d1ec922ca1576876a79dce00",
  ]),
  "actus-tech": new Set([
    "da8afce4e0676662aa65787df9c913f684f5f6b1c2bf2bf8961a69fa531ba209",
    "0f8306d6c64698eb1a5252075fb273e99fca1811748943e6986591caf18dd081",
    "9057aa911e1fcfe0641d2943fa867ecba587b2e6f04974b17512fe57c552574e",
    "45f707b6454cea62bb36f181d70bc18f6dd2ba034ec0e84561897a3806b8f6bc",
  ]),
  "daily-dev": new Set([
    "9bc668a4f1515d8f66b9a040a828099432f659ba976263af43aea2696b3a9e99",
    "12184cdd667940b894a9c86e980eb5cfb0da60acc20591665b726124c9a741b1",
    "c5e7c446b7df1754c52e88857daf71f286419d2585d9903ebbb25a650d857ebe",
    "714e787e5ca2dd69a1ac34a7b0f5b599d1aa3ebde11cde57d7ba3500272dcb23",
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
 * Switches a starter widget left as shipped (`harvest.mjs` of a known version, without `workflow.json`) to
 * its workflow template: the template's `.mjs` then `workflow.json` are copied without overwriting anything, then
 * `harvest.mjs` goes to `home/.trash/<id>-harvest-<timestamp>.mjs`. A modified widget, or one where a file
 * of the template already exists with other content, is not touched. Nothing other than this folder and the trash. With
 * the template's `workflow.json` already there (interrupted switch), only `harvest.mjs` is put away.
 */
async function toggleStartWidget(c: SpacePaths, models: string, id: keyof typeof HARVESTS_SHIPPED): Promise<string[]> {
  const folder = join(c.widgets, id);
  try {
    if (!(await lstat(folder)).isDirectory()) return [];
  } catch {
    return [];
  }
  const harvest = await ordinaryFile(join(folder, "harvest.mjs"));
  if (!harvest || !HARVESTS_SHIPPED[id].has(hash(harvest))) return [];
  // The template is read only afterwards: templates without this widget, and nothing moves.
  const model = join(models, "widgets", id);
  if (!existsSync(join(model, "workflow.json"))) return [];
  if (!(await absent(join(folder, "workflow.json")))) {
    // template's workflow.json already there: a switch interrupted before putting harvest.mjs away, which it finishes.
    const present = await ordinaryFile(join(folder, "workflow.json"));
    if (present && present.equals(await readFile(join(model, "workflow.json")))) await storeHarvest(c, id);
    return [];
  }
  const codes = (await readdir(model)).filter((f) => f.endsWith(".mjs")).sort();
  // A .mjs of the same name already there: only if identical to the template (an interrupted switch), otherwise it is the user's.
  for (const f of codes) {
    const present = join(folder, f);
    if (await absent(present)) continue;
    const content = await ordinaryFile(present);
    if (!content || !content.equals(await readFile(join(model, f)))) return [];
  }

  const crees: string[] = [];
  // workflow.json last: it appears only once its code is in place.
  for (const f of [...codes, "workflow.json"]) {
    const destination = join(folder, f);
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

/** `harvest.mjs` of a switched starter widget goes to `home/.trash/<id>-harvest-<timestamp>.mjs`. */
async function storeHarvest(c: SpacePaths, id: string): Promise<void> {
  const trash = join(c.home, ".trash");
  await mkdir(trash, { recursive: true });
  await renameIfPresent(join(c.widgets, id, "harvest.mjs"), join(trash, `${id}-harvest-${timestamp()}.mjs`));
}

/**
 * Replaces the `display.html` of a starter widget left at a shipped version (known hash) with the template's.
 * A modified display, a symbolic link or an absent widget are not touched.
 */
async function migrateStartDisplay(c: SpacePaths, models: string, id: keyof typeof DISPLAYS_SHIPPED): Promise<boolean> {
  const file = join(c.widgets, id, "display.html");
  const content = await ordinaryFile(file);
  if (!content || !DISPLAYS_SHIPPED[id].has(hash(content))) return false;
  const model = join(models, "widgets", id, "display.html");
  if (!existsSync(model)) return false;
  if (content.equals(await readFile(model))) return false;
  await copyFile(model, file);
  return true;
}

/** Creates the workspace from the templates, without overwriting an existing file (except an AGENTS.md of an old template). */
export async function initSpace(c: SpacePaths, models = DEFAULT_MODELS): Promise<{ created: string[] }> {
  const created: string[] = [];
  await setAsideBlocks(c);
  for (const [model, destination] of await matches(c, models)) {
    const update = model === "AGENTS.md" && (await agentsRestForOld(destination, join(models, model)));
    if (existsSync(destination) && !update) continue;
    await mkdir(dirname(destination), { recursive: true });
    try {
      // COPYFILE_EXCL: if the file appears in the meantime, we do not overwrite it.
      await copyFile(join(models, model), destination, update ? 0 : constants.COPYFILE_EXCL);
      created.push(destination);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  for (const id of Object.keys(DISPLAYS_SHIPPED) as (keyof typeof DISPLAYS_SHIPPED)[]) {
    // Best effort, widget by widget: a failed display never blocks launch.
    try {
      if (await migrateStartDisplay(c, models, id)) created.push(join(c.widgets, id, "display.html"));
    } catch (e) {
      console.error(`[webaios] migration de l'affichage du widget ${id} :`, e);
    }
  }
  for (const id of Object.keys(HARVESTS_SHIPPED) as (keyof typeof HARVESTS_SHIPPED)[]) {
    // Best effort, widget by widget: a failed switch never blocks launch (the widget keeps its harvest.mjs).
    try {
      created.push(...(await toggleStartWidget(c, models, id)));
    } catch (e) {
      console.error(`[webaios] bascule du widget ${id} en workflow :`, e);
    }
  }
  await mkdir(c.projects, { recursive: true });
  await mkdir(c.extensions, { recursive: true });
  await mkdir(c.actions, { recursive: true });
  await mkdir(c.components, { recursive: true });
  await mkdir(c.sites, { recursive: true });
  return { created };
}

/** sha256 of the shipped `CLAUDE.md` and agent profile templates before the English formats: a copy left as shipped is replaced. */
export const OLD_CLAUDE_MD: ReadonlySet<string> = new Set(["11baa6aab5848a8fff974dabc5e78e9ccc69b8d2a53a91d23fa9a3f0ca73632b"]);
export const OLD_AGENT_PROFILE: ReadonlySet<string> = new Set(["2e20e733cc7c9aa30c807e227a6547824afbfc1f6a8ffe0c005cc9f51c039085"]);

/**
 * sha256 of the other starter files as shipped before the English formats, by template path (French names): a copy
 * left as shipped is replaced by the current template after migration; an edited one is left and reported.
 */
export const STARTER_SHIPPED: Readonly<Record<string, ReadonlySet<string>>> = {
  "widgets/actus-tech/articles.mjs": new Set(["909e072df550b4035a91ce5608fb15a3db3463b4107d92ec09bc7e26a2a93726"]),
  "widgets/daily-dev/articles.mjs": new Set(["909e072df550b4035a91ce5608fb15a3db3463b4107d92ec09bc7e26a2a93726"]),
  "widgets/daily-dev/liens.mjs": new Set(["bc5184d4d2868c77a75b7e4f1f297103809c69c021ecfa2053b85d094f8d3969"]),
  "widgets/meteo/prevision.mjs": new Set(["80564a35b7e5f10c049a8321ce563138f35389be74434a389a8167ef2237be9a"]),
  "widgets/meteo/ville.mjs": new Set(["cbf5b44d8bc82294f3e779b27f25446191b59255b1c6be6eecfedd5013454406"]),
  "widgets/actus-tech/workflow.json": new Set(["e00db78311ad8049d7efef94abbdf1f480c13fd572159012050aa7553f13876c"]),
  "widgets/daily-dev/workflow.json": new Set(["3c40d7953cde9013479add861afa3f3516be5e98599c90cf9545ac5fe4845806"]),
  "widgets/meteo/workflow.json": new Set(["6c0ef1f115ef23bbc4cd5c6c5ea19127d281888ea835c2dbe453e77e8884883b"]),
  "widgets/actus-tech/widget.json": new Set(["dd48e150e0d7d9b58684bb5a7b6b508b246b4c2d4ab03c3956543523fb0b3e6c"]),
  "widgets/daily-dev/widget.json": new Set(["f50504ab18507b9c34653f7b37c74d7bee1a7baa66b7fd58d1dd8d098c283afa"]),
  "widgets/meteo/widget.json": new Set(["e5c6d5e17249a5183c3fd8efcb289335a723c5233c03d9ed5555699fea0a20d8"]),
  "widgets/actus-tech/exemple.json": new Set(["42d0fb1b8bd8058874ec5e013cbce8f8c947f5cf291658c06dea41b4145b7374"]),
  "widgets/daily-dev/exemple.json": new Set(["2ffbfc83f5a42f86cd28e0923bf8be3436dac6ca9978fe9a427fde13fd57024d"]),
  "widgets/meteo/exemple.json": new Set(["8ed39a293d42d0b94a18857b255a0b31f183b506f9a1c83b527d4333db175a3c"]),
  "layout.json": new Set(["d93b209599be900cb2670d010d3bf8fb713752aa87cf2359d88db4aa8ce95797"]),
};
