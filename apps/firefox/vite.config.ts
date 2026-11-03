import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

const shim = (name: string) => fileURLToPath(new URL(`chrome/shims/${name}.ts`, import.meta.url));
// Electron components that step 2 does not migrate (imported as ./Name.svelte by the reused ones): Unavailable.svelte shows nothing.
const UNMIGRATED = ["Accueil", "IaLocale", "BarreExtensions", "BoutonDesign", "PastilleAcces"];

// Three bundles, one per `--mode` (scripts/ui.sh builds all of them):
// - sidebar: privileged Firefox page (chrome://browser/content/webaios/sidebar.html), one script and one stylesheet
//   with fixed names, no eval (privileged documents have a strict CSP);
// - window: script loaded in every browser window;
// - store: ES module loaded by resource://, the Node state code bundled with shims for node:fs/crypto/path.
export default defineConfig(({ mode }) => {
  const outDir = "src/browser/base/content/webaios";
  if (mode === "store")
    return {
      define: { "process.pid": "0" },
      resolve: { alias: { "node:crypto": shim("crypto"), "node:fs/promises": shim("fs"), "node:path": shim("path") } },
      build: {
        outDir,
        emptyOutDir: false,
        minify: false,
        lib: { entry: "chrome/store/index.ts", formats: ["es"], fileName: () => "store.sys.mjs" },
        rollupOptions: {
          external: [/^resource:\/\//, /^chrome:\/\//],
          output: { banner: 'import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";' },
        },
      },
    };
  if (mode === "window")
    return {
      build: { outDir, emptyOutDir: false, lib: { entry: "chrome/window/index.ts", formats: ["iife"], name: "webaiosWindow", fileName: () => "window.js" } },
    };
  return {
    plugins: [svelte()],
    resolve: {
      alias: UNMIGRATED.map((name) => ({ find: new RegExp(`^\\./${name}\\.svelte$`), replacement: fileURLToPath(new URL("ui/Unavailable.svelte", import.meta.url)) })),
    },
    build: {
      outDir,
      emptyOutDir: false,
      cssCodeSplit: false,
      lib: { entry: "ui/sidebar.ts", formats: ["iife"], name: "webaiosSidebar", fileName: () => "sidebar.js", cssFileName: "sidebar" },
    },
  };
});
