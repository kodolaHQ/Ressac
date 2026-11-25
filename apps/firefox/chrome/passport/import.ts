import { detectSources, SOURCES, sourceRoot } from "../store/import/sources";
import { fromFirefoxJson, readAddresses, type FoundAddress } from "./addresses";
import { drafts, proposeWithMembers, type Draft, type Proposal } from "./import-choice";
import type { AddManyResult, PassportSettings } from "./settings";

export type PassportImportSource = { id: string; name: string };
/** `access: "ask"`: macOS wants the person's consent for that browser's folder first; nothing was read. */
type Proposed = { proposals: Proposal[]; incomplete: number; name: string; access: "ready" | "ask" };
type RessacStore = { records: unknown[]; remove(guids: string[]): Promise<void> };

/** Ressac's own Firefox address store (the engine's form autofill), read and erased only on the user's gesture. */
async function firefoxStore(): Promise<RessacStore> {
  const { formAutofillStorage } = ChromeUtils.importESModule("resource://autofill/FormAutofillStorage.sys.mjs");
  await formAutofillStorage.initialize();
  return {
    records: await formAutofillStorage.addresses.getAll(),
    remove: async (guids) => {
      for (const guid of guids) await formAutofillStorage.addresses.remove(guid);
    },
  };
}

/**
 * The narrow door of « Importer depuis… »: the page names a source, then rows by key and « Moi / Un proche ». The values
 * stay here, from the last `proposals()`; nothing the page sends becomes a value. Every write asks Touch ID (`addMany`).
 */
export function createPassportImporter(o: {
  home: string;
  scratch: string;
  passport: Pick<PassportSettings, "addMany">;
  reason(): string;
  /** The importer's folder-access step (macOS 27+): a source that asks is not read until it was granted. */
  access?: (source: string) => Promise<"ready" | "ask">;
  exists?: (path: string) => Promise<boolean>;
  read?: typeof readAddresses;
  ressacStore?: () => Promise<RessacStore>;
}) {
  const exists = o.exists ?? ((p: string) => IOUtils.exists(p));
  const access = o.access ?? (async () => "ready" as const);
  const read = o.read ?? readAddresses;
  const store = o.ressacStore ?? firefoxStore;
  // The reader copies into one fixed scratch file: one read at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const alone = <T>(job: () => Promise<T>): Promise<T> => {
    const run = queue.then(job, job);
    queue = run.catch(() => {});
    return run;
  };
  let last: { source: string; byKey: Map<string, Proposal>; guids: Map<string, string[]> } | null = null;

  async function found(source: string): Promise<{ found: FoundAddress[]; guids: (string | null)[]; name: string } | null> {
    if (source === "ressac") {
      const s = await store().catch(() => null);
      return s && { found: fromFirefoxJson({ addresses: s.records }), guids: s.records.map((r) => (typeof (r as { guid?: unknown })?.guid === "string" ? (r as { guid: string }).guid : null)), name: "Ressac" };
    }
    const def = (await detectSources(o.home, exists)).find((d) => d.id === source);
    return def ? { found: await read(def, sourceRoot(o.home, def), o.scratch), guids: [], name: def.name } : null;
  }

  return {
    // Names only: nothing of any browser is read until the person picks one.
    sources: async (): Promise<PassportImportSource[]> => [...(await detectSources(o.home, exists)).map((d) => ({ id: d.id, name: d.name })), { id: "ressac", name: "Ressac" }],

    proposals: (source: string): Promise<Proposed> =>
      alone(async () => {
        const id = String(source);
        const name = SOURCES.find((d) => d.id === id)?.name ?? "Ressac";
        if (id !== "ressac" && (await access(id).catch(() => "ask" as const)) === "ask") {
          last = null;
          return { proposals: [], incomplete: 0, name, access: "ask" as const };
        }
        const f = await found(id).catch((e) => (console.error("[passport] import read failed:", (e as Error)?.name), null));
        const { members, ...r } = proposeWithMembers(f?.found ?? []);
        last = { source: String(source), byKey: new Map(r.proposals.map((p) => [p.key, p])), guids: new Map(r.proposals.map((p, i) => [p.key, members[i]!.flatMap((n) => f?.guids[n] ?? [])])) };
        return { ...structuredClone(r), name, access: "ready" as const };
      }),

    async add(profile: string, rows: { key: string; as: "me" | "proche" }[], source: string, eraseRessac?: boolean): Promise<AddManyResult> {
      if (!last || last.source !== String(source)) return { ok: false, error: "unreadable" };
      const known = last;
      // Only a row written in full ("me") may erase its Firefox records: a « proche » keeps just the name.
      const used = new Set<string>();
      const list: Draft[] = (Array.isArray(rows) ? rows : []).flatMap((r) => {
        const p = known.byKey.get(String(r?.key));
        if (p && r.as !== "proche") used.add(p.key);
        return p ? drafts(p, r.as === "proche" ? "proche" : "me") : [];
      });
      if (!list.length) return { ok: true, added: 0, variants: 0, full: 0, invalid: 0 };
      const r = await o.passport.addMany({ profile: String(profile), drafts: list, how: "import", from: String(source), origin: null, reason: o.reason() });
      if (r.ok && r.full === 0 && r.invalid === 0 && eraseRessac && source === "ressac" && used.size) {
        const s = await store().catch(() => null);
        await s?.remove([...used].flatMap((k) => known.guids.get(k) ?? [])).catch((e) => console.error("[passport] erase failed:", (e as Error)?.name));
      }
      return r;
    },
  };
}
export type PassportImporter = ReturnType<typeof createPassportImporter>;
