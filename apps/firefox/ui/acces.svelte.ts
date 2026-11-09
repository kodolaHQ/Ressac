import type { TabAccessState } from "@webaios/noyau";
import type { ApiPastille } from "../shared/api";
import type { AccessState } from "../shared/modele";

/**
 * The only part of the API shared by a window's interface and an app window's badge (whose preload exposes nothing
 * else): this module must read nothing else on `window.webaios`.
 */
export const accessApi: Pick<ApiPastille, "acces" | "surAcces"> = window.webaios;

/** The agent's access to tabs (tab id → what it can read or do), and the name of the agent holding them. */
export const access = $state<{ liste: Record<string, TabAccessState>; agent: string; bullesOuvertes: number }>({ liste: {}, agent: "L'agent", bullesOuvertes: 0 });

let diffuse = false; // a broadcast is newer than the initial reply: the reply is ignored
const applyAccess = (e: AccessState) => {
  access.liste = e.onglets;
  access.agent = e.agent;
};
accessApi.surAcces((e) => {
  diffuse = true;
  applyAccess(e);
});
void accessApi.acces.etat().then((e) => {
  if (!diffuse) applyAccess(e);
});

/** The agent's access to this tab, if it reads the page or holds a right (a running tool alone shows nothing). */
export function accessOf(id: string): TabAccessState | undefined {
  const e = access.liste[id];
  return e && (e.lecture || e.droits.length) ? e : undefined;
}
