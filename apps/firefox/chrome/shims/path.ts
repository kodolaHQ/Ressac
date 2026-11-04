// Stand-in for node:path; only join is used by the state code.
export const join = (...parts: string[]): string => PathUtils.join(...parts);
// Imported by Electron's reseau.ts for code that never runs in Firefox.
const unavailable = (): never => {
  throw new Error("node:path is not available in Firefox");
};
export const basename = unavailable;
export const dirname = unavailable;
export const resolve = unavailable;
