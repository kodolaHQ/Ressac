import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// Screens already moved to Fluent messages: no French may remain in them outside t("…") calls.
const TRANSLATED = [
  "ui/components/Settings.svelte",
  "ui/components/SettingsEngine.svelte",
  "ui/components/SettingsData.svelte",
  "ui/components/SettingsPrivacy.svelte",
  "ui/components/SettingsGeneral.svelte",
  "ui/components/SettingsAgent.svelte",
  "ui/components/SettingsLocalAi.svelte",
  "ui/components/SettingsWorkshop.svelte",
  "ui/components/SettingsAbout.svelte",
  "ui/components/SettingsRow.svelte",
  "ui/components/SettingsShortcuts.svelte",
  "ui/components/SettingsMozilla.svelte",
  "ui/components/OllamaModelPicker.svelte",
  "ui/components/AgentPanel.svelte",
  "ui/components/Review.svelte",
  "ui/components/ReviewComment.svelte",
  "ui/components/DiffFile.svelte",
  "ui/components/DesignBasket.svelte",
  "ui/DesignApp.svelte",
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
  "ui/builder/ActionPanel.svelte",
  "ui/builder/ActionPreview.svelte",
  "ui/builder/BlockForm.svelte",
  "ui/builder/BlockNode.svelte",
  "ui/builder/BlockOutput.svelte",
  "ui/builder/BlockTab.svelte",
  "ui/builder/Builder.svelte",
  "ui/builder/Canvas.svelte",
  "ui/builder/CodeEditor.svelte",
  "ui/builder/Palette.svelte",
  "ui/builder/RunList.svelte",
  "ui/builder/RunsBar.svelte",
  "ui/builder/WidgetPanel.svelte",
  "ui/action/ActionHeader.svelte",
  "ui/action/ActionProgress.svelte",
  "ui/action/PageAction.svelte",
  "ui/action/PageRecap.svelte",
  "ui/action/PageRender.svelte",
  "ui/action/blocks/Table.svelte",
  "ui/components/Actions.svelte",
  "ui/site/SiteBar.svelte",
  "ui/site/SiteGrantCard.svelte",
  "ui/site/SiteDesignButton.svelte",
  "ui/SiteHomeFrame.svelte",
  "ui/components/UrlBar.svelte",
  "ui/components/Essentials.svelte",
  "ui/components/TabsPanel.svelte",
  "ui/components/DesignButton.svelte",
  "ui/components/SoundButton.svelte",
  "ui/components/AccessBadge.svelte",
  "ui/BadgeApp.svelte",
  "ui/AgentPill.svelte",
  "ui/PageError.svelte",
  "ui/WidgetPreview.svelte",
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
