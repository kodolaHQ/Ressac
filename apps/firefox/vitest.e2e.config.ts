import { defineConfig } from "vitest/config";

// Firefox runs headless with its own temporary profile, data dir and ports: files run in parallel.
export default defineConfig({ test: { include: ["e2e/**/*.e2e.ts"], testTimeout: 60_000, hookTimeout: 60_000, maxWorkers: 6 } });
