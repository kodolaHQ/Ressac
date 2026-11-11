import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

// The Svelte plugin compiles the runes of the `.svelte.ts` modules (builder state) for the tests.
export default defineConfig({
  plugins: [svelte()],
  // theme.css is read raw by chrome/store/action-media.ts: Vitest empties CSS it does not include.
  test: { include: ["test/**/*.test.ts"], css: { include: [/theme\.css/] } },
});
