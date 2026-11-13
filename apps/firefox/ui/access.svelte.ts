import type { TabAccessState } from "@ressac/kernel";
import type { BadgeApi } from "../shared/api";
import type { AccessState } from "../shared/model";

/**
 * The only part of the API shared by a window's interface and an app window's badge (whose preload exposes nothing
 * else): this module must read nothing else on `window.ressac`.
 */
export const accessApi: Pick<BadgeApi, "access" | "onAccess"> = window.ressac;

/** The agent's access to tabs (tab id → what it can read or do), and the name of the agent holding them. */
export const access = $state<{ list: Record<string, TabAccessState>; agent: string; openBubbles: number }>({ list: {}, agent: "L'agent", openBubbles: 0 });

let diffuse = false; // a broadcast is newer than the initial reply: the reply is ignored
const applyAccess = (e: AccessState) => {
  access.list = e.tabs;
  access.agent = e.agent;
};
accessApi.onAccess((e) => {
  diffuse = true;
  applyAccess(e);
});
void accessApi.access.state().then((e) => {
  if (!diffuse) applyAccess(e);
});

/** The agent's access to this tab, if it reads the page or holds a right (a running tool alone shows nothing). */
export function accessOf(id: string): TabAccessState | undefined {
  const e = access.list[id];
  return e && (e.read || e.rights.length) ? e : undefined;
}
