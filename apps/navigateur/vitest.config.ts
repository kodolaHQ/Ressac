import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

// Le plugin Svelte compile les runes des modules `.svelte.ts` (état du constructeur) pour les tests.
// electron-chrome-web-store passe par vite (pas par Node) pour que les tests puissent leurrer son import d'`electron`.
export default defineConfig({
  plugins: [svelte()],
  test: { include: ["test/**/*.test.ts"], server: { deps: { inline: ["electron-chrome-web-store"] } } },
});
