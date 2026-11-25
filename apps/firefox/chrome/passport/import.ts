import { detectSources, SOURCES, sourceRoot } from "../store/import/sources";
import { fromFirefoxJson, readAddresses, type FoundAddress } from "./addresses";
import { drafts, propose, proposeWithMembers, type Draft, type Proposal } from "./import-choice";
import type { AddManyResult, PassportSettings } from "./settings";

export type PassportImportSource = { id: string; name: string; count: number };
type Proposed = { proposals: Proposal[]; incomplete: number };
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
  exists?: (path: string) => Promise<boolean>;
  read?: typeof readAddresses;
  ressacStore?: () => Promise<RessacStore>;
}) {
  const exists = o.exists ?? ((p: string) => IOUtils.exists(p));
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
    sources: (): Promise<PassportImportSource[]> =>
      alone(async () => {
        const ids = [...(await detectSources(o.home, exists)).map((d) => d.id), "ressac"];
        const out: PassportImportSource[] = [];
        for (const id of ids) {
          const f = await found(id).catch(() => null);
          const count = f ? propose(f.found).proposals.length : 0;
          if (f && (id !== "ressac" || count)) out.push({ id, name: id === "ressac" ? f.name : SOURCES.find((d) => d.id === id)!.name, count });
        }
        return out;
      }),

    proposals: (source: string): Promise<Proposed> =>
      alone(async () => {
        const f = await found(String(source)).catch((e) => (console.error("[passport] import read failed:", (e as Error)?.name), null));
        const { members, ...r } = proposeWithMembers(f?.found ?? []);
        last = { source: String(source), byKey: new Map(r.proposals.map((p) => [p.key, p])), guids: new Map(r.proposals.map((p, i) => [p.key, members[i]!.flatMap((n) => f?.guids[n] ?? [])])) };
        return structuredClone(r);
      }),

    async add(profile: string, rows: { key: string; as: "me" | "proche" }[], source: string, eraseRessac?: boolean): Promise<AddManyResult> {
      if (!last || last.source !== String(source)) return { ok: false, error: "unreadable" };
      const known = last;
      const used = new Set<string>();
      const list: Draft[] = (Array.isArray(rows) ? rows : []).flatMap((r) => {
        const p = known.byKey.get(String(r?.key));
        if (p) used.add(p.key);
        return p ? drafts(p, r.as === "proche" ? "proche" : "me") : [];
      });
      if (!list.length) return { ok: true, added: 0, variants: 0, full: 0, invalid: 0 };
      const r = await o.passport.addMany({ profile: String(profile), drafts: list, how: "import", from: String(source), origin: null, reason: o.reason() });
      if (r.ok && eraseRessac && source === "ressac" && used.size) {
        const s = await store().catch(() => null);
        await s?.remove([...used].flatMap((k) => known.guids.get(k) ?? [])).catch((e) => console.error("[passport] erase failed:", (e as Error)?.name));
      }
      return r;
    },
  };
}
export type PassportImporter = ReturnType<typeof createPassportImporter>;
