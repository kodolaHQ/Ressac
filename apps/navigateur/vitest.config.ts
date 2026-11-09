import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

// Le plugin Svelte compile les runes des modules `.svelte.ts` (état du constructeur) pour les tests.
export default defineConfig({
  plugins: [svelte()],
  test: { include: ["test/**/*.test.ts"] },
});
