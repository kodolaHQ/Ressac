// code: a function written by the agent, in a .mjs file in the widget's folder.
// `call: "input"`: `default(input, ressac)`; `call: "harvest"`: `default(ressac)` (implicit workflow).
import { access } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const FILE = /^[a-z0-9-]+\.mjs$/;

export default {
  perItem: "no",
  async run({ input, params, ressac, folder }) {
    const { source, call = "input" } = params;
    // The schema has already checked this on the kernel side: never a path, never outside the widget's folder.
    if (typeof source !== "string" || !FILE.test(source)) throw new Error("fichier de code invalide");
    const path = join(folder, source);
    try {
      await access(path);
    } catch {
      throw new Error(`fichier de code absent : ${source}`);
    }
    const module = await import(pathToFileURL(path).href);
    if (typeof module.default !== "function") throw new Error(`${source} doit exporter une fonction par défaut`);
    const result = call === "harvest" ? await module.default(ressac) : await module.default(input, ressac);
    let json;
    try {
      json = JSON.stringify(result);
    } catch {
      json = undefined;
    }
    if (json === undefined) throw new Error(call === "harvest" ? "la récolte doit rendre du JSON" : `${source} doit rendre du JSON`);
    return { output: JSON.parse(json) };
  },
};
