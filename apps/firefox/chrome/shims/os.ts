// Stand-in for node:os: the kernel's own-network check runs in Node only, never in the chrome bundles.
export function networkInterfaces(): never {
  throw new Error("networkInterfaces is Node-only");
}
