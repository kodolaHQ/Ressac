import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// The sidebar is a privileged Firefox page (chrome://browser/content/webaios/sidebar.html): one script and one
// stylesheet with fixed names, and no eval (privileged documents have a strict CSP).
export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: "src/browser/base/content/webaios",
    emptyOutDir: false,
    cssCodeSplit: false,
    lib: { entry: "ui/sidebar.ts", formats: ["iife"], name: "webaiosSidebar", fileName: () => "sidebar.js", cssFileName: "sidebar" },
  },
});
