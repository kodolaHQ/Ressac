/** What to spawn for the agent host: the Node and host.mjs shipped in the app when present, else the dev build's constants (a packaged build carries no dev paths, so it throws). */
export async function hostCommand(
  resourcesDir: string,
  exists: (path: string) => Promise<boolean>,
): Promise<{ command: string; arguments: string[]; environment: Record<string, string> }> {
  const dir = `${resourcesDir}/webaios-host`;
  if (await exists(`${dir}/host.mjs`)) {
    return { command: `${dir}/node`, arguments: [`${dir}/host.mjs`], environment: { WEBAIOS_KERNEL_RESOURCES: `${dir}/kernel` } };
  }
  if (!__WEBAIOS_HOST__) throw new Error("the agent host is missing from this app");
  return { command: __WEBAIOS_NODE__, arguments: ["--import", __WEBAIOS_TSX__, __WEBAIOS_HOST__], environment: {} };
}
