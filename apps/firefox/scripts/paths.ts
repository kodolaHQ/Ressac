import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Absolute paths frozen into store.sys.mjs at build time (Vite `define`); the agent host runs with them.
const kernel = fileURLToPath(new URL("../../../packages/kernel/package.json", import.meta.url));

export const nodePath = process.execPath;
export const tsxPath = createRequire(kernel).resolve("tsx/esm");
export const hostPath = fileURLToPath(new URL("../host/host.ts", import.meta.url));
// The llama-server scripts/ui.sh fetches for dev builds (scripts/llama-server.sh holds the pinned version).
const llamaVersion = /^llama_version=(\S+)$/m.exec(readFileSync(new URL("./llama-server.sh", import.meta.url), "utf8"))![1];
export const llamaPath = fileURLToPath(new URL(`../dist/cache/llama-${llamaVersion}/llama-server`, import.meta.url));
