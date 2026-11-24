import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

// The Svelte plugin compiles the runes of the `.svelte.ts` modules (builder state) for the tests.
export default defineConfig({
  plugins: [svelte()],
  // theme.css is read raw by chrome/store/action-media.ts: Vitest empties CSS it does not include.
  // 15 s as the kernel's: a repo scan or a host start takes 0.7 s here and over 5 s on CI's 3-core runner.
  test: { include: ["test/**/*.test.ts"], testTimeout: 15000, css: { include: [/theme\.css/] } },
});
