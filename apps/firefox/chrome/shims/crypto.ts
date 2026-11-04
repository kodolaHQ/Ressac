// Stand-in for node:crypto inside Firefox system modules (Web Crypto is a global there).
export const randomUUID = (): string => crypto.randomUUID();
// Electron's reseau.ts imports it for code that never runs in Firefox.
export const createHash = (): never => {
  throw new Error("createHash is not available in Firefox");
};
