import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { KERNEL_ROOT, type SpacePaths } from "../paths.js";

/**
 * Templates folder of the package; a browser that embeds the kernel can provide another. The texts and starter widgets
 * are in one folder per language (`fr/`, `en/`); the profiles are at the root.
 */
export const DEFAULT_TEMPLATES = join(KERNEL_ROOT, "templates");

/** The language whose templates stand in for a language or a file the templates lack. */
const FALLBACK = "en";

/**
 * sha256 hashes of old versions of the AGENTS.md template. An AGENTS.md that has one is left as
 * is: it is replaced by the current template. To complete with each new template version: add
 * the old version's hash (`shasum -a 256 templates/<language>/AGENTS.md`) before modifying it.
 */
export const OLD_AGENTS = new Set([
  "c2af8a5d6880a5dc9e0e76544955b305203ebb453eb5fa7e0bcc86e5eef931f1",
  "cb5203cc8fdbedc30f1dd77e138716f3ad3fbd27129a935dafc0d71d876ac89a",
  "08de4118ce41e65b76e8b9795595d41e749c9b60d72a4f3f87691d2cbc99e8ab",
  "58be09d0c5a9d6b8a08f055fd4ed62415403b54f0acd4f6596e0473a4b6da875",
  "0465e45d90b43e2ab810f9d47b53d9efbfd72df15831a81c83c38b36f8172341",
  "8cc24e0ad5b74c212fe1cb100959d3cfe0a038fd3f424a79714723b36fbc699a",
  "28d43b9971947d05d21772e6a7c2014c98b2677aa51e7e2cf87c9a26384bee2d",
  "eaed8d1d938c46e5ac2d5958d5b7b3a2d49ae17637395f26da7866ae28f10d00",
  "7cd23635e0d47510294b5ee4d3059f4158ea5e94d52b26150bec4a789ac03d46",
  "834a9884b20b2ca356521226665c976c119d648712364810b56425230b7c3a98",
  "6ecc3a5571398b8490f4b384b32c191e56111e3eebe092e1ccf03790f2ec845b",
  "ff0f49e00a04cec590ee023394221e8bbf28dd0439a628e48ea307acaffa0a8e",
  "b5bbd495806166dd7940aeb6d7736a05bf1e67c0d2c2d1d83bdca38e4be56765",
  "b856fbb878d0ded600f27661561fbd763e1e20e1e1c48e2a52a366b277bed42a",
  "6e87b6e197e49c047cf9019ae5ff81d1f4a5466c3c9aceb848072d132fd8c5c6",
  "0ad4aed8ceea337645827d373cd03220ff789a8e331878e54f20312d7a7e2ca6",
  "ab60644f1589585bc770e628f0c7739eefd9b08a444d09fb12435514a3c2cedb",
  "0a6fde102809aedffb26d4e7547bed4a772e39eb3ffce50fabacafed08799b7d",
  "426a4b562b62b900fd3cde63778fea389e85f0086762625c232bca57f42a7e42",
  "bda7a478a63514c62285ddc3ae479fe79799af57b3bc5c19a3048e4411c3c31a",
  "75659bec080f69a81dba4bf5c63273eced68b8b4eea767f241cb05b60d2386e1",
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
  "08ab1528c2c4345c2bad7685f7b89bdfe20d1d0a677b1267da0a34d1e91414c1",
  "56b165bf7ae7e88fd3125401419301b29eb16eba113434592e01a0d1c61b868b",
  "f523f766e05f8076213dd35c29cb89390481372fd807f12900d9d8a7f2b2206e",
  "ee6688de3324e84c6aff31cfe19720d6dba2d03a24f594c61ef7a1308b28e9d0",
  "61587f52b36c18ba852c01ef047a3ff4e7b4bbdab790f9683028c338d9cdd569",
  "3e269e53f23f824d70b25a30ecb239e6ac879a003f9916db1c15684758dcd4fd",
  "4f0bb4cefb55d27210fbdd477d2290313829673432f171d169dad8bf9e0becc9",
  "68c45b6530e17813c57ed0adcabe36e6da5f85b0f4befcf29df008f326c4f45e",
  "aea61be7ae7507f4555440e52eddef6c6d4331c0d1d20e5da843223ba9757b0e",
]);

