import { expect, test } from "vitest";
import { STREAMING_WARNING, INPUT_WARNING, WEB_WITHOUT_DURATION_WARNING, warnWorkflow as warnIn, validateWorkflow, type Workflow } from "../../src/index.js";

const warnWorkflow = (w: Workflow, ctx: Parameters<typeof warnIn>[1], valid?: Parameters<typeof warnIn>[2]) => warnIn(w, { ...ctx, locale: "fr" }, valid);
const block = (id: string, type: string, params: Record<string, unknown>) => ({ id, type, position: { x: 0, y: 0 }, params: params });
const wf = (...blocks: ReturnType<typeof block>[]): Workflow => ({ version: 1, blocks: blocks, links: [] });
const account = { sources: { account: ["app.daily.dev"], public: ["hn.algolia.com"] }, config: {} };

test("undeclared domain for a widget with an account (page with an account, public page, feed, recuperer)", () => {
  const w = wf(
    block("p1", "source.page", { url: "https://app.daily.dev/x", account: true }),
    block("p2", "source.page", { url: "https://app.daily.dev/x", account: false }), // declared as account, not as public
    block("p3", "source.page", { url: "https://autre.fr/x", account: true }),
    block("f", "source.feed", { urls: ["https://hn.algolia.com/rss", "https://Flux.example.org./rss"] }),
    block("r", "source.fetch", { url: "https://hn.algolia.com/api" }),
    block("r2", "source.fetch", { url: "https://ailleurs.net/api" }),
  );
  expect(warnWorkflow(w, account)).toEqual([
    { block: "p2", message: "domaine non déclaré : app.daily.dev" },
    { block: "p3", message: "domaine non déclaré : autre.fr" },
    { block: "f", message: "domaine non déclaré : flux.example.org" },
    { block: "r2", message: "domaine non déclaré : ailleurs.net" },
  ]);
});

test("without an account: an undeclared domain is flagged unless the widget declares web", () => {
  const w = wf(block("p", "source.page", { url: "https://n-importe.où/x" }), block("f", "source.feed", { urls: ["https://z.fr/rss"] }));
  expect(warnWorkflow(w, { sources: { account: [], public: ["z.fr"] }, config: {} })).toEqual([{ block: "p", message: "domaine non déclaré : n-importe.xn--o-7ga" }]);
  expect(warnWorkflow(w, { sources: { account: [], public: [], web: true }, config: {} })).toEqual([]);
});

test("a URL whose host is a template is not judged", () => {
  const w = wf(
    block("a", "source.page", { url: "https://{domaine}/x" }),
    block("b", "source.fetch", { url: "{url}" }),
    block("c", "source.fetch", { url: "https://{config.host}.fr/x" }),
    block("d", "source.fetch", { url: "https://hn.algolia.com/{id}" }), // the host is known, the path is a template
  );
  expect(warnWorkflow(w, account).filter((x) => x.message.startsWith("domaine"))).toEqual([]);
});

test("{config.city} without a city in the config is flagged, a present {config.city} is not", () => {
  const w = wf(block("r", "source.fetch", { url: "https://hn.algolia.com/{config.city.name}?q={config.word}" }));
  const without = warnWorkflow(w, { sources: { account: [], public: [], web: true }, config: { word: "x" } });
  expect(without).toEqual([{ block: "r", message: "config.city absent de la configuration du widget" }]);
  expect(warnWorkflow(w, { sources: { account: [], public: [], web: true }, config: { city: { name: "Lyon" }, word: "x" } })).toEqual([]);
  expect(warnWorkflow(w, { sources: { account: [], public: [], web: true }, config: null })).toHaveLength(2);
});

