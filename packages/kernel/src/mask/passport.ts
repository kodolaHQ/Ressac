// The user's passports in memory (design § 5.4): one per login profile, pushed by the host. Never printed or logged.
import { originMatches, PASSPORT_PROFILE as PROFILE, passportForms, validatePassport, type Forms, type PassportEntry } from "./passport-fields.js";

export type PassportRef = { profile: string; id: string };

const formKeys = (forms: Iterable<Forms>) => new Set([...forms].flatMap((f) => [...f.folded.map((x) => `f:${x.form}`), ...f.digits.map((d) => `d:${d}`)]));

/**
 * Created once per host process, before any kernel, and handed to it (a kernel restart keeps it). Ready at once,
 * unless built with `awaitReady` (the host only): then `ready` waits for `markReady`, after the host pushed every profile.
 */
export class PassportStore {
  readonly ready: Promise<void>;
  private resolveReady: () => void = () => {};
  /** `byId`: each entry's search forms (design § 6.3), computed once here; `forms`: all of them as strings, for `added`. */
  private readonly profilesById = new Map<string, { entries: readonly PassportEntry[]; byId: Map<string, Forms>; forms: Set<string> }>();
  private unreadableIds = new Set<string>();
  private changes = 0;
  /** e2e only (the kernel sets it from RESSAC_TEST_LOCAL_ADDRESSES): `originMatches`' loopback seam, for every caller. */
  readonly localAddresses: boolean;

  /** `localAddresses` (e2e only, from RESSAC_TEST_LOCAL_ADDRESSES): an origin on a loopback host also matches over http. */
  constructor(o: { awaitReady?: boolean; localAddresses?: boolean } = {}) {
    this.ready = o.awaitReady ? new Promise((r) => (this.resolveReady = r)) : Promise.resolve();
    this.localAddresses = o.localAddresses ?? false;
  }

  get version(): number {
    return this.changes;
  }

  /**
   * The profile's whole passport, its invalid entries dropped. `added`: the ids of the entries that brought a search form
   * no profile had before (design § 5.3, what marks open conversations « non couverte »); a move between profiles adds none.
   */
  replace(profile: string, entries: readonly PassportEntry[]): { added: string[] } {
    checkProfile(profile);
    if (!Array.isArray(entries)) throw new Error("invalid passport");
    const kept = validatePassport(entries).kept;
    const byId = new Map(kept.map((e) => [e.id, passportForms(e)]));
    const forms = formKeys(byId.values());
    const before = [...this.profilesById.values()];
    const isNew = (f: string) => !before.some((p) => p.forms.has(f));
    const added = [...byId].filter(([, f]) => [...formKeys([f])].some(isNew)).map(([id]) => id);
    this.profilesById.set(profile, { entries: kept, byId, forms });
    this.unreadableIds.delete(profile);
    this.changes++;
    return { added };
  }

  drop(profile: string): void {
    checkProfile(profile);
    this.profilesById.delete(profile);
    this.unreadableIds.delete(profile);
    this.changes++;
  }

  entries(profile: string): readonly PassportEntry[] {
    return this.profilesById.get(profile)?.entries ?? [];
  }

  get(ref: PassportRef): PassportEntry | undefined {
    return this.entries(ref.profile).find((e) => e.id === ref.id);
  }

  /** The entry's search forms, or nothing once it left the passport. */
  formsOf(ref: PassportRef): Forms | undefined {
    return this.profilesById.get(ref.profile)?.byId.get(ref.id);
  }

  profiles(): string[] {
    return [...this.profilesById.keys()];
  }

  /** Every entry's « Remplissable sur » hosts as they are now: a conversation keeps the ones it started with (`Masker.open`). */
  origins(): PassportOrigins {
    return new PassportOrigins(new Map([...this.profilesById].flatMap(([profile, p]) => p.entries.map((e) => [refKey({ profile, id: e.id }), e.origins] as const))), this.localAddresses);
  }

  /** The host pushed every profile it could read; `unreadable`: those it could not (their banner stays up). */
  markReady(unreadable: readonly string[]): void {
    this.unreadableIds = new Set(unreadable);
    this.resolveReady();
  }

  unreadable(): readonly string[] {
    return [...this.unreadableIds];
  }

  toJSON(): string {
    return "[passeport]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[passeport]";
  }
}

const refKey = (r: PassportRef) => `${r.profile}\n${r.id}`;

/** The entries' « Remplissable sur » hosts at one moment (design § 8.1), by entry. */
export class PassportOrigins {
  constructor(
    private readonly byRef: ReadonlyMap<string, readonly string[]>,
    readonly localAddresses: boolean,
  ) {}

  /** The entry's hosts; none for an entry it did not have. */
  of(ref: PassportRef): readonly string[] {
    return this.byRef.get(refKey(ref)) ?? [];
  }

  /** Every host of every entry, once. */
  hosts(): string[] {
    return [...new Set([...this.byRef.values()].flat())];
  }

  /** The page at `url` is on an entry's « Remplissable sur » origin. */
  isOrigin(url: string): boolean {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return false;
    }
    return this.hosts().some((h) => originMatches(h, origin, { localAddresses: this.localAddresses }));
  }
}

function checkProfile(profile: string): void {
  if (!PROFILE.test(profile)) throw new Error("invalid passport profile");
}