const hash = (content: Buffer) => createHash("sha256").update(content).digest("hex");

/** A copy left at a shipped version (its hash is in `old`) that differs from the template to place: it is replaced. */
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

/** The languages the templates have: one folder each. */
async function languagesOf(models: string): Promise<string[]> {
  return (await readdir(models, { withFileTypes: true })).filter((e) => e.isDirectory() && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(e.name)).map((e) => e.name);
}

/** The template `rel` in `lang`, else in English (a file a language lacks). */
const localized = (models: string, lang: string, rel: string) => {
  const own = join(models, lang, rel);
  return existsSync(own) ? own : join(models, FALLBACK, rel);
};

/** The sha256 of `rel` in every language that has it. */
async function currentHashes(models: string, langs: string[], rel: string): Promise<string[]> {
  const out: string[] = [];
  for (const l of langs) {
    const content = await ordinaryFile(join(models, l, rel));
    if (content) out.push(hash(content));
  }
  return out;
}

/**
 * The texts written in the language of the space: swapped on a language change while untouched. The guides hold what
 * AGENTS.md leaves to a task (widgets, actions…): the agent reads one when its task comes, a local model keeps its window.
 */
const GUIDES = ["guides/widgets.md", "guides/extensions.md", "guides/actions.md", "guides/site-apps.md"];
const LOCALIZED_TEXTS = ["AGENTS.md", "CLAUDE.md", "browsing-notes.md", ...GUIDES];

/**
 * Template file → destination in the workspace, and the hashes of the shipped versions the destination may be replaced
 * from. Starter widgets are only placed if `home/widgets/` does not exist: a widget deleted by the user must not come back.
 */
async function matches(c: SpacePaths, models: string, lang: string, langs: string[]): Promise<[string, string, ReadonlySet<string> | undefined][]> {
  const pairs: [string, string, ReadonlySet<string> | undefined][] = [];
  for (const f of LOCALIZED_TEXTS) {
    // Any language's current template counts as shipped: an untouched copy follows the language.
    const known = new Set([...(OLD_TEMPLATES[f] ?? []), ...(await currentHashes(models, langs, f))]);
    pairs.push([localized(models, lang, f), join(c.root, f), known]);
  }
  if (!existsSync(c.widgets)) {
    const files = new Set([...(await filesOf(join(models, lang, "widgets"))), ...(await filesOf(join(models, FALLBACK, "widgets")))]);
    for (const f of files) pairs.push([localized(models, lang, join("widgets", f)), join(c.widgets, f), undefined]);
  }
  return pairs;
}

/**
 * sha256 hashes of the shipped versions of the starter widgets' `display.html`. A display left at one of them is replaced by the
 * current template; a display modified by the user or the agent (unknown hash) is not touched.
 * Every hash here is a French display and `updateStartDisplay` copies the `fr` one: an English display hash must not be
 * added without first splitting this set per language.
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
    "b4e8220c69f7ba0b132596e90ffcd2b0dc46ee59c2b8667075be9410063fbdf8",
  ]),
  "daily-dev": new Set([
    "9bc668a4f1515d8f66b9a040a828099432f659ba976263af43aea2696b3a9e99",
    "12184cdd667940b894a9c86e980eb5cfb0da60acc20591665b726124c9a741b1",
    "c5e7c446b7df1754c52e88857daf71f286419d2585d9903ebbb25a650d857ebe",
    "714e787e5ca2dd69a1ac34a7b0f5b599d1aa3ebde11cde57d7ba3500272dcb23",
    "d1a96303f8474de20ac875874f45eb982c44e742e8cd0a0f8e060ba90466f7e4",
    "b6eed58e315ddf505327f264aae1dad98c07933858f2da8934c3dc2fdf3b4182",
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
 * Replaces the `display.html` of a starter widget left at a shipped version (known hash) with the template's, for a
 * widget `swapWidget` left alone (another of its files was edited). A modified display, a symbolic link or an absent
 * widget are not touched.
 */
