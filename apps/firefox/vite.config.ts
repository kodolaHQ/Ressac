import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { hostPath, llamaPath, nodePath, tsxPath } from "./scripts/paths";

const shim = (name: string) => fileURLToPath(new URL(`chrome/shims/${name}.ts`, import.meta.url));
// Privileged bundles never let Zod try eval (chrome/shims/zod-jitless.ts). Exact match: the shim's own `zod/v4` is Zod.
const zodJitless = { find: /^zod$/, replacement: shim("zod") };
// Mounted only in a site app's bar: their styles are injected there, never bundled into the main UI's stylesheet.
const INJECTED_CSS = ["ui/site/SiteWindow.svelte", "ui/SiteAddonsStrip.svelte"];
// A rename must not silently leak these styles into the main UI.
for (const f of INJECTED_CSS) if (!existsSync(new URL(f, import.meta.url))) throw new Error(`INJECTED_CSS: ${f} is missing`);

// Three bundles, one per `--mode` (scripts/ui.sh builds all of them):
// - sidebar: privileged Firefox page (chrome://browser/content/ressac/sidebar.html), one script and one stylesheet
//   with fixed names, no eval (privileged documents have a strict CSP);
// - window: script loaded in every browser window;
// - agent: the agent panel, same kind of page as the sidebar (agent.html, agent.js, agent.css);
// - actor: ES modules for the page, extension, site, design and vim JSWindowActors (page-actor.sys.mjs, extension-actor.sys.mjs, site-actor.sys.mjs, design-actor.sys.mjs, vim-actor.sys.mjs, call-actor.sys.mjs);
// - host: the agent host as one Node ES module (dist-host/host.mjs), everything bundled but node-pty;
// - store: ES module loaded by resource://, the Node state code bundled with shims for node:fs/crypto/path.
//   RESSAC_PACKAGE=1 blanks the dev host paths (this Mac's absolute paths) so a shipped app leaks none.
export default defineConfig(({ mode }) => {
  const outDir = "src/browser/base/content/ressac";
  const packaged = process.env.RESSAC_PACKAGE === "1";
  if (mode === "store")
    return {
      define: {
        __RESSAC_PACKAGED__: JSON.stringify(packaged),
        "process.pid": "0",
        __RESSAC_NODE__: JSON.stringify(packaged ? "" : nodePath),
        __RESSAC_TSX__: JSON.stringify(packaged ? "" : tsxPath),
        __RESSAC_HOST__: JSON.stringify(packaged ? "" : hostPath),
        __RESSAC_LLAMA__: JSON.stringify(packaged ? "" : llamaPath),
        // Where error reports go (chrome/store/telemetry.ts): only a packaged build bakes it in, a dev build sends nothing.
        __RESSAC_SENTRY_DSN__: JSON.stringify(packaged ? (process.env.RESSAC_SENTRY_DSN ?? "") : ""),
        // The Ressac version (package.json), outside the compiled engine: bumping it costs a build:ui, not a Gecko rebuild.
        __RESSAC_VERSION__: JSON.stringify(JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version),
      },
      resolve: {
        alias: [zodJitless, ...Object.entries({
          "node:crypto": shim("crypto"),
          "node:fs/promises": shim("fs"),
          "node:fs": shim("fs"),
          "node:path": shim("path"),
          "@ressac/kernel": shim("kernel"),
          "node:net": shim("net"),
          "node:url": shim("url"),
          "node:dns": shim("empty"),
          "node:http": shim("empty"),
          "node:https": shim("empty"),
        }).map(([find, replacement]) => ({ find, replacement }))],
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
  if (mode === "host")
    return {
      define: { __RESSAC_PACKAGED__: JSON.stringify(packaged) },
      build: {
        ssr: "host/host.ts",
        outDir: "dist-host",
        emptyOutDir: true,
        minify: false,
        target: "node22",
        rollupOptions: { external: ["node-pty"], output: { format: "es", entryFileNames: "host.mjs", inlineDynamicImports: true } },
      },
      ssr: { noExternal: true, external: ["node-pty"] },
    };
  if (mode === "actor")
    return {
      define: { __RESSAC_PACKAGED__: JSON.stringify(packaged) },
      resolve: { alias: [zodJitless] },
      build: {
        outDir,
        emptyOutDir: false,
        minify: false,
        lib: {
          entry: { "page-actor": "chrome/agent/page-actor.ts", "extension-actor": "chrome/agent/extension-actor.ts", "site-actor": "chrome/agent/site-actor.ts", "design-actor": "chrome/agent/design-actor.ts", "vim-actor": "chrome/agent/vim-actor.ts", "call-actor": "chrome/agent/call-actor.ts" },
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
            for (const [name, define] of [["page-actor", "RESSAC_PAGE_ACTOR"], ["extension-actor", "RESSAC_EXTENSION_ACTOR"], ["site-actor", "RESSAC_SITE_ACTOR"], ["design-actor", "RESSAC_DESIGN_ACTOR"], ["vim-actor", "RESSAC_VIM_ACTOR"], ["call-actor", "RESSAC_CALL_ACTOR"]]) {
              const file = `${o.dir}/${name}.sys.mjs`;
              writeFileSync(file, `#define ${define}\n${readFileSync(file, "utf8")}`);
            }
          },
        },
      ],
    };
  if (mode === "window")
    return {
      define: { __RESSAC_PACKAGED__: JSON.stringify(packaged) },
      resolve: { alias: [zodJitless] },
      build: { outDir, emptyOutDir: false, lib: { entry: "chrome/window/index.ts", formats: ["iife"], name: "ressacWindow", fileName: () => "window.js" } },
    };
  const panel = mode === "agent" ? "agent" : "sidebar";
  return {
    // SiteWindow's :global(html, body) rules (opaque background, font) would reach the main UI through the shared
    // stylesheet: injected, they only land in the site bar's document, when it mounts.
    plugins: [svelte({ dynamicCompileOptions: ({ filename }) => (INJECTED_CSS.some((f) => filename.endsWith("/" + f)) ? { css: "injected" } : undefined) })],
    // Library mode leaves process.env.NODE_ENV in place (@xyflow/svelte reads it); a privileged page has no process.
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    resolve: { alias: [zodJitless] },
    build: {
      outDir,
      emptyOutDir: false,
      cssCodeSplit: false,
      lib: { entry: `ui/${panel}.ts`, formats: ["iife"], name: `ressac${panel}`, fileName: () => `${panel}.js`, cssFileName: panel },
    },
  };
});
