import { expect, test } from "vitest";
import { STREAMING_WARNING, INPUT_WARNING, WEB_WITHOUT_DURATION_WARNING, warnWorkflow, validateWorkflow, type Workflow } from "../../src/index.js";

const block = (id: string, type: string, params: Record<string, unknown>) => ({ id, type, position: { x: 0, y: 0 }, params: params });
const wf = (...blocks: ReturnType<typeof block>[]): Workflow => ({ version: 1, blocks: blocks, links: [] });
const account = { sources: { account: ["app.daily.dev"], public: ["hn.algolia.com"] }, config: {} };

test("undeclared domain for a widget with an account (page with an account, public page, feed, recuperer)", () => {
  const w = wf(
    block("p1", "source.page", { url: "https://app.daily.dev/x", account: true }),
    block("p2", "source.page", { url: "https://app.daily.dev/x", account: false }), // declared as account, not as public
    block("p3", "source.page", { url: "https://autre.fr/x", account: true }),
    block("f", "source.flux", { urls: ["https://hn.algolia.com/rss", "https://Flux.example.org./rss"] }),
    block("r", "source.recuperer", { url: "https://hn.algolia.com/api" }),
    block("r2", "source.recuperer", { url: "https://ailleurs.net/api" }),
  );
  expect(warnWorkflow(w, account)).toEqual([
    { block: "p2", message: "domaine non déclaré : app.daily.dev" },
    { block: "p3", message: "domaine non déclaré : autre.fr" },
    { block: "f", message: "domaine non déclaré : flux.example.org" },
    { block: "r2", message: "domaine non déclaré : ailleurs.net" },
  ]);
});

test("no domain warning for a widget without an account", () => {
  const w = wf(block("p", "source.page", { url: "https://n-importe.où/x" }), block("f", "source.flux", { urls: ["https://z.fr/rss"] }));
  expect(warnWorkflow(w, { sources: { account: [], public: [] }, config: {} })).toEqual([]);
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
  const without = warnWorkflow(w, { sources: { account: [], public: [] }, config: { word: "x" } });
  expect(without).toEqual([{ block: "r", message: "config.ville absent de la configuration du widget" }]);
  expect(warnWorkflow(w, { sources: { account: [], public: [] }, config: { city: { name: "Lyon" }, word: "x" } })).toEqual([]);
  expect(warnWorkflow(w, { sources: { account: [], public: [] }, config: null })).toHaveLength(2);
});

test("auFilDeLEau behind liste.garder: STREAMING_WARNING on the sortie; behind a chain: none", () => {
  const raw = (before: ReturnType<typeof block>) => ({
    version: 1,
    blocks: [
      block("f", "source.flux", { urls: ["https://x.fr/rss"] }),
      block("top", "liste.garder", { count: 3 }),
      before,
      block("s", "sortie", { to: "widget", live: true }),
    ],
    links: [{ from: "f", to: "top" }, { from: "top", to: before.id }, { from: before.id, to: "s" }],
  });
  const without = { sources: { account: [], public: [] }, config: {} };
  const warn = (b: unknown) => {
    const r = validateWorkflow(b);
    if (!r.ok) throw new Error(r.error);
    return warnWorkflow(r.valid.workflow, without, r.valid);
  };
  expect(warn(raw(block("g", "liste.garder", { count: 2 })))).toEqual([{ block: "s", message: STREAMING_WARNING }]);
  expect(warn(raw(block("p", "source.page", { url: "https://x.fr/{url}", perItem: true })))).toEqual([]);
  expect(STREAMING_WARNING).toBe("rien à publier au fil de l'eau : l'entrée de la sortie n'est pas traitée élément par élément");
});

test("web.chercher without a declared maximum duration: warning (not an error); with one, or without the context, nothing", () => {
  const w = wf(block("c", "web.chercher", { query: "x" }), block("p", "source.page", { url: "https://a.fr" }));
  const withoutAccount = { sources: { account: [], public: [] }, config: {} };
  expect(WEB_WITHOUT_DURATION_WARNING).toBe("sans dureeMaxMinutes, ce widget peut être coupé à 150 s : demande à l'agent de déclarer dureeMaxMinutes");
  expect(warnWorkflow(w, { ...withoutAccount, maxDurationMinutes: null })).toEqual([{ block: "c", message: WEB_WITHOUT_DURATION_WARNING }]);
  expect(warnWorkflow(w, { ...withoutAccount, maxDurationMinutes: 30 })).toEqual([]);
  expect(warnWorkflow(w, withoutAccount)).toEqual([]);
});

test("optional {config.ville?}: never flagged, even absent from the config", () => {
  const w = wf(block("r", "source.recuperer", { url: "https://hn.algolia.com/x?v={config.ville?}&q={config.mot}" }));
  expect(warnWorkflow(w, { sources: { account: [], public: [] }, config: {} })).toEqual([{ block: "r", message: "config.mot absent de la configuration du widget" }]);
});

test("{saisie} in source.page of an action without input: INPUT_WARNING; with input: none; in a widget: none", () => {
  const w = wf(block("p", "source.page", { url: "https://x.fr/?q={saisie}" }), block("q", "source.page", { url: "https://x.fr/?q={saisie?}" }), block("r", "source.page", { url: "https://x.fr/" }));
  const base = { sources: { account: [], public: [] }, config: {} };
  expect(INPUT_WARNING).toBe("{saisie} : l'action ne déclare pas de saisie");
  expect(warnWorkflow(w, { ...base, owner: "action", input: false })).toEqual([
    { block: "p", message: INPUT_WARNING },
    { block: "q", message: INPUT_WARNING },
  ]);
  expect(warnWorkflow(w, { ...base, owner: "action", input: true })).toEqual([]);
  expect(warnWorkflow(w, { ...base, owner: "widget", input: false })).toEqual([]);
  expect(warnWorkflow(w, base)).toEqual([]);
});
