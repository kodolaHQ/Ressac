import { defineConfig } from "vitest/config";

// Firefox runs headless with a temporary profile; one file at a time.
export default defineConfig({ test: { include: ["e2e/**/*.e2e.ts"], testTimeout: 60_000, hookTimeout: 60_000, fileParallelism: false } });
