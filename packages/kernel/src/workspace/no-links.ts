import { realpath } from "node:fs/promises";
import { join, relative } from "node:path";

/**
 * True when `folder` exists under `root` with no symbolic link on the way. The workspace is mounted writable in
 * the container, so the agent can plant links in it: a file the kernel reads or writes there on the Mac must not
 * lead elsewhere.
 */
export async function linkFree(root: string, folder: string): Promise<boolean> {
  try {
    const [r, real] = await Promise.all([realpath(root), realpath(folder)]);
    return real === join(r, relative(root, folder));
  } catch {
    return false;
  }
}
