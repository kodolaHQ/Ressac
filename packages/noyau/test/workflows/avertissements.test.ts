import { expect, test } from "vitest";
import { AVERTISSEMENT_FIL_DE_L_EAU, AVERTISSEMENT_WEB_SANS_DUREE, avertirWorkflow, validerWorkflow, type Workflow } from "../../src/index.js";

const bloc = (id: string, type: string, parametres: Record<string, unknown>) => ({ id, type, position: { x: 0, y: 0 }, parametres });
const wf = (...blocs: ReturnType<typeof bloc>[]): Workflow => ({ version: 1, blocs, liens: [] });
const compte = { sources: { compte: ["app.daily.dev"], publiques: ["hn.algolia.com"] }, config: {} };

test("domaine non déclaré pour un widget avec compte (page avec compte, page publique, flux, recuperer)", () => {
  const w = wf(
    bloc("p1", "source.page", { url: "https://app.daily.dev/x", compte: true }),
    bloc("p2", "source.page", { url: "https://app.daily.dev/x", compte: false }), // déclaré en compte, pas en public
    bloc("p3", "source.page", { url: "https://autre.fr/x", compte: true }),
    bloc("f", "source.flux", { urls: ["https://hn.algolia.com/rss", "https://Flux.example.org./rss"] }),
    bloc("r", "source.recuperer", { url: "https://hn.algolia.com/api" }),
    bloc("r2", "source.recuperer", { url: "https://ailleurs.net/api" }),
  );
  expect(avertirWorkflow(w, compte)).toEqual([
    { bloc: "p2", message: "domaine non déclaré : app.daily.dev" },
    { bloc: "p3", message: "domaine non déclaré : autre.fr" },
    { bloc: "f", message: "domaine non déclaré : flux.example.org" },
    { bloc: "r2", message: "domaine non déclaré : ailleurs.net" },
  ]);
});

test("aucun avertissement de domaine pour un widget sans compte", () => {
  const w = wf(bloc("p", "source.page", { url: "https://n-importe.où/x" }), bloc("f", "source.flux", { urls: ["https://z.fr/rss"] }));
  expect(avertirWorkflow(w, { sources: { compte: [], publiques: [] }, config: {} })).toEqual([]);
});

test("une URL dont l'hôte est un gabarit n'est pas jugée", () => {
  const w = wf(
    bloc("a", "source.page", { url: "https://{domaine}/x" }),
    bloc("b", "source.recuperer", { url: "{url}" }),
    bloc("c", "source.recuperer", { url: "https://{config.hote}.fr/x" }),
    bloc("d", "source.recuperer", { url: "https://hn.algolia.com/{id}" }), // l'hôte est connu, le chemin est un gabarit
  );
  expect(avertirWorkflow(w, compte).filter((x) => x.message.startsWith("domaine"))).toEqual([]);
});

test("{config.ville} sans ville dans la config est signalé, {config.ville} présent ne l'est pas", () => {
  const w = wf(bloc("r", "source.recuperer", { url: "https://hn.algolia.com/{config.ville.nom}?q={config.mot}" }));
  const sans = avertirWorkflow(w, { sources: { compte: [], publiques: [] }, config: { mot: "x" } });
  expect(sans).toEqual([{ bloc: "r", message: "config.ville absent de la configuration du widget" }]);
  expect(avertirWorkflow(w, { sources: { compte: [], publiques: [] }, config: { ville: { nom: "Lyon" }, mot: "x" } })).toEqual([]);
  expect(avertirWorkflow(w, { sources: { compte: [], publiques: [] }, config: null })).toHaveLength(2);
});

test("auFilDeLEau derrière liste.garder : AVERTISSEMENT_FIL_DE_L_EAU sur la sortie ; derrière une chaîne : aucun", () => {
  const brut = (avant: ReturnType<typeof bloc>) => ({
    version: 1,
    blocs: [
      bloc("f", "source.flux", { urls: ["https://x.fr/rss"] }),
      bloc("top", "liste.garder", { nombre: 3 }),
      avant,
      bloc("s", "sortie", { vers: "widget", auFilDeLEau: true }),
    ],
    liens: [{ de: "f", vers: "top" }, { de: "top", vers: avant.id }, { de: avant.id, vers: "s" }],
  });
  const sans = { sources: { compte: [], publiques: [] }, config: {} };
  const avertir = (b: unknown) => {
    const r = validerWorkflow(b);
    if (!r.ok) throw new Error(r.erreur);
    return avertirWorkflow(r.valide.workflow, sans, r.valide);
  };
  expect(avertir(brut(bloc("g", "liste.garder", { nombre: 2 })))).toEqual([{ bloc: "s", message: AVERTISSEMENT_FIL_DE_L_EAU }]);
  expect(avertir(brut(bloc("p", "source.page", { url: "https://x.fr/{url}", parElement: true })))).toEqual([]);
  expect(AVERTISSEMENT_FIL_DE_L_EAU).toBe("rien à publier au fil de l'eau : l'entrée de la sortie n'est pas traitée élément par élément");
});

test("web.chercher sans durée maximale déclarée : avertissement (pas une erreur) ; avec, ou sans le contexte, rien", () => {
  const w = wf(bloc("c", "web.chercher", { requete: "x" }), bloc("p", "source.page", { url: "https://a.fr" }));
  const sansCompte = { sources: { compte: [], publiques: [] }, config: {} };
  expect(AVERTISSEMENT_WEB_SANS_DUREE).toBe("sans dureeMaxMinutes, ce widget peut être coupé à 150 s : demande à l'agent de déclarer dureeMaxMinutes");
  expect(avertirWorkflow(w, { ...sansCompte, dureeMaxMinutes: null })).toEqual([{ bloc: "c", message: AVERTISSEMENT_WEB_SANS_DUREE }]);
  expect(avertirWorkflow(w, { ...sansCompte, dureeMaxMinutes: 30 })).toEqual([]);
  expect(avertirWorkflow(w, sansCompte)).toEqual([]);
});

test("{config.ville?} facultatif : jamais signalé, même absent de la configuration", () => {
  const w = wf(bloc("r", "source.recuperer", { url: "https://hn.algolia.com/x?v={config.ville?}&q={config.mot}" }));
  expect(avertirWorkflow(w, { sources: { compte: [], publiques: [] }, config: {} })).toEqual([{ bloc: "r", message: "config.mot absent de la configuration du widget" }]);
});
