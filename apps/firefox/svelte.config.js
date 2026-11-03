import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

// fragments "tree": templates are built with createElement, not innerHTML. Privileged Firefox documents sanitize
// innerHTML, which strips <button>, <input> and <form>.
export default { preprocess: vitePreprocess(), compilerOptions: { fragments: "tree" } };
