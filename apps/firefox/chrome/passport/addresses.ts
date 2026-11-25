import { chromiumProfiles, firefoxProfiles, type SourceDef } from "../store/import/sources";

export type FoundAddress = { given: string; family: string; full: string; street: string; postcode: string; city: string; country: string; tel: string; email: string; usedAt: number; useCount: number };

// Chromium FieldType codes, checked 2026-11-25 against components/autofill/core/browser/field_types.h (chromium/src, main).
export const CHROMIUM_FIELD: Record<number, keyof FoundAddress> = {
  3: "given", // NAME_FIRST
  5: "family", // NAME_LAST
  7: "full", // NAME_FULL
  9: "email", // EMAIL_ADDRESS
  14: "tel", // PHONE_HOME_WHOLE_NUMBER
  33: "city", // ADDRESS_HOME_CITY
  35: "postcode", // ADDRESS_HOME_ZIP
  36: "country", // ADDRESS_HOME_COUNTRY
  77: "street", // ADDRESS_HOME_STREET_ADDRESS
};

const blank = (usedAt: number, useCount: number): FoundAddress => ({ given: "", family: "", full: "", street: "", postcode: "", city: "", country: "", tel: "", email: "", usedAt, useCount });

export function fromChromiumRows(addresses: { guid: string; use_count: number; use_date: number }[], tokens: { guid: string; type: number; value: string }[]): FoundAddress[] {
  const byGuid = new Map(addresses.map((a) => [a.guid, blank(a.use_date * 1000, a.use_count)]));
  for (const t of tokens) {
    const field = CHROMIUM_FIELD[t.type];
    const found = byGuid.get(t.guid);
    if (field && found && typeof t.value === "string") (found[field] as string) = t.value;
  }
  return [...byGuid.values()];
}

const FIREFOX_FIELD = { given: "given-name", family: "family-name", full: "name", street: "street-address", postcode: "postal-code", city: "address-level2", country: "country", tel: "tel", email: "email" } as const;

export function fromFirefoxJson(json: unknown): FoundAddress[] {
  const list = (json as { addresses?: unknown } | null)?.addresses;
  if (!Array.isArray(list)) return [];
  return list.flatMap((r: any) => {
    if (!r || typeof r !== "object") return [];
    const a = blank(Number(r.timeLastUsed) || 0, Number(r.timesUsed) || 0);
    for (const [field, key] of Object.entries(FIREFOX_FIELD)) if (typeof r[key] === "string") (a as any)[field] = r[key];
    return [a];
  });
}

/** Every saved address of one browser, all its profiles. Reads copies (the browser may hold the files); errors are logged by name and read as nothing. */
export async function readAddresses(def: SourceDef, root: string, scratch: string): Promise<FoundAddress[]> {
  try {
    if (def.kind === "firefox") {
      const profiles = firefoxProfiles(await IOUtils.readUTF8(`${root}/profiles.ini`).catch(() => ""), root);
      const lists = await Promise.all(profiles.map((p) => IOUtils.readJSON(`${p.id}/autofill-profiles.json`).then(fromFirefoxJson, () => [])));
      return lists.flat();
    }
    if (def.kind !== "chromium") return [];
    const profiles = chromiumProfiles(await IOUtils.readUTF8(`${root}/Local State`).then(JSON.parse, () => null)) ?? [{ id: "Default", name: "Default" }];
    const { Sqlite } = ChromeUtils.importESModule("resource://gre/modules/Sqlite.sys.mjs");
    await IOUtils.makeDirectory(scratch, { createAncestors: true, ignoreExisting: true });
    await IOUtils.setPermissions(scratch, 0o700);
    const out: FoundAddress[] = [];
    for (const p of profiles) {
      const source = `${root}/${p.id}/Web Data`;
      const copy = `${scratch}/Web Data`;
      // One locked or corrupt profile is read as nothing: the others still count.
      try {
        if (!(await IOUtils.exists(source))) continue;
        for (const suffix of ["", "-wal"]) if (await IOUtils.exists(source + suffix)) await IOUtils.copy(source + suffix, copy + suffix);
        for (const suffix of ["", "-wal"]) if (await IOUtils.exists(copy + suffix)) await IOUtils.setPermissions(copy + suffix, 0o600);
        const db = await Sqlite.openConnection({ path: copy, readOnly: true });
        try {
          const has = async (name: string) => (await db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = :name", { name })).length > 0;
          for (const [table, tokenTable] of [["addresses", "address_type_tokens"], ["contact_info", "contact_info_type_tokens"]] as const) {
            if (!(await has(table)) || !(await has(tokenTable))) continue;
            const addresses = (await db.execute(`SELECT guid, use_count, use_date FROM ${table}`)).map((r: any) => ({ guid: r.getResultByName("guid"), use_count: r.getResultByName("use_count"), use_date: r.getResultByName("use_date") }));
            const tokens = (await db.execute(`SELECT guid, type, value FROM ${tokenTable}`)).map((r: any) => ({ guid: r.getResultByName("guid"), type: r.getResultByName("type"), value: r.getResultByName("value") }));
            out.push(...fromChromiumRows(addresses, tokens));
          }
        } finally {
          await db.close();
        }
      } catch (e) {
        console.error("[passport] a profile's addresses were not read:", (e as Error)?.name);
      } finally {
        // The copy holds the browser's whole form history in clear: gone with every side file SQLite may have made.
        for (const suffix of ["", "-wal", "-shm", "-journal"]) await IOUtils.remove(copy + suffix, { ignoreAbsent: true }).catch(() => {});
      }
    }
    return out;
  } catch (e) {
    console.error("[passport] addresses read failed:", (e as Error)?.name);
    return [];
  }
}
