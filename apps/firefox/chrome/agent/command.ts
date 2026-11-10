/** What to spawn for the agent host: the Node and host.mjs shipped in the app when present, else the dev build's constants. */
export async function hostCommand(
  resourcesDir: string,
  exists: (path: string) => Promise<boolean>,
): Promise<{ command: string; arguments: string[]; environment: Record<string, string> }> {
  const dir = `${resourcesDir}/webaios-host`;
  if (await exists(`${dir}/host.mjs`)) {
    return { command: `${dir}/node`, arguments: [`${dir}/host.mjs`], environment: { WEBAIOS_KERNEL_RESOURCES: `${dir}/kernel` } };
  }
  return { command: __WEBAIOS_NODE__, arguments: ["--import", __WEBAIOS_TSX__, __WEBAIOS_HOST__], environment: {} };
}
