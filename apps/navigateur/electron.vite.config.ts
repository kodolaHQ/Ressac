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
  // Trois preloads, sans morceau partagé (un preload en bac à sable ne peut charger que lui-même) : celui de
  // l'interface, celui des correctifs des extensions (enregistré sur les sessions des profils) et celui des applis de
  // site (enregistré sur leurs seules sessions `persist:site-<id>`).
  preload: {
    // `electron-chrome-extensions/browser-action` (boutons des extensions) entre dans le preload de l'interface : un preload
    // en bac à sable ne peut rien charger d'autre que lui-même.
    build: {
      externalizeDeps: { exclude: ["electron-chrome-extensions"] },
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/preload/index.ts"),
          extensions: resolve(__dirname, "src/preload/extensions.ts"),
          site: resolve(__dirname, "src/preload/site.ts"),
        },
      },
    },
  },
  // Quatre pages : l'interface d'une fenêtre, la pastille posée sur les fenêtres d'appli, l'interface (barre) d'une
  // fenêtre d'appli de site, et le calque du mode design (bulle d'une remarque, panier d'une fenêtre d'appli).
  renderer: {
    plugins: [svelte()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          pastille: resolve(__dirname, "src/renderer/pastille.html"),
          site: resolve(__dirname, "src/renderer/site.html"),
          design: resolve(__dirname, "src/renderer/design.html"),
        },
      },
    },
  },
});
