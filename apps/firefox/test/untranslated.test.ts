import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// Screens already moved to Fluent messages: no French may remain in them outside t("…") calls.
const TRANSLATED = ["ui/components/Settings.svelte"];

function visibleCode(source: string): string {
  return source
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
    .replace(/\bt\(\s*("[^"]*"|'[^']*'|`[^`]*`)/g, "t("); // the message id is not copy
}

test.each(TRANSLATED)("%s has no French outside t(…)", (file) => {
  const offending = visibleCode(readFileSync(file, "utf8"))
    .split("\n")
    .filter((line) => /[àâçéèêëîïôûùüÿœÀÂÇÉÈÊËÎÏÔÛÙÜŸŒ«»]/.test(line));
  expect(offending).toEqual([]);
});
