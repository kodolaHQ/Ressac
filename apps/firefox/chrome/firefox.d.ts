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
