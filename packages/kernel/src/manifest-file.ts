/** The file a project (launch) or an agent extension (network) declares itself in. */
export const MANIFEST_FILE = "ressac.json";
/** Read for projects and extensions the agent wrote before the rename to Ressac. */
export const LEGACY_MANIFEST_FILE = "webaios.json";

/** The first of `ressac.json`, `webaios.json` that `read` finds (not undefined), with its name. */
export async function readManifestFile<T>(read: (name: string) => T | undefined | Promise<T | undefined>): Promise<{ name: string; content: T } | undefined> {
  for (const name of [MANIFEST_FILE, LEGACY_MANIFEST_FILE]) {
    const content = await read(name);
    if (content !== undefined) return { name, content };
  }
  return undefined;
}
