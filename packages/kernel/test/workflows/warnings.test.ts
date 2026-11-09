import { expect, test } from "vitest";
import { STREAMING_WARNING, INPUT_WARNING, WEB_WITHOUT_DURATION_WARNING, warnWorkflow, validateWorkflow, type Workflow } from "../../src/index.js";

const block = (id: string, type: string, params: Record<string, unknown>) => ({ id, type, position: { x: 0, y: 0 }, parametres: params });
const wf = (...blocks: ReturnType<typeof block>[]): Workflow => ({ version: 1, blocs: blocks, liens: [] });
const account = { sources: { compte: ["app.daily.dev"], publiques: ["hn.algolia.com"] }, config: {} };

test("undeclared domain for a widget with an account (page with an account, public page, feed, recuperer)", () => {
  const w = wf(
    block("p1", "source.page", { url: "https://app.daily.dev/x", compte: true }),
    block("p2", "source.page", { url: "https://app.daily.dev/x", compte: false }), // declared as account, not as public
    block("p3", "source.page", { url: "https://autre.fr/x", compte: true }),
    block("f", "source.flux", { urls: ["https://hn.algolia.com/rss", "https://Flux.example.org./rss"] }),
    block("r", "source.recuperer", { url: "https://hn.algolia.com/api" }),
    block("r2", "source.recuperer", { url: "https://ailleurs.net/api" }),
  );
  expect(warnWorkflow(w, account)).toEqual([
    { bloc: "p2", message: "domaine non déclaré : app.daily.dev" },
    { bloc: "p3", message: "domaine non déclaré : autre.fr" },
    { bloc: "f", message: "domaine non déclaré : flux.example.org" },
    { bloc: "r2", message: "domaine non déclaré : ailleurs.net" },
  ]);
});

test("no domain warning for a widget without an account", () => {
  const w = wf(block("p", "source.page", { url: "https://n-importe.où/x" }), block("f", "source.flux", { urls: ["https://z.fr/rss"] }));
  expect(warnWorkflow(w, { sources: { compte: [], publiques: [] }, config: {} })).toEqual([]);
});

test("a URL whose host is a template is not judged", () => {
  const w = wf(
    block("a", "source.page", { url: "https://{domaine}/x" }),
    block("b", "source.recuperer", { url: "{url}" }),
    block("c", "source.recuperer", { url: "https://{config.hote}.fr/x" }),
    block("d", "source.recuperer", { url: "https://hn.algolia.com/{id}" }), // the host is known, the path is a template
  );
  expect(warnWorkflow(w, account).filter((x) => x.message.startsWith("domaine"))).toEqual([]);
});

test("{config.ville} without a city in the config is flagged, a present {config.ville} is not", () => {
  const w = wf(block("r", "source.recuperer", { url: "https://hn.algolia.com/{config.ville.nom}?q={config.mot}" }));
  const without = warnWorkflow(w, { sources: { compte: [], publiques: [] }, config: { mot: "x" } });
  expect(without).toEqual([{ bloc: "r", message: "config.ville absent de la configuration du widget" }]);
  expect(warnWorkflow(w, { sources: { compte: [], publiques: [] }, config: { ville: { nom: "Lyon" }, mot: "x" } })).toEqual([]);
  expect(warnWorkflow(w, { sources: { compte: [], publiques: [] }, config: null })).toHaveLength(2);
});

test("auFilDeLEau behind liste.garder: AVERTISSEMENT_FIL_DE_L_EAU on the sortie; behind a chain: none", () => {
  const raw = (before: ReturnType<typeof block>) => ({
    version: 1,
    blocs: [
      block("f", "source.flux", { urls: ["https://x.fr/rss"] }),
      block("top", "liste.garder", { nombre: 3 }),
      before,
      block("s", "sortie", { vers: "widget", auFilDeLEau: true }),
    ],
    liens: [{ de: "f", vers: "top" }, { de: "top", vers: before.id }, { de: before.id, vers: "s" }],
  });
  const without = { sources: { compte: [], publiques: [] }, config: {} };
  const warn = (b: unknown) => {
    const r = validateWorkflow(b);
    if (!r.ok) throw new Error(r.erreur);
    return warnWorkflow(r.valide.workflow, without, r.valide);
  };
  expect(warn(raw(block("g", "liste.garder", { nombre: 2 })))).toEqual([{ bloc: "s", message: STREAMING_WARNING }]);
  expect(warn(raw(block("p", "source.page", { url: "https://x.fr/{url}", parElement: true })))).toEqual([]);
  expect(STREAMING_WARNING).toBe("rien à publier au fil de l'eau : l'entrée de la sortie n'est pas traitée élément par élément");
});

test("web.chercher without a declared maximum duration: warning (not an error); with one, or without the context, nothing", () => {
  const w = wf(block("c", "web.chercher", { requete: "x" }), block("p", "source.page", { url: "https://a.fr" }));
  const withoutAccount = { sources: { compte: [], publiques: [] }, config: {} };
  expect(WEB_WITHOUT_DURATION_WARNING).toBe("sans dureeMaxMinutes, ce widget peut être coupé à 150 s : demande à l'agent de déclarer dureeMaxMinutes");
  expect(warnWorkflow(w, { ...withoutAccount, dureeMaxMinutes: null })).toEqual([{ bloc: "c", message: WEB_WITHOUT_DURATION_WARNING }]);
  expect(warnWorkflow(w, { ...withoutAccount, dureeMaxMinutes: 30 })).toEqual([]);
  expect(warnWorkflow(w, withoutAccount)).toEqual([]);
});

test("optional {config.ville?}: never flagged, even absent from the config", () => {
  const w = wf(block("r", "source.recuperer", { url: "https://hn.algolia.com/x?v={config.ville?}&q={config.mot}" }));
  expect(warnWorkflow(w, { sources: { compte: [], publiques: [] }, config: {} })).toEqual([{ bloc: "r", message: "config.mot absent de la configuration du widget" }]);
});

test("{saisie} in source.page of an action without input: AVERTISSEMENT_SAISIE; with input: none; in a widget: none", () => {
  const w = wf(block("p", "source.page", { url: "https://x.fr/?q={saisie}" }), block("q", "source.page", { url: "https://x.fr/?q={saisie?}" }), block("r", "source.page", { url: "https://x.fr/" }));
  const base = { sources: { compte: [], publiques: [] }, config: {} };
  expect(INPUT_WARNING).toBe("{saisie} : l'action ne déclare pas de saisie");
  expect(warnWorkflow(w, { ...base, proprietaire: "action", saisie: false })).toEqual([
    { bloc: "p", message: INPUT_WARNING },
    { bloc: "q", message: INPUT_WARNING },
  ]);
  expect(warnWorkflow(w, { ...base, proprietaire: "action", saisie: true })).toEqual([]);
  expect(warnWorkflow(w, { ...base, proprietaire: "widget", saisie: false })).toEqual([]);
  expect(warnWorkflow(w, base)).toEqual([]);
});
