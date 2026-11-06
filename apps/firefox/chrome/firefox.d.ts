// Loose ambient declarations for the Firefox globals the chrome code uses.
declare const IOUtils: {
  readUTF8(path: string): Promise<string>;
  writeUTF8(path: string, text: string, options?: { flush?: boolean }): Promise<number>;
  exists(path: string): Promise<boolean>;
  move(from: string, to: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  makeDirectory(path: string, options?: { createAncestors?: boolean; ignoreExisting?: boolean }): Promise<void>;
  remove(path: string, options?: { ignoreAbsent?: boolean; recursive?: boolean }): Promise<void>;
  stat(path: string): Promise<{ lastModified: number; size: number; type: "regular" | "directory" | "other" }>;
  read(path: string, options?: { maxBytes?: number }): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<number>;
  getChildren(path: string): Promise<string[]>;
};
declare const PathUtils: { join(...parts: string[]): string; readonly tempDir: string };
declare const Services: any;
declare const Ci: any;
declare const Cr: any;
declare const Cu: any;
declare const Cc: any;
declare const Components: { isSuccessCode(status: number): boolean; ID(id: string): unknown; manager: any };
declare const ChromeUtils: {
  importESModule(url: string): any;
  /** Milliseconds, monotonic. */
  now(): number;
  registerWindowActor(name: string, options: object): void;
  registerProcessActor(name: string, options: object): void;
  getAllDOMProcesses(): {
    remoteType: string | null;
    osPid: number;
    canSend: boolean;
    getActor(name: string): { sendAsyncMessage(name: string, data?: unknown): void; sendQuery(name: string, data?: unknown): Promise<unknown> };
  }[];
  getXPCOMErrorName(status: number): string;
  generateQI(interfaces: string[]): unknown;
};
declare const WebExtensionPolicy: {
  getByID(id: string): { mozExtensionHostname: string } | null;
  getByHostname(hostname: string): { id: string; extension?: any } | null;
  getActiveExtensions(): { extension?: any }[];
};
declare const WindowGlobalParent: { getByInnerWindowId(id: number): any };
declare const WindowGlobalChild: { getByInnerWindowId(id: number): any };
declare class JSWindowActorParent {
  readonly manager: any;
}
declare class JSProcessActorParent {
  readonly manager: { childID: number; remoteType: string };
}
declare class JSProcessActorChild {
  sendAsyncMessage(name: string, data?: unknown): void;
}
declare class JSWindowActorChild {
  readonly manager: any;
  readonly document: Document;
  readonly contentWindow: Window;
  readonly docShell: any;
  sendQuery(name: string, data?: unknown): Promise<unknown>;
}
// Absolute paths frozen by Vite `define` in the store bundle (scripts/paths.ts).
declare const __WEBAIOS_NODE__: string;
declare const __WEBAIOS_TSX__: string;
declare const __WEBAIOS_HOST__: string;
// Vite's raw imports (a file's text, bundled).
declare module "*?raw" {
  const text: string;
  export default text;
}