test("live behind list.keep: STREAMING_WARNING on the output; behind a chain: none", () => {
  const raw = (before: ReturnType<typeof block>) => ({
    version: 1,
    blocks: [
      block("f", "source.feed", { urls: ["https://x.fr/rss"] }),
      block("top", "list.keep", { count: 3 }),
      before,
      block("s", "output", { to: "widget", live: true }),
    ],
    links: [{ from: "f", to: "top" }, { from: "top", to: before.id }, { from: before.id, to: "s" }],
  });
  const without = { sources: { account: [], public: [], web: true }, config: {} };
  const warn = (b: unknown) => {
    const r = validateWorkflow(b);
    if (!r.ok) throw new Error(r.error);
    return warnWorkflow(r.valid.workflow, without, r.valid);
  };
  expect(warn(raw(block("g", "list.keep", { count: 2 })))).toEqual([{ block: "s", message: STREAMING_WARNING("fr") }]);
  expect(warn(raw(block("p", "source.page", { url: "https://x.fr/{url}", perItem: true })))).toEqual([]);
  expect(STREAMING_WARNING("fr")).toBe("rien à publier au fil de l'eau : l'entrée de la sortie n'est pas traitée élément par élément");
});

test("web.search without a declared maximum duration: warning (not an error); with one, or without the context, nothing", () => {
  const w = wf(block("c", "web.search", { query: "x" }), block("p", "source.page", { url: "https://a.fr" }));
  const withoutAccount = { sources: { account: [], public: [], web: true }, config: {} };
  expect(WEB_WITHOUT_DURATION_WARNING("fr")).toBe("sans maxDurationMinutes, ce widget peut être coupé à 150 s : demandez à l'agent de déclarer maxDurationMinutes");
  expect(warnWorkflow(w, { ...withoutAccount, maxDurationMinutes: null })).toEqual([{ block: "c", message: WEB_WITHOUT_DURATION_WARNING("fr") }]);
  expect(warnWorkflow(w, { ...withoutAccount, maxDurationMinutes: 30 })).toEqual([]);
  expect(warnWorkflow(w, withoutAccount)).toEqual([]);
});

test("optional {config.ville?}: never flagged, even absent from the config", () => {
  const w = wf(block("r", "source.fetch", { url: "https://hn.algolia.com/x?v={config.ville?}&q={config.mot}" }));
  expect(warnWorkflow(w, { sources: { account: [], public: [], web: true }, config: {} })).toEqual([{ block: "r", message: "config.mot absent de la configuration du widget" }]);
});

test("{input} in source.page of an action without input: INPUT_WARNING; with input: none; in a widget: none", () => {
  const w = wf(block("p", "source.page", { url: "https://x.fr/?q={input}" }), block("q", "source.page", { url: "https://x.fr/?q={input?}" }), block("r", "source.page", { url: "https://x.fr/" }));
  const base = { sources: { account: [], public: [], web: true }, config: {} };
  expect(INPUT_WARNING("fr")).toBe("{input} : l'action ne déclare pas de saisie (input)");
  expect(warnWorkflow(w, { ...base, owner: "action", input: false })).toEqual([
    { block: "p", message: INPUT_WARNING("fr") },
    { block: "q", message: INPUT_WARNING("fr") },
  ]);
  expect(warnWorkflow(w, { ...base, owner: "action", input: true })).toEqual([]);
  expect(warnWorkflow(w, { ...base, owner: "widget", input: false })).toEqual([]);
  expect(warnWorkflow(w, base)).toEqual([]);
});

test("the warnings follow the language of the context", () => {
  const w = wf(block("c", "web.search", { query: "q" }));
  expect(warnIn(w, { sources: { account: [], public: [], web: true }, config: {}, maxDurationMinutes: null, locale: "en" })).toEqual([
    { block: "c", message: "without maxDurationMinutes, this widget may be cut off at 150 s: ask the agent to declare maxDurationMinutes" },
  ]);
  expect(warnIn(wf(block("r", "source.page", { url: "{config.mot}" })), { sources: { account: [], public: [], web: true }, config: {}, locale: "en" })).toEqual([
    { block: "r", message: "config.mot is missing from the widget's configuration" },
  ]);
  expect(INPUT_WARNING("en")).toBe("{input}: the action does not declare an input (input)");
});
