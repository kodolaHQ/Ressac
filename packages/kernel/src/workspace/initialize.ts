import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { KERNEL_ROOT, type SpacePaths } from "../paths.js";

/** Templates folder of the package; a browser that embeds the kernel can provide another. */
export const DEFAULT_TEMPLATES = join(KERNEL_ROOT, "templates");

/**
 * sha256 hashes of old versions of the AGENTS.md template. An AGENTS.md that has one is left as
 * is: it is replaced by the current template. To complete with each new template version: add
 * the old version's hash (`shasum -a 256 templates/AGENTS.md`) before modifying it.
 */
export const OLD_AGENTS = new Set([
  "bfad62c350ce052ee0fadf3ae1a4316f53abc2fe641080ef3637f02111394a72",
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
  "ee8df7f36a6bfc9fcaeec7dc07a0f363f4ac1e88953f6d1066b498d635249abf",
  "3bd6fbba709a6d3f59a8caa28c98833e9631414701096ccd4a252300e4b9f341",
  "e63295a004bce64af5982dddd7c8af0aafc67c05b621405be3576e1c1c39e92d",
]);

const hash = (content: Buffer) => createHash("sha256").update(content).digest("hex");

/** A copy left at a shipped version (its hash is in `old`) that differs from the current template: it is replaced. */
async function leftAtOldTemplate(path: string, template: string, old: ReadonlySet<string>): Promise<boolean> {
  try {
    const h = hash(await readFile(path));
    return old.has(h) && h !== hash(await readFile(template));
  } catch {
    return false;
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
    ["codex-profile.json", join(c.profiles, "codex.json")],
    ["layout.json", c.layout],
  ];
  if (!existsSync(c.widgets)) {
    for (const f of await filesOf(join(models, "widgets"))) pairs.push([join("widgets", f), join(c.widgets, f)]);
  }
  return pairs;
}

/**
 * sha256 hashes of the shipped versions of the starter widgets' `display.html`. A display left at one of them is replaced by the
 * current template; a display modified by the user or the agent (unknown hash) is not touched.
 */
export const DISPLAYS_SHIPPED: Record<"meteo" | "actus-tech" | "daily-dev", ReadonlySet<string>> = {
  meteo: new Set([
    "437c53d9ec9db7261bf1b90258ebfc4a2febed3b0c44fc49e5a79e68a022f449",
    "41b7f74fbbd384ab88ba8e31a57d0c2b7ee4df1f6081a588f23c888fa3721257",
    "a7e25ca8a7b10d0f48812bef3130fc16a2d6a05799d56a512171a7861e594c56",
    "19a96d4ff1e7fe19e115d61b15d86cf37ef69832d1ec922ca1576876a79dce00",
    "e9c469982f2f97ed68d95f554382972e2749b57eb85c95ffc669b60297eab297",
  ]),
  "actus-tech": new Set([
    "da8afce4e0676662aa65787df9c913f684f5f6b1c2bf2bf8961a69fa531ba209",
    "0f8306d6c64698eb1a5252075fb273e99fca1811748943e6986591caf18dd081",
    "9057aa911e1fcfe0641d2943fa867ecba587b2e6f04974b17512fe57c552574e",
    "45f707b6454cea62bb36f181d70bc18f6dd2ba034ec0e84561897a3806b8f6bc",
    "66b319bac163fa6947d4047dd20e567dafa5eb93334b11c4bc9ea3936e66abba",
  ]),
  "daily-dev": new Set([
    "9bc668a4f1515d8f66b9a040a828099432f659ba976263af43aea2696b3a9e99",
    "12184cdd667940b894a9c86e980eb5cfb0da60acc20591665b726124c9a741b1",
    "c5e7c446b7df1754c52e88857daf71f286419d2585d9903ebbb25a650d857ebe",
    "714e787e5ca2dd69a1ac34a7b0f5b599d1aa3ebde11cde57d7ba3500272dcb23",
    "d1a96303f8474de20ac875874f45eb982c44e742e8cd0a0f8e060ba90466f7e4",
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

/**
 * Replaces the `display.html` of a starter widget left at a shipped version (known hash) with the template's.
 * A modified display, a symbolic link or an absent widget are not touched.
 */
async function updateStartDisplay(c: SpacePaths, models: string, id: keyof typeof DISPLAYS_SHIPPED): Promise<boolean> {
  const file = join(c.widgets, id, "display.html");
  const content = await ordinaryFile(file);
  if (!content || !DISPLAYS_SHIPPED[id].has(hash(content))) return false;
  const model = join(models, "widgets", id, "display.html");
  if (!existsSync(model)) return false;
  if (content.equals(await readFile(model))) return false;
  await copyFile(model, file);
  return true;
}

/** sha256 of old shipped versions of the `CLAUDE.md` and agent profile templates: a copy left as shipped is replaced. */
export const OLD_CLAUDE_MD: ReadonlySet<string> = new Set(["11baa6aab5848a8fff974dabc5e78e9ccc69b8d2a53a91d23fa9a3f0ca73632b"]);
export const OLD_AGENT_PROFILE: ReadonlySet<string> = new Set([
  "2e20e733cc7c9aa30c807e227a6547824afbfc1f6a8ffe0c005cc9f51c039085",
  "0fb830fc421a5c48f8de042d8e7e722a4e8c4ef38c6c2e4738ac8b389b4f4816",
]);
export const OLD_CODEX_PROFILE: ReadonlySet<string> = new Set<string>();

/** The templates replaced when the user's copy is still a shipped version (the hashes of every old version). */
const OLD_TEMPLATES: Readonly<Record<string, ReadonlySet<string>>> = {
  "AGENTS.md": OLD_AGENTS,
  "CLAUDE.md": OLD_CLAUDE_MD,
  "agent-profile.json": OLD_AGENT_PROFILE,
  "codex-profile.json": OLD_CODEX_PROFILE,
};

/**
 * Creates the workspace from the templates, without overwriting an existing file, except AGENTS.md, CLAUDE.md and the
 * agent profile left at an old shipped version.
 */
export async function initSpace(c: SpacePaths, models = DEFAULT_TEMPLATES): Promise<{ created: string[] }> {
  const created: string[] = [];
  for (const [model, destination] of await matches(c, models)) {
    const old = OLD_TEMPLATES[model];
    const update = old !== undefined && (await leftAtOldTemplate(destination, join(models, model), old));
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
      if (await updateStartDisplay(c, models, id)) created.push(join(c.widgets, id, "display.html"));
    } catch (e) {
      console.error(`[webaios] display update of widget ${id}:`, e);
    }
  }
  await mkdir(c.projects, { recursive: true });
  await mkdir(c.extensions, { recursive: true });
  await mkdir(c.actions, { recursive: true });
  await mkdir(c.components, { recursive: true });
  await mkdir(c.sites, { recursive: true });
  return { created };
}
