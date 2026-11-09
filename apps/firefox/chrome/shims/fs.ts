// Stand-in for node:fs/promises, on top of IOUtils (Firefox system modules have no Node). Only the calls the
// session persistence and the data migration use. IOUtils reports a missing file as a DOMException "NotFoundError": map it to ENOENT.
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
export const rm = (path: string, options: { force: true; recursive?: boolean }): Promise<void> => IOUtils.remove(path, { ignoreAbsent: true, recursive: !!options.recursive });

/** Only mode "w" (truncate). Each writeFile is flushed to disk, so sync has nothing left to do. */
export async function open(path: string, _mode: "w") {
  await IOUtils.writeUTF8(path, "");
  return {
    writeFile: (text: string): Promise<number> => IOUtils.writeUTF8(path, text, { flush: true }),
    sync: async (): Promise<void> => {},
    close: async (): Promise<void> => {},
  };
}

export const constants = { COPYFILE_EXCL: 1 };
export const writeFile = (path: string, text: string): Promise<number> => IOUtils.writeUTF8(path, text);
export const readdir = (path: string): Promise<string[]> => wrap(path, async () => (await IOUtils.getChildren(path)).map((p) => PathUtils.filename(p)));
/** A file copy that fails if `to` exists (the data migration's backup). */
export const copyFile = (from: string, to: string, _mode?: number): Promise<void> => wrap(from, () => IOUtils.copy(from, to, { noOverwrite: true }));

/** Never follows a link (IOUtils.stat does). */
export async function lstat(path: string) {
  const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  f.initWithPath(path);
  let link: boolean;
  try {
    link = f.isSymlink();
  } catch {
    throw enoent(path);
  }
  return { isSymbolicLink: () => link, isDirectory: () => !link && f.isDirectory(), isFile: () => !link && f.isFile() };
}

export default { readFile, access, rename, mkdir, rm, open, writeFile, readdir, copyFile, lstat, constants };
