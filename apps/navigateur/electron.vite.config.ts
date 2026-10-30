import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  main: {
    // Le noyau est du TypeScript du workspace : il entre dans le bundle. node-pty (natif) reste externe.
    // La garde des exceptions a son propre fichier : `index.js` la charge par un `require` placé avant ceux des
    // dépendances externes (dans un seul fichier, le bundler remonterait ces derniers au-dessus d'elle).
    build: {
      externalizeDeps: { exclude: ["@webaios/noyau"] },
      rollupOptions: { output: { advancedChunks: { groups: [{ name: "garde-exceptions", test: /garde-exceptions/ }] } } },
    },
    // Le bundle CJS n'a pas d'import.meta.dirname utile : modèles et Dockerfile sont lus depuis le paquet
    // du noyau, à ce chemin fixé à la construction (pas de distribution en V1).
    define: { __RESSOURCES_NOYAU__: JSON.stringify(resolve(__dirname, "../../packages/noyau")) },
  },
  // Deux preloads, sans morceau partagé (un preload en bac à sable ne peut charger que lui-même) : celui de
  // l'interface, et celui des correctifs des extensions (enregistré sur les sessions des profils).
  preload: {
    // `electron-chrome-extensions/browser-action` (boutons des extensions) entre dans le preload de l'interface : un preload
    // en bac à sable ne peut rien charger d'autre que lui-même.
    build: {
      externalizeDeps: { exclude: ["electron-chrome-extensions"] },
      rollupOptions: { input: { index: resolve(__dirname, "src/preload/index.ts"), extensions: resolve(__dirname, "src/preload/extensions.ts") } },
    },
  },
  // Deux pages : l'interface d'une fenêtre, et la pastille d'accès posée sur les fenêtres d'appli.
  renderer: {
    plugins: [svelte()],
    build: { rollupOptions: { input: { index: resolve(__dirname, "src/renderer/index.html"), pastille: resolve(__dirname, "src/renderer/pastille.html") } } },
  },
});