async function updateStartDisplay(c: SpacePaths, models: string, id: keyof typeof DISPLAYS_SHIPPED): Promise<boolean> {
  const file = join(c.widgets, id, "display.html");
  const content = await ordinaryFile(file);
  if (!content || !DISPLAYS_SHIPPED[id].has(hash(content))) return false;
  // Every display shipped before the languages is French: its update stays French, never mixing languages in a widget.
  const model = join(models, "fr", "widgets", id, "display.html");
  if (!existsSync(model)) return false;
  if (content.equals(await readFile(model))) return false;
  await copyFile(model, file);
  return true;
}

/**
 * Puts a starter widget in `lang` when every template file it still has is a shipped version (any language's current
 * file, or a known `display.html`) and one of them differs from `lang`'s. A widget with an edited or missing file, a
 * symbolic link or an absent widget is left whole; files that are not templates (its data) are never touched.
 */
async function swapWidget(c: SpacePaths, models: string, lang: string, langs: string[], id: string): Promise<string[]> {
  const folder = join(c.widgets, id);
  if (!(await lstat(folder).catch(() => null))?.isDirectory()) return [];
  const names = new Set<string>();
  for (const l of langs) if (existsSync(join(models, l, "widgets", id))) for (const f of await filesOf(join(models, l, "widgets", id))) names.add(f);
  const toWrite: [string, string][] = [];
  for (const name of names) {
    const file = join(folder, name);
    const source = localized(models, lang, join("widgets", id, name));
    const target = existsSync(source) ? await readFile(source) : null;
    // A missing template file counts as an edit: the widget is kept whole.
    // shortcut: assumes every language ships the same file set for a widget; a file added in one language only would
    // freeze that widget in the others, so list such files per language if it ever happens.
    if (!(await lstat(file).catch(() => null))) return [];
    const content = await ordinaryFile(file);
    if (!content) return [];
    const shipped =
      (await currentHashes(models, langs, join("widgets", id, name))).includes(hash(content)) ||
      (OLD_TEMPLATES[`widgets/${id}/${name}`]?.has(hash(content)) ?? false) ||
      (name === "display.html" && (DISPLAYS_SHIPPED[id as keyof typeof DISPLAYS_SHIPPED]?.has(hash(content)) ?? false));
    if (!shipped) return [];
    if (target && !content.equals(target)) toWrite.push([source, file]);
  }
  for (const [source, file] of toWrite) await copyFile(source, file);
  return toWrite.map(([, file]) => file);
}

/** sha256 of old shipped versions of the `CLAUDE.md` template: a copy left as shipped is replaced. */
// The old ones only asked the agent to read AGENTS.md: it skipped it when the first message was a task.
export const OLD_CLAUDE_MD: ReadonlySet<string> = new Set([
  "11baa6aab5848a8fff974dabc5e78e9ccc69b8d2a53a91d23fa9a3f0ca73632b",
  "4690fb441d1ffb32d9e9915a8fc65545f25de774d368c48041e86de43d7a8cab",
]);
/** The hashes of every old shipped version of the language texts (browsing-notes.md and the other guides: none, only the current ones). */
const OLD_TEMPLATES: Readonly<Record<string, ReadonlySet<string>>> = {
  "AGENTS.md": OLD_AGENTS,
  "CLAUDE.md": OLD_CLAUDE_MD,
  // The 12-column layout text, replaced by the free layout one.
  "guides/widgets.md": new Set([
    "687a950d62e647363f9c908d8b71356ecef73a70177af831f072aca33d6a1f9d",
    "517252df64b8d493bc8ad0dca33f40273fb3e10b03b5eac23e480de3c2e3d359",
    // Before the card in front of harvest_widget.
    "6e4dc72d2c29b5e7815bb31d7c2c3b1ce12896dc563ede9f3ca0ef3247ce7223",
    "dc07b4c371b3662618656495fd2ed1868bc0da37f9a27c2a775ec22cbdc57599",
    // Before the caps of the harvest's copy: fr, en.
    "c910bac82910915de8a5195d408ee02f820194ce1a651a34aa042205808d4aa3",
    "252bd9b2eeb4ac280e68b49a833ffcad0ece1bb2f67fb2343d9ff3dffaa6caa7",
  ]),
  // Before the caps of the harvest's copy: fr, en.
  "guides/actions.md": new Set(["f2e7637484158ec1c8747311bf6c03c303fcf58f9afcfcf67678c29b0bf9f43b", "24cfeffac0bbeada14f8fa7dae02a89db6a89f41ed9ee360baffb8661bd7aa29"]),
  // Before it declared `web` (it reads each article's own site): fr, en.
  "widgets/actus-tech/widget.json": new Set([
    "4ff80b95ebfed67f690c6efd116d513e8ecabd5de2762bcba06e4cc52c2bc985",
    "5f58a3c91e4e65fbc6a4fd1970626b1071cdfdb5ebabed972ba9ec171fbb74a5",
  ]),
  // The version that still listed `cookies` among the working rights.
  "guides/extensions.md": new Set(["ab3d59cd7ee04a33e9c29ee43a1bd086d16ca5b038e582b8fb2f756b7135ac9b", "bb0ef51c03aaa9bfc5788348376f42aef8555eb35536f429b30ad7cc92844436"]),
};

