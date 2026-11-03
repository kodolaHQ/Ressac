// Loose ambient declarations for the Firefox globals the chrome code uses.
declare const IOUtils: {
  readUTF8(path: string): Promise<string>;
  writeUTF8(path: string, text: string, options?: { flush?: boolean }): Promise<number>;
  exists(path: string): Promise<boolean>;
  move(from: string, to: string): Promise<void>;
  makeDirectory(path: string, options?: { createAncestors?: boolean; ignoreExisting?: boolean }): Promise<void>;
  remove(path: string, options?: { ignoreAbsent?: boolean }): Promise<void>;
};
declare const PathUtils: { join(...parts: string[]): string };
declare const Services: any;
declare const Ci: any;
declare const ChromeUtils: { importESModule(url: string): any; registerWindowActor(name: string, options: object): void };
declare class JSWindowActorParent {}
declare class JSWindowActorChild {
  readonly document: Document;
  readonly contentWindow: Window;
}
// Absolute paths frozen by Vite `define` in the store bundle (scripts/paths.ts).
declare const __WEBAIOS_NODE__: string;
declare const __WEBAIOS_TSX__: string;
declare const __WEBAIOS_HOST__: string;
