import { expect, test, vi } from "vitest";
import { spacePaths, type Batch, type TrackedProject } from "@webaios/kernel";
import { NO_WINDOW, createSend } from "../../core/design/send";

const batch: Batch = {
  id: "20261102T101500Z-ab12",
  projet: "app-essai",
  cree: "2026-11-02T10:15:00Z",
  destination: "agent",
  elements: [
    {
      id: "e-00000001",
      type: "design",
      texte: "Champ\r\nplus large",
      capture: null,
      contexte: { selecteur: "#email", etiquette: "input#email", html: "<input>", voisinage: { parent: "", freres: [] }, styles: {}, source: null, adresse: "http://localhost:15281/", vue: { largeur: 1, hauteur: 1 } },
    },
  ],
};

function mount() {
  const paths = spacePaths("/tmp/racine-envoi");
  const o = {
    chemins: paths,
    fenetreAgent: vi.fn(() => "f7"),
    dossierLot: vi.fn((p: string, l: string) => `${paths.interne}/remarques/${p}/${l}`),
    preRemplir: vi.fn(),
    donnerLeTerminal: vi.fn(),
    devant: vi.fn(),
  };
  return { o, envoyer: createSend(o) };
}

test("app: preRemplir receives the agent's window and the text, never a \r; external: preRemplir is not called", async () => {
  const { o, envoyer: send } = mount();
  await send({ type: "app", projet: "app-essai", dossier: "essai", nom: "Essai" }, batch);
  expect(o.preRemplir).toHaveBeenCalledTimes(1);
  const [f, text] = o.preRemplir.mock.calls[0]!;
  expect(f).toBe("f7");
  expect(text).toContain("appli Essai (/workspace/projets/essai)");
  expect(text).toContain("/workspace/.webaios/remarques/app-essai/20261102T101500Z-ab12/lot.json] ");
  expect(text).not.toMatch(/[\r\n]/);
  expect(o.donnerLeTerminal).toHaveBeenCalledWith("f7");
  expect(o.devant).toHaveBeenCalledWith("f7");

  const external: TrackedProject = { type: "externe", projet: "ext-0123456789abcdef", dossier: "/tmp/p", nom: "P", client: "c1" };
  await send(external, { ...batch, destination: "mcp", client: "c1" });
  expect(o.preRemplir).toHaveBeenCalledTimes(1);
});

test("without a main window: a window is reopened and receives the text; if none opens, the send fails (never « ok » with nothing)", async () => {
  const { o, envoyer: send } = mount();
  o.fenetreAgent.mockReturnValueOnce(undefined as never);
  const reopen = vi.fn();
  const withReopen = createSend({ ...o, rouvrir: reopen });
  await withReopen({ type: "demo", projet: "demo-15283", port: 15283 }, batch);
  expect(reopen).toHaveBeenCalledTimes(1);
  expect(o.preRemplir).toHaveBeenCalledWith("f7", expect.stringContaining("[remarques de l'utilisateur"));
  o.preRemplir.mockClear();
  o.fenetreAgent.mockReturnValue(undefined as never);
  await expect(withReopen({ type: "demo", projet: "demo-15283", port: 15283 }, batch)).rejects.toThrow(NO_WINDOW);
  await expect(send({ type: "demo", projet: "demo-15283", port: 15283 }, batch)).rejects.toThrow(NO_WINDOW);
  expect(o.preRemplir).not.toHaveBeenCalled();
});

test("site: preRemplir receives the site app, its folder and the batch path, without \\r or \\n", async () => {
  const { o, envoyer: send } = mount();
  await send({ type: "site", projet: "site-tuning", id: "tuning", nom: "Tuning" }, { ...batch, projet: "site-tuning" });
  expect(o.preRemplir).toHaveBeenCalledTimes(1);
  const [f, text] = o.preRemplir.mock.calls[0]!;
  expect(f).toBe("f7");
  expect(text).toContain('appli de site "Tuning" (/workspace/sites/tuning/)');
  expect(text).toContain("/workspace/.webaios/remarques/site-tuning/20261102T101500Z-ab12/lot.json] ");
  expect(text).not.toMatch(/[\r\n]/);
  expect(o.donnerLeTerminal).toHaveBeenCalledWith("f7");
  expect(o.devant).toHaveBeenCalledWith("f7");
});
