// Stand-in for node:path; only join is used by the state code.
export const join = (...parts: string[]): string => PathUtils.join(...parts);
// The rest throws: no bundled code that runs in Firefox may call it.
const unavailable = (): never => {
  throw new Error("node:path is not available in Firefox");
};
export const basename = unavailable;
export const dirname = unavailable;
export const resolve = unavailable;
