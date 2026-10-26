import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  main: {
    // Le noyau est du TypeScript du workspace : il entre dans le bundle. node-pty (natif) reste externe.
    build: { externalizeDeps: { exclude: ["@webaios/noyau"] } },
    // Le bundle CJS n'a pas d'import.meta.dirname utile : modèles et Dockerfile sont lus depuis le paquet
    // du noyau, à ce chemin fixé à la construction (pas de distribution en V1).
    define: { __RESSOURCES_NOYAU__: JSON.stringify(resolve(__dirname, "../../packages/noyau")) },
  },
  preload: {},
  renderer: { plugins: [svelte()] },
});
