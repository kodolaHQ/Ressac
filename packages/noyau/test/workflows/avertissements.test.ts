import { expect, test } from "vitest";
import { AVERTISSEMENT_FIL_DE_L_EAU, AVERTISSEMENT_SAISIE, AVERTISSEMENT_WEB_SANS_DUREE, avertirWorkflow, validerWorkflow, type Workflow } from "../../src/index.js";

const bloc = (id: string, type: string, parametres: Record<string, unknown>) => ({ id, type, position: { x: 0, y: 0 }, parametres });
const wf = (...blocs: ReturnType<typeof bloc>[]): Workflow => ({ version: 1, blocs, liens: [] });
const compte = { sources: { compte: ["app.daily.dev"], publiques: ["hn.algolia.com"] }, config: {} };

test("undeclared domain for a widget with an account (page with an account, public page, feed, recuperer)", () => {
  const w = wf(
    bloc("p1", "source.page", { url: "https://app.daily.dev/x", compte: true }),
    bloc("p2", "source.page", { url: "https://app.daily.dev/x", compte: false }), // declared as account, not as public
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

test("no domain warning for a widget without an account", () => {
  const w = wf(bloc("p", "source.page", { url: "https://n-importe.où/x" }), bloc("f", "source.flux", { urls: ["https://z.fr/rss"] }));
  expect(avertirWorkflow(w, { sources: { compte: [], publiques: [] }, config: {} })).toEqual([]);
});

test("a URL whose host is a template is not judged", () => {
  const w = wf(
    bloc("a", "source.page", { url: "https://{domaine}/x" }),
    bloc("b", "source.recuperer", { url: "{url}" }),
    bloc("c", "source.recuperer", { url: "https://{config.hote}.fr/x" }),
    bloc("d", "source.recuperer", { url: "https://hn.algolia.com/{id}" }), // the host is known, the path is a template
  );
  expect(avertirWorkflow(w, compte).filter((x) => x.message.startsWith("domaine"))).toEqual([]);
});

test("{config.ville} without a city in the config is flagged, a present {config.ville} is not", () => {
  const w = wf(bloc("r", "source.recuperer", { url: "https://hn.algolia.com/{config.ville.nom}?q={config.mot}" }));
  const sans = avertirWorkflow(w, { sources: { compte: [], publiques: [] }, config: { mot: "x" } });
  expect(sans).toEqual([{ bloc: "r", message: "config.ville absent de la configuration du widget" }]);
  expect(avertirWorkflow(w, { sources: { compte: [], publiques: [] }, config: { ville: { nom: "Lyon" }, mot: "x" } })).toEqual([]);
  expect(avertirWorkflow(w, { sources: { compte: [], publiques: [] }, config: null })).toHaveLength(2);
});

test("auFilDeLEau behind liste.garder: AVERTISSEMENT_FIL_DE_L_EAU on the sortie; behind a chain: none", () => {
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

test("web.chercher without a declared maximum duration: warning (not an error); with one, or without the context, nothing", () => {
  const w = wf(bloc("c", "web.chercher", { requete: "x" }), bloc("p", "source.page", { url: "https://a.fr" }));
  const sansCompte = { sources: { compte: [], publiques: [] }, config: {} };
  expect(AVERTISSEMENT_WEB_SANS_DUREE).toBe("sans dureeMaxMinutes, ce widget peut être coupé à 150 s : demande à l'agent de déclarer dureeMaxMinutes");
  expect(avertirWorkflow(w, { ...sansCompte, dureeMaxMinutes: null })).toEqual([{ bloc: "c", message: AVERTISSEMENT_WEB_SANS_DUREE }]);
  expect(avertirWorkflow(w, { ...sansCompte, dureeMaxMinutes: 30 })).toEqual([]);
  expect(avertirWorkflow(w, sansCompte)).toEqual([]);
});

test("optional {config.ville?}: never flagged, even absent from the config", () => {
  const w = wf(bloc("r", "source.recuperer", { url: "https://hn.algolia.com/x?v={config.ville?}&q={config.mot}" }));
  expect(avertirWorkflow(w, { sources: { compte: [], publiques: [] }, config: {} })).toEqual([{ bloc: "r", message: "config.mot absent de la configuration du widget" }]);
});

test("{saisie} in source.page of an action without input: AVERTISSEMENT_SAISIE; with input: none; in a widget: none", () => {
  const w = wf(bloc("p", "source.page", { url: "https://x.fr/?q={saisie}" }), bloc("q", "source.page", { url: "https://x.fr/?q={saisie?}" }), bloc("r", "source.page", { url: "https://x.fr/" }));
  const base = { sources: { compte: [], publiques: [] }, config: {} };
  expect(AVERTISSEMENT_SAISIE).toBe("{saisie} : l'action ne déclare pas de saisie");
  expect(avertirWorkflow(w, { ...base, proprietaire: "action", saisie: false })).toEqual([
    { bloc: "p", message: AVERTISSEMENT_SAISIE },
    { bloc: "q", message: AVERTISSEMENT_SAISIE },
  ]);
  expect(avertirWorkflow(w, { ...base, proprietaire: "action", saisie: true })).toEqual([]);
  expect(avertirWorkflow(w, { ...base, proprietaire: "widget", saisie: false })).toEqual([]);
  expect(avertirWorkflow(w, base)).toEqual([]);
});
