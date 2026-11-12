import { defineConfig } from "vitest/config";

// Firefox runs headless with its own temporary profile, data dir and ports: files run in parallel.
// expect.poll waits 1 s by default: too short for a smooth scroll or a reload when several browsers share the machine.
export default defineConfig({ test: { include: ["e2e/**/*.e2e.ts"], testTimeout: 60_000, hookTimeout: 60_000, maxWorkers: 6, expect: { poll: { timeout: 10_000 } } } });
