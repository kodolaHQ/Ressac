import { expect, test } from "vitest";
import { avertirWorkflow, type Workflow } from "../../src/index.js";

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
