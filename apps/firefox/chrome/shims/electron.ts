// The reused Electron code only touches these at runtime inside code paths that never run in Firefox.
export const BrowserWindow = undefined;
export const session = undefined;
export const app = undefined;
// main/sites/injection.ts's brancherInjection, never called in Firefox: any use throws.
export const ipcMain = undefined;
export type WebContents = never;
