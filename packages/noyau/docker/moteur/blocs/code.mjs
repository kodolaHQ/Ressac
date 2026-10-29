// code : une fonction écrite par l'agent, dans un fichier .mjs du dossier du widget.
// `appel: "entree"` : `default(entree, webaios)` ; `appel: "recolte"` : `default(webaios)` (workflow implicite).
import { access } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const FICHIER = /^[a-z0-9-]+\.mjs$/;

export default {
  parElement: "non",
  async executer({ entree, parametres, webaios, dossier }) {
    const { source, appel = "entree" } = parametres;
    // Le schéma l'a déjà vérifié côté noyau : jamais de chemin, jamais hors du dossier du widget.
    if (typeof source !== "string" || !FICHIER.test(source)) throw new Error("fichier de code invalide");
    const chemin = join(dossier, source);
    try {
      await access(chemin);
    } catch {
      throw new Error(`fichier de code absent : ${source}`);
    }
    const module = await import(pathToFileURL(chemin).href);
    if (typeof module.default !== "function") throw new Error(`${source} doit exporter une fonction par défaut`);
    const resultat = appel === "recolte" ? await module.default(webaios) : await module.default(entree, webaios);
    let json;
    try {
      json = JSON.stringify(resultat);
    } catch {
      json = undefined;
    }
    if (json === undefined) throw new Error(appel === "recolte" ? "la récolte doit rendre du JSON" : `${source} doit rendre du JSON`);
    return { sortie: JSON.parse(json) };
  },
};
