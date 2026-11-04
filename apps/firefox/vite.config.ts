import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { hostPath, nodePath, tsxPath } from "./scripts/paths";

const shim = (name: string) => fileURLToPath(new URL(`chrome/shims/${name}.ts`, import.meta.url));
// Electron components that step 2 does not migrate (imported as ./Name.svelte by the reused ones): Unavailable.svelte shows nothing.
const UNMIGRATED = ["Accueil", "IaLocale", "BoutonDesign"];

// Three bundles, one per `--mode` (scripts/ui.sh builds all of them):
// - sidebar: privileged Firefox page (chrome://browser/content/webaios/sidebar.html), one script and one stylesheet
//   with fixed names, no eval (privileged documents have a strict CSP);
// - window: script loaded in every browser window;
// - agent: the agent panel, same kind of page as the sidebar (agent.html, agent.js, agent.css);
// - actor: ES modules for the page and extension JSWindowActors (page-actor.sys.mjs, extension-actor.sys.mjs);
// - store: ES module loaded by resource://, the Node state code bundled with shims for node:fs/crypto/path.
export default defineConfig(({ mode }) => {
  const outDir = "src/browser/base/content/webaios";
  if (mode === "store")
    return {
      define: {
        "process.pid": "0",
        __WEBAIOS_NODE__: JSON.stringify(nodePath),
        __WEBAIOS_TSX__: JSON.stringify(tsxPath),
        __WEBAIOS_HOST__: JSON.stringify(hostPath),
      },
      resolve: {
        alias: {
          "node:crypto": shim("crypto"),
          "node:fs/promises": shim("fs"),
          "node:fs": shim("fs"),
          "node:path": shim("path"),
          electron: shim("electron"),
          "@webaios/noyau": shim("noyau"),
          "node:net": shim("net"),
          "node:dns": shim("empty"),
          "node:http": shim("empty"),
          "node:https": shim("empty"),
        },
      },
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
  if (mode === "actor")
    return {
      build: {
        outDir,
        emptyOutDir: false,
        minify: false,
        lib: {
          entry: { "page-actor": "chrome/agent/page-actor.ts", "extension-actor": "chrome/agent/extension-actor.ts" },
          formats: ["es"],
          fileName: (_format, name) => `${name}.sys.mjs`,
        },
      },
      // The jar copies this file through Mozilla's preprocessor, which refuses a file without any directive (the
      // preprocessor drops the line). Added after writing: the bundler would parse a banner as JavaScript.
      plugins: [
        {
          name: "preprocessor-directive",
          writeBundle(o: { dir?: string }) {
            for (const [name, define] of [["page-actor", "WEBAIOS_PAGE_ACTOR"], ["extension-actor", "WEBAIOS_EXTENSION_ACTOR"]]) {
              const file = `${o.dir}/${name}.sys.mjs`;
              writeFileSync(file, `#define ${define}\n${readFileSync(file, "utf8")}`);
            }
          },
        },
      ],
    };
  if (mode === "window")
    return {
      build: { outDir, emptyOutDir: false, lib: { entry: "chrome/window/index.ts", formats: ["iife"], name: "webaiosWindow", fileName: () => "window.js" } },
    };
  const panel = mode === "agent" ? "agent" : "sidebar";
  return {
    plugins: [svelte()],
    resolve: {
      alias: [{ find: /^\.\/BarreExtensions\.svelte$/, replacement: fileURLToPath(new URL("ui/ExtensionsStrip.svelte", import.meta.url)) }].concat(UNMIGRATED.map((name) => ({ find: new RegExp(`^\\./${name}\\.svelte$`), replacement: fileURLToPath(new URL("ui/Unavailable.svelte", import.meta.url)) }))),
    },
    build: {
      outDir,
      emptyOutDir: false,
      cssCodeSplit: false,
      lib: { entry: `ui/${panel}.ts`, formats: ["iife"], name: `webaios${panel}`, fileName: () => `${panel}.js`, cssFileName: panel },
    },
  };
});
