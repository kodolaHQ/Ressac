import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { Permissions, type Decision, type Demande } from "../src/main/permissions";

let fichier: string;
let demandes: Demande[];
let reponse: Decision;
const creer = () =>
  new Permissions({
    fichier,
    demander: async (d) => {
      demandes.push(d);
      return reponse;
    },
  });

beforeEach(() => {
  fichier = join(mkdtempSync(join(tmpdir(), "webaios-perm-")), "permissions.json");
  demandes = [];
  reponse = "autoriser";
});

const meet = "https://meet.google.com";

test("première demande → on demande ; la décision est mémorisée et la seconde passe sans demande", async () => {
  const p = creer();
  expect(await p.traiter({ ongletId: "o1", origine: meet, permission: "notifications" })).toBe(true);
  expect(demandes).toEqual([{ ongletId: "o1", origine: meet, permissions: ["notifications"] }]);
  reponse = "refuser";
  expect(await p.traiter({ ongletId: "o1", origine: meet, permission: "notifications" })).toBe(true);
  expect(demandes).toHaveLength(1);
  expect(p.decisions()).toEqual({ [`${meet} notifications`]: "autoriser" });
});

test("caméra + micro : il faut les deux autorisations", async () => {
  const p = creer();
  expect(await p.traiter({ ongletId: "o1", origine: meet, permission: "media", mediaTypes: ["video", "audio"] })).toBe(true);
  expect(demandes.at(-1)?.permissions).toEqual(["media-camera", "media-micro"]);
  // Micro refusé ailleurs : la caméra seule ne suffit pas.
  const autre = "https://visio.fr";
  reponse = "refuser";
  await p.traiter({ ongletId: "o1", origine: autre, permission: "media", mediaTypes: ["audio"] });
  reponse = "autoriser";
  expect(await p.traiter({ ongletId: "o1", origine: autre, permission: "media", mediaTypes: ["video", "audio"] })).toBe(false);
  expect(demandes.at(-1)?.permissions).toEqual(["media-camera"]);
});

test("fullscreen accordé sans demande ; permission inconnue refusée sans demande", async () => {
  const p = creer();
  expect(await p.traiter({ ongletId: null, origine: meet, permission: "fullscreen" })).toBe(true);
  expect(await p.traiter({ ongletId: null, origine: meet, permission: "clipboard-sanitized-write" })).toBe(true);
  expect(await p.traiter({ ongletId: null, origine: meet, permission: "midiSysex" })).toBe(false);
  expect(demandes).toEqual([]);
});

test("verifier répond d'après les décisions mémorisées, sans jamais demander", async () => {
  const p = creer();
  expect(p.verifier(meet, "notifications")).toBe(false);
  await p.traiter({ ongletId: "o1", origine: meet, permission: "notifications" });
  expect(p.verifier(meet, "notifications")).toBe(true);
  expect(p.verifier(meet, "media", "video")).toBe(false);
  expect(p.verifier(meet, "fullscreen")).toBe(true);
  expect(demandes).toHaveLength(1);
});

test("deux demandes simultanées pour la même permission ne posent qu'une question", async () => {
  const p = creer();
  const r = await Promise.all([
    p.traiter({ ongletId: "o1", origine: meet, permission: "geolocation" }),
    p.traiter({ ongletId: "o2", origine: meet, permission: "geolocation" }),
  ]);
  expect(r).toEqual([true, true]);
  expect(demandes).toHaveLength(1);
});

test("decisions survivent à un rechargement du fichier", async () => {
  await creer().traiter({ ongletId: "o1", origine: meet, permission: "geolocation" });
  const p = creer();
  expect(p.decisions()).toEqual({ [`${meet} geolocation`]: "autoriser" });
  p.oublier(meet);
  expect(creer().decisions()).toEqual({});
});

test("permissions.json corrompu → aucune décision, pas de plantage", () => {
  writeFileSync(fichier, "{pas du json");
  const erreur = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(creer().decisions()).toEqual({});
  writeFileSync(fichier, JSON.stringify({ "https://a.fr notifications": "peut-être" }));
  expect(creer().decisions()).toEqual({});
  erreur.mockRestore();
});

test("ouvrir une application externe (mailto:…) : demandé à chaque fois avec le lien, jamais mémorisé", async () => {
  const p = creer();
  expect(await p.traiter({ ongletId: "o1", origine: meet, permission: "openExternal", lienExterne: "mailto:a@b.fr" })).toBe(true);
  expect(demandes.at(-1)).toEqual({ ongletId: "o1", origine: meet, permissions: ["ouvrir-application"], lien: "mailto:a@b.fr" });
  reponse = "refuser";
  expect(await p.traiter({ ongletId: "o1", origine: meet, permission: "openExternal", lienExterne: "zoommtg://x" })).toBe(false);
  expect(demandes).toHaveLength(2);
  expect(p.decisions()).toEqual({});
  expect(p.verifier(meet, "openExternal")).toBe(false);
});

test("refuserPermissions (session d'une appli) : plein écran et copie seulement, aucun périphérique", async () => {
  const { refuserPermissions } = await import("../src/main/permissions");
  const g: Record<string, (...a: never[]) => unknown> = {};
  const choix: Record<string, (...a: unknown[]) => void> = {};
  const session = {
    setPermissionRequestHandler: (h: never) => (g.demande = h),
    setPermissionCheckHandler: (h: never) => (g.verification = h),
    setDevicePermissionHandler: (h: never) => (g.peripherique = h),
    on: (evenement: string, h: (...a: unknown[]) => void) => (choix[evenement] = h),
  };
  refuserPermissions(session as unknown as Parameters<typeof refuserPermissions>[0]);
  const demander = (permission: string) => new Promise((ok) => (g.demande as (...a: unknown[]) => void)(null, permission, ok, { requestingUrl: "http://localhost:5280/" }));
  for (const p of ["media", "geolocation", "notifications", "openExternal", "clipboard-read", "hid", "serial", "midiSysex"]) {
    expect(await demander(p)).toBe(false);
    expect((g.verification as (...a: unknown[]) => boolean)(null, p, "http://localhost:5280", {})).toBe(false);
  }
  for (const p of ["fullscreen", "clipboard-sanitized-write"]) expect(await demander(p)).toBe(true);
  expect((g.peripherique as () => boolean)()).toBe(false);
  const empeche = vi.fn();
  const rappel = vi.fn();
  choix["select-hid-device"]!({ preventDefault: empeche }, {}, rappel);
  choix["select-serial-port"]!({ preventDefault: empeche }, [], null, rappel);
  choix["select-usb-device"]!({ preventDefault: empeche }, {}, rappel);
  expect(empeche).toHaveBeenCalledTimes(3);
  expect(rappel.mock.calls).toEqual([[], [""], []]);
});
