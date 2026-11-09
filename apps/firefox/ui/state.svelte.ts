import type { ApiWebaios } from "../shared/api";
import { workflowUrlTarget, type PendingRequest, type WindowState, type BrowserState, type TabId, type Tab, type Download } from "../shared/model";
import { targetKey } from "./builder/target";
import { confirmClose, keepCodesOf } from "./builder/codes.svelte";

// Typed as the shared ApiWebaios: ui/api.ts declares window.webaios as its wider ApiFirefox.
export const api = (window as unknown as { webaios: ApiWebaios }).webaios;

/** Local copy of the state broadcast by the main process; only modified through `api.agir`. */
export const appState = $state<{ value: BrowserState | null }>({ value: null });

api.onState((e) => {
  appState.value = e;
  // The unsaved code of a builder whose tab is gone, by any path, is dropped.
  keepCodesOf(
    Object.values(e.tabs).flatMap((o) => {
      const target = o.windowId === api.windowId ? workflowUrlTarget(o.url) : null;
      return target ? [targetKey(target)] : [];
    }),
  );
});

/** The state of the window showing this interface. */
export function currentWindow(): WindowState | undefined {
  return appState.value?.windows.find((f) => f.id === api.windowId);
}

/**
 * Closing a tab wanted by the user (button, menu, middle click, ⌘W): a widget's builder with unsaved code asks first,
 * unless another tab of the window shows the same builder.
 */
export function closeTab(id: TabId): void {
  const o = appState.value?.tabs[id];
  const target = o ? workflowUrlTarget(o.url) : null;
  if (o && target) {
    const other = Object.values(appState.value!.tabs).some((x) => x.id !== id && x.windowId === o.windowId && x.url === o.url);
    if (!other && !confirmClose(targetKey(target))) return;
  }
  api.dispatch({ type: "closeTab", id });
}

/** The session's downloads, most recent first. */
export const downloads = $state<{ list: Download[] }>({ list: [] });

api.onDownloads((list) => {
  downloads.list = list;
});
void api.downloads.list().then((list) => {
  downloads.list = list;
});

/** Site permission questions, awaiting an answer. */
export const requests = $state<{ list: PendingRequest[] }>({ list: [] });

api.onPermissions((list) => {
  requests.list = list;
});
void api.permissions.waiting().then((list) => {
  requests.list = list;
});

/**
 * The question to ask now in this window, one at a time in order of arrival. A popup asks its questions on the tab
 * that opened it (ongletId); with no known tab, on the active tab. An agent question targets a window (its own),
 * whatever the shown tab.
 */
export function requestOf(win: WindowState | undefined, tab: Tab | undefined): PendingRequest | undefined {
  return requests.list.find((d) => (d.windowId ? d.windowId === win?.id : d.tabId === null || d.tabId === tab?.id));
}

export { access, accessOf } from "./access.svelte";
