import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// Screens already moved to Fluent messages: no French may remain in them outside t("…") calls.
const TRANSLATED = [
  "ui/components/Settings.svelte",
  "ui/components/Sidebar.svelte",
  "ui/components/TabList.svelte",
  "ui/components/Pinned.svelte",
  "ui/components/SpaceSelector.svelte",
  "ui/components/SpaceModal.svelte",
  "ui/components/CommandBar.svelte",
  "ui/components/CallBar.svelte",
  "ui/components/UpdateCard.svelte",
  "ui/components/EmptyPage.svelte",
  "ui/components/Downloads.svelte",
  "ui/components/History.svelte",
  "ui/components/AccessBubble.svelte",
  "ui/components/AccountGrantCard.svelte",
  "ui/components/TipCard.svelte",
  "ui/components/FirstTimeNote.svelte",
  "ui/ExtensionsStrip.svelte",
  "ui/components/Welcome.svelte",
  "ui/components/BrowserImport.svelte",
  "ui/components/ReleaseNotes.svelte",
  "ui/components/RequestModal.svelte",
  "ui/components/ExtensionRequest.svelte",
  "ui/components/DevToolsRequest.svelte",
  "ui/components/Extensions.svelte",
  "ui/components/Applications.svelte",
  "ui/components/ExternalProjects.svelte",
  "ui/Home.svelte",
  "ui/HomeWidget.svelte",
  "ui/WidgetFrame.svelte",
];

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
