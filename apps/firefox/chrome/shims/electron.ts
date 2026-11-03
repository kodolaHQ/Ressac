// The reused Electron code only touches these at runtime inside code paths that never run in Firefox.
export const BrowserWindow = undefined;
export const session = undefined;
export type WebContents = never;
