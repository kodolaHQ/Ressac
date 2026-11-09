import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadSession, SessionRecorder } from "../core/state/persistence";
import { apply } from "../core/state/actions";
import { initialState } from "../core/state/initial-state";
import { migrateStore } from "../chrome/store/migration";
import type { ContainerService } from "../chrome/store/containers";

const NOW = new Date("2026-11-09T10:00:00.000Z");
const BACKUP = ".avant-anglais-2026-11-09T10-00-00-000Z";

/** A session as the French build (format 2) wrote it. */
const OLD_SESSION = {
  version: 2,
  espaces: [
    { id: "e1", nom: "Perso", icone: "🏠", epingles: [{ id: "f1", url: "webaios://applications", titre: "Applis", favicon: null }], prive: false, profil: "defaut" },
    { id: "e2", nom: "Banque", icone: "🏦", epingles: [], prive: true, profil: "p-123" },
  ],
  profils: [{ id: "defaut" }, { id: "p-123" }],
  essentiels: [{ id: "f2", url: "https://a.test/", titre: "A", favicon: null }],
  onglets: {
    // A tab id that is also a French key: ids are never renamed.
    titre: { id: "titre", fenetreId: "w1", espaceId: "e1", url: "webaios://action/veille/2026-11-01T08-00-00Z-essai", titre: "Essai", favicon: null, lien: null, ouvertParAgent: false, zoom: 1 },
    o2: { id: "o2", fenetreId: "w1", espaceId: "e1", url: "webaios://relecture/site-carte", titre: "Relecture", favicon: null, lien: { type: "epingle", id: "f1" }, ouvertParAgent: true, zoom: 1.2 },
    o3: { id: "o3", fenetreId: "w1", espaceId: "e1", url: "https://a.test/", titre: "A", favicon: null, lien: { type: "essentiel", id: "f2" }, ouvertParAgent: false, zoom: 1 },
  },
  fenetres: [
    {
      id: "w1",
      espaceActif: "e1",
      ordre: { e1: ["titre", "o2", "o3"], e2: [] },
      actif: { e1: "o2", e2: null },
      compact: false,
      panneauAgentOuvert: true,
      fermesRecemment: [{ url: "webaios://applications", espaceId: "e1" }],
      cadre: { x: 1, y: 2, largeur: 800, hauteur: 600 },
    },
  ],
  reglages: { moteur: "qwant", profilAgent: "claude", largeurPanneauAgent: 400 },
};

function fakeContainers(names: Record<string, number>) {
  const calls: string[] = [];
  const service: ContainerService = {
    migrate: () => void calls.push("migrate"),
    rename(from, to) {
      calls.push(`rename ${from} ${to}`);
      if (!(from in names) || to in names) return false;
      names[to] = names[from]!;
      delete names[from];
      return true;
    },
  };
  return { service, calls, names };
}

function setup(o: { session?: unknown; permissions?: Record<string, unknown> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "webaios-mig-store-"));
  const dataDir = join(root, "data");
  const profileDir = join(root, "profile");
  mkdirSync(dataDir);
  mkdirSync(profileDir);
  writeFileSync(join(profileDir, "containers.json"), JSON.stringify({ version: 5, identities: [{ userContextId: 7, public: false, name: "userContextIdInternal.webaios-defaut" }] }));
  if (o.session !== undefined) writeFileSync(join(dataDir, "session.json"), JSON.stringify(o.session, null, 2));
  for (const [name, v] of Object.entries(o.permissions ?? {})) writeFileSync(join(dataDir, name), JSON.stringify(v));
  const c = fakeContainers({ defaut: 7 });
  const run = () => migrateStore({ dataDir, profileDir, containers: c.service, now: () => NOW });
  return { root, dataDir, profileDir, c, run };
}

const marker = (dataDir: string) => JSON.parse(readFileSync(join(dataDir, ".format-version"), "utf8"));

test("old data: full backup before any write, containers.json copied beside it", async () => {
  const s = setup({ session: OLD_SESSION, permissions: { "permissions.json": { "https://a.test media-camera": "autoriser" } } });
  mkdirSync(join(s.dataDir, "espace", "accueil"), { recursive: true });
  writeFileSync(join(s.dataDir, "espace", "accueil", "disposition.json"), "{}");
  expect(await s.run()).toBe("done");
  const backup = s.dataDir + BACKUP;
  expect(JSON.parse(readFileSync(join(backup, "session.json"), "utf8"))).toEqual(OLD_SESSION);
  expect(JSON.parse(readFileSync(join(backup, "permissions.json"), "utf8"))).toEqual({ "https://a.test media-camera": "autoriser" });
  expect(readFileSync(join(backup, "espace", "accueil", "disposition.json"), "utf8")).toBe("{}");
  expect(existsSync(join(backup, ".format-version"))).toBe(false);
  expect(readFileSync(backup + ".containers.json", "utf8")).toBe(readFileSync(join(s.profileDir, "containers.json"), "utf8"));
  expect(marker(s.dataDir)).toEqual({ store: 2, kernel: 1 });
  // The kernel half is the kernel's: espace is left for it.
  expect(existsSync(join(s.dataDir, "espace", "accueil", "disposition.json"))).toBe(true);
});

