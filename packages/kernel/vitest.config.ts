import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts", ...(process.env.RESSAC_BENCH ? ["test/**/*.bench.ts"] : [])], testTimeout: 15000 },
});
