// Copy of the kernel's validFolder (packages/kernel/src/applications/manifeste.ts): that file imports node:fs and
// chokidar, which the store bundle cannot load. test/containers.test.ts guards the drift.

/** A folder launches only if its name passes in a shell command without quotes. */
export const validFolder = (folder: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(folder);