test("backup fails: nothing migrated, no marker, containers untouched", async () => {
  const s = setup({ session: OLD_SESSION, permissions: { "permissions.json": { "https://a.test geolocation": "refuser" } } });
  // The backup's place is taken.
  writeFileSync(s.dataDir + BACKUP, "x");
  await expect(s.run()).rejects.toThrow(/sauvegarde.*rien n'est migré/);
  // The place taken is never removed.
  expect(readFileSync(s.dataDir + BACKUP, "utf8")).toBe("x");
  expect(JSON.parse(readFileSync(join(s.dataDir, "session.json"), "utf8"))).toEqual(OLD_SESSION);
  expect(JSON.parse(readFileSync(join(s.dataDir, "permissions.json"), "utf8"))).toEqual({ "https://a.test geolocation": "refuser" });
  expect(existsSync(join(s.dataDir, ".format-version"))).toBe(false);
  expect(s.c.calls).toEqual([]);
});

test("an unreadable file stops the backup: nothing migrated", async () => {
  const s = setup({ session: OLD_SESSION });
  writeFileSync(join(s.dataDir, "secret.json"), "{}");
  chmodSync(join(s.dataDir, "secret.json"), 0o000);
  await expect(s.run()).rejects.toThrow(/sauvegarde/);
  expect(JSON.parse(readFileSync(join(s.dataDir, "session.json"), "utf8"))).toEqual(OLD_SESSION);
  expect(existsSync(join(s.dataDir, ".format-version"))).toBe(false);
  // No partial copy left to pass for a full one.
  expect(readdirSync(s.root).sort()).toEqual(["data", "profile"]);
  chmodSync(join(s.dataDir, "secret.json"), 0o600);
});

test("session v2 → v3: keys, default profile, link types, every webaios:// url, -attempt; read back by loadSession", async () => {
  const s = setup({ session: OLD_SESSION });
  await s.run();
  const v = JSON.parse(readFileSync(join(s.dataDir, "session.json"), "utf8"));
  expect(v.version).toBe(3);
  expect(v.profiles).toEqual([{ id: "default" }, { id: "p-123" }]);
  expect(v.spaces[0]).toEqual({ id: "e1", name: "Perso", icon: "🏠", pinned: [{ id: "f1", url: "webaios://apps", title: "Applis", favicon: null }], private: false, profile: "default" });
  expect(v.spaces[1].profile).toBe("p-123");
  expect(Object.keys(v.tabs)).toEqual(["titre", "o2", "o3"]);
  expect(v.tabs.titre).toMatchObject({ windowId: "w1", spaceId: "e1", url: "webaios://action/veille/2026-11-01T08-00-00Z-attempt", title: "Essai", openedByAgent: false });
  expect(v.tabs.o2).toMatchObject({ url: "webaios://review/site-carte", link: { type: "pinned", id: "f1" }, openedByAgent: true });
  expect(v.tabs.o3.link).toEqual({ type: "essential", id: "f2" });
  expect(v.windows[0]).toEqual({
    id: "w1",
    activeSpace: "e1",
    order: { e1: ["titre", "o2", "o3"], e2: [] },
    active: { e1: "o2", e2: null },
    compact: false,
    agentPanelOpen: true,
    recentlyClosed: [{ url: "webaios://apps", spaceId: "e1" }],
    frame: { x: 1, y: 2, width: 800, height: 600 },
  });
  expect(v.settings).toEqual({ engine: "qwant", agentProfile: "claude", agentPanelWidth: 400 });
  const kept: string[] = [];
  const state = await loadSession(s.dataDir, (p) => kept.push(p));
  expect(kept).toEqual([]);
  expect(state.tabs.o2!.url).toBe("webaios://review/site-carte");
});

test("session v1 (no private spaces nor profiles) → v3 on the default profile", async () => {
  const { profils: _p, ...rest } = OLD_SESSION;
  const v1 = { ...rest, version: 1, espaces: OLD_SESSION.espaces.map(({ prive: _x, profil: _y, ...e }) => e) };
  const s = setup({ session: v1 });
  await s.run();
  const state = await loadSession(s.dataDir);
  expect(state.profiles).toEqual([{ id: "default" }]);
  for (const e of state.spaces) expect(e).toMatchObject({ private: false, profile: "default" });
});

test("permissions files: autoriser|refuser → allow|deny, origins kept", async () => {
  const s = setup({
    session: OLD_SESSION,
    permissions: {
      "permissions.json": { "https://a.test media-camera": "autoriser", "https://b.test notifications": "refuser" },
      "permissions-p-123.json": { "https://c.test midi": "autoriser" },
      "permissions-site-x.json": { "https://d.test drm": "allow" },
    },
  });
  await s.run();
  const read = (n: string) => JSON.parse(readFileSync(join(s.dataDir, n), "utf8"));
  expect(read("permissions.json")).toEqual({ "https://a.test media-camera": "allow", "https://b.test notifications": "deny" });
  expect(read("permissions-p-123.json")).toEqual({ "https://c.test midi": "allow" });
  expect(read("permissions-site-x.json")).toEqual({ "https://d.test drm": "allow" });
});

test("the default profile's container is renamed in place (same userContextId)", async () => {
  const s = setup({ session: OLD_SESSION });
  await s.run();
  expect(s.c.calls).toEqual(["migrate", "rename defaut default"]);
  expect(s.c.names).toEqual({ default: 7 });
});

test("re-run: already, nothing written, no second backup", async () => {
  const s = setup({ session: OLD_SESSION, permissions: { "permissions.json": { "https://a.test geolocation": "autoriser" } } });
  await s.run();
  const before = readdirSync(s.dataDir).map((n) => [n, readFileSync(join(s.dataDir, n), "utf8")]);
  s.c.calls.length = 0;
  expect(await migrateStore({ dataDir: s.dataDir, profileDir: s.profileDir, containers: s.c.service, now: () => new Date("2026-11-10T00:00:00Z") })).toBe("already");
  expect(readdirSync(s.dataDir).map((n) => [n, readFileSync(join(s.dataDir, n), "utf8")])).toEqual(before);
  expect(readdirSync(s.root).filter((n) => n.includes("avant-anglais")).length).toBe(2); // the backup and its containers.json
  expect(s.c.calls).toEqual([]);
});

test("a run cut after the backup runs again to the same result", async () => {
  const s = setup({ session: OLD_SESSION });
  await s.run();
  const done = readFileSync(join(s.dataDir, "session.json"), "utf8");
  // Cut before the marker: written files are already new, the second run leaves them.
  writeFileSync(join(s.dataDir, ".format-version"), JSON.stringify({ store: 1, kernel: 1 }));
  expect(await migrateStore({ dataDir: s.dataDir, profileDir: s.profileDir, containers: s.c.service, now: () => new Date("2026-11-10T00:00:00Z") })).toBe("already");
  expect(readFileSync(join(s.dataDir, "session.json"), "utf8")).toBe(done);
  expect(marker(s.dataDir).store).toBe(2);
});

test("a new data folder: only the marker, no backup", async () => {
  const s = setup();
  expect(await s.run()).toBe("already");
  expect(readdirSync(s.dataDir)).toEqual([".format-version"]);
  expect(readdirSync(s.root).sort()).toEqual(["data", "profile"]);
  expect(s.c.calls).toEqual([]);
  // A data folder that does not exist yet.
  const fresh = join(s.root, "none");
  expect(await migrateStore({ dataDir: fresh, profileDir: s.profileDir, containers: s.c.service })).toBe("already");
  expect(marker(fresh)).toEqual({ store: 2, kernel: 1 });
});

test("a v3 session written by this build is left as is (fixed point)", async () => {
  const s = setup();
  let e = initialState();
  e = apply(e, { type: "openTab", windowId: e.windows[0]!.id, url: "webaios://apps" });
  const r = new SessionRecorder(s.dataDir, 0);
  r.schedule(e);
  await r.clear();
  const text = readFileSync(join(s.dataDir, "session.json"), "utf8");
  expect(await s.run()).toBe("already");
  expect(readFileSync(join(s.dataDir, "session.json"), "utf8")).toBe(text);
});

test("future marker: nothing read nor written", async () => {
  const s = setup({ session: OLD_SESSION });
  writeFileSync(join(s.dataDir, ".format-version"), JSON.stringify({ store: 3, kernel: 2 }));
  await expect(s.run()).rejects.toThrow(/plus récente/);
  expect(JSON.parse(readFileSync(join(s.dataDir, "session.json"), "utf8"))).toEqual(OLD_SESSION);
  expect(readdirSync(s.root).sort()).toEqual(["data", "profile"]);
});
