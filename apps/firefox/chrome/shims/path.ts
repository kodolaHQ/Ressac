// Stand-in for node:path; only join is used by the state code.
export const join = (...parts: string[]): string => PathUtils.join(...parts);
