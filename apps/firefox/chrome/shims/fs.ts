// Stand-in for node:fs/promises, on top of IOUtils (Firefox system modules have no Node). Only the calls the
// session persistence uses. IOUtils reports a missing file as a DOMException "NotFoundError": map it to ENOENT.
const enoent = (path: string): Error => Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: "ENOENT" });
const wrap = async <T>(path: string, run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (e) {
    throw (e as { name?: string })?.name === "NotFoundError" ? enoent(path) : e;
  }
};

export const readFile = (path: string, _encoding: "utf8"): Promise<string> => wrap(path, () => IOUtils.readUTF8(path));
export const access = async (path: string): Promise<void> => {
  if (!(await IOUtils.exists(path))) throw enoent(path);
};
export const rename = (from: string, to: string): Promise<void> => wrap(from, () => IOUtils.move(from, to));
export const mkdir = (path: string, _options: { recursive: true }): Promise<void> =>
  IOUtils.makeDirectory(path, { createAncestors: true, ignoreExisting: true });
export const rm = (path: string, _options: { force: true }): Promise<void> => IOUtils.remove(path, { ignoreAbsent: true });

/** Only mode "w" (truncate). Each writeFile is flushed to disk, so sync has nothing left to do. */
export async function open(path: string, _mode: "w") {
  await IOUtils.writeUTF8(path, "");
  return {
    writeFile: (text: string): Promise<number> => IOUtils.writeUTF8(path, text, { flush: true }),
    sync: async (): Promise<void> => {},
    close: async (): Promise<void> => {},
  };
}

/** node:fs (sync): only imported by Electron's reseau.ts, for code that never runs in Firefox. */
export const realpathSync = (): never => {
  throw new Error("realpathSync is not available in Firefox");
};

export default { readFile, access, rename, mkdir, rm, open };