/**
 * `.ressac` as a real folder with no link at its top. Until 0.1.8 the agent could rename it and plant a link
 * (`.ressac -> ..`, `harvests -> ~`) that the workshop's mounts and the kernel's writes would follow. `rm` takes a link,
 * never its target.
 */
export async function realInternal(c: SpacePaths): Promise<void> {
  if (!(await lstat(c.internal).catch(() => null))?.isDirectory()) await rm(c.internal, { force: true });
  await mkdir(c.internal, { recursive: true });
  for (const e of await readdir(c.internal, { withFileTypes: true })) if (e.isSymbolicLink()) await rm(join(c.internal, e.name), { force: true });
}

/**
 * Creates the workspace from the templates of `locale` (English when the templates lack it), without overwriting an
 * existing file, except a copy left at a shipped version: AGENTS.md, CLAUDE.md, browsing-notes.md and the starter
 * widgets follow the language while untouched, AGENTS.md and CLAUDE.md are refreshed when old.
 * Run again on a language change.
 */
export async function initSpace(c: SpacePaths, locale = FALLBACK, models = DEFAULT_TEMPLATES): Promise<{ created: string[] }> {
  // First, before anything writes under .ressac or a container mounts it.
  await realInternal(c);
  const langs = await languagesOf(models);
  // Only a language the templates have: `locale` never builds a path out of the templates folder.
  const lang = langs.includes(locale) ? locale : FALLBACK;
  const created: string[] = [];
  for (const [model, destination, old] of await matches(c, models, lang, langs)) {
    const update = old !== undefined && (await leftAtOldTemplate(destination, model, old));
    if (existsSync(destination) && !update) continue;
    await mkdir(dirname(destination), { recursive: true });
    try {
      // COPYFILE_EXCL: if the file appears in the meantime, we do not overwrite it.
      await copyFile(model, destination, update ? 0 : constants.COPYFILE_EXCL);
      created.push(destination);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  const starters = new Set<string>();
  for (const l of langs) if (existsSync(join(models, l, "widgets"))) for (const e of await readdir(join(models, l, "widgets"))) starters.add(e);
  for (const id of starters) {
    // Best effort, widget by widget: a failed widget never blocks launch.
    try {
      const swapped = await swapWidget(c, models, lang, langs, id);
      created.push(...swapped);
      if (!swapped.length && id in DISPLAYS_SHIPPED && (await updateStartDisplay(c, models, id as keyof typeof DISPLAYS_SHIPPED))) {
        created.push(join(c.widgets, id, "display.html"));
      }
    } catch (e) {
      console.error(`[ressac] update of starter widget ${id}:`, e);
    }
  }
  await mkdir(c.projects, { recursive: true });
  // Mounted read-write over the read-only .ressac in the workshop: it must exist before docker run.
  await mkdir(c.logs, { recursive: true });
  await mkdir(c.extensions, { recursive: true });
  await mkdir(c.actions, { recursive: true });
  await mkdir(c.components, { recursive: true });
  await mkdir(c.sites, { recursive: true });
  return { created };
}
