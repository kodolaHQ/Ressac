import { expect, test, vi } from "vitest";
import { cheminsEspace, type Lot, type ProjetSuivi } from "@webaios/noyau";
import { AUCUNE_FENETRE, creerEnvoi } from "../../src/main/design/envoi";

const lot: Lot = {
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

function monter() {
  const chemins = cheminsEspace("/tmp/racine-envoi");
  const o = {
    chemins,
    fenetreAgent: vi.fn(() => "f7"),
    dossierLot: vi.fn((p: string, l: string) => `${chemins.interne}/remarques/${p}/${l}`),
    preRemplir: vi.fn(),
    donnerLeTerminal: vi.fn(),
    devant: vi.fn(),
  };
  return { o, envoyer: creerEnvoi(o) };
}

test("app : preRemplir reçoit la fenêtre de l'agent et le texte, jamais de \r ; externe : preRemplir n'est pas appelé", async () => {
  const { o, envoyer } = monter();
  await envoyer({ type: "app", projet: "app-essai", dossier: "essai", nom: "Essai" }, lot);
  expect(o.preRemplir).toHaveBeenCalledTimes(1);
  const [f, texte] = o.preRemplir.mock.calls[0]!;
  expect(f).toBe("f7");
  expect(texte).toContain("appli Essai (/workspace/projets/essai)");
  expect(texte).toContain("/workspace/.webaios/remarques/app-essai/20261102T101500Z-ab12/lot.json] ");
  expect(texte).not.toMatch(/[\r\n]/);
  expect(o.donnerLeTerminal).toHaveBeenCalledWith("f7");
  expect(o.devant).toHaveBeenCalledWith("f7");

  const externe: ProjetSuivi = { type: "externe", projet: "ext-0123456789abcdef", dossier: "/tmp/p", nom: "P", client: "c1" };
  await envoyer(externe, { ...lot, destination: "mcp", client: "c1" });
  expect(o.preRemplir).toHaveBeenCalledTimes(1);
});

test("sans fenêtre principale : une fenêtre est rouverte et reçoit le texte ; si aucune ne s'ouvre, l'envoi échoue (jamais « ok » sans rien)", async () => {
  const { o, envoyer } = monter();
  o.fenetreAgent.mockReturnValueOnce(undefined as never);
  const rouvrir = vi.fn();
  const avecRouvrir = creerEnvoi({ ...o, rouvrir });
  await avecRouvrir({ type: "demo", projet: "demo-15283", port: 15283 }, lot);
  expect(rouvrir).toHaveBeenCalledTimes(1);
  expect(o.preRemplir).toHaveBeenCalledWith("f7", expect.stringContaining("[remarques de l'utilisateur"));
  o.preRemplir.mockClear();
  o.fenetreAgent.mockReturnValue(undefined as never);
  await expect(avecRouvrir({ type: "demo", projet: "demo-15283", port: 15283 }, lot)).rejects.toThrow(AUCUNE_FENETRE);
  await expect(envoyer({ type: "demo", projet: "demo-15283", port: 15283 }, lot)).rejects.toThrow(AUCUNE_FENETRE);
  expect(o.preRemplir).not.toHaveBeenCalled();
});

test("site : preRemplir reçoit l'appli de site, son dossier et le chemin du lot, sans \\r ni \\n", async () => {
  const { o, envoyer } = monter();
  await envoyer({ type: "site", projet: "site-tuning", id: "tuning", nom: "Tuning" }, { ...lot, projet: "site-tuning" });
  expect(o.preRemplir).toHaveBeenCalledTimes(1);
  const [f, texte] = o.preRemplir.mock.calls[0]!;
  expect(f).toBe("f7");
  expect(texte).toContain('appli de site "Tuning" (/workspace/sites/tuning/)');
  expect(texte).toContain("/workspace/.webaios/remarques/site-tuning/20261102T101500Z-ab12/lot.json] ");
  expect(texte).not.toMatch(/[\r\n]/);
  expect(o.donnerLeTerminal).toHaveBeenCalledWith("f7");
  expect(o.devant).toHaveBeenCalledWith("f7");
});
