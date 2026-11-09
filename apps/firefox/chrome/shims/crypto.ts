// Stand-in for node:crypto inside Firefox system modules (Web Crypto is a global there).
export const randomUUID = (): string => crypto.randomUUID();
// Throws: no bundled code that runs in Firefox may hash.
export const createHash = (): never => {
  throw new Error("createHash is not available in Firefox");
};
