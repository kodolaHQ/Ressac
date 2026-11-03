import type { Action } from "../../navigateur/src/commun/api";
import type { EtatNavigateur } from "../../navigateur/src/commun/modele";
import type { Marionette } from "./marionette";

const STORE = "chrome://browser/content/webaios/store.sys.mjs";

/** The current state (chrome context). */
export async function state(m: Marionette): Promise<EtatNavigateur> {
  return m.execute(`return (async () => (await ChromeUtils.importESModule("${STORE}").ready).state)();`);
}

/** Dispatches an action through the store and returns the new state. */
export async function dispatch(m: Marionette, action: Action): Promise<EtatNavigateur> {
  return m.execute(`return (async () => (await ChromeUtils.importESModule("${STORE}").ready).dispatch(arguments[0]))();`, [action]);
}

/** Runs `script` (chrome context, may return a promise) until `predicate` accepts its result; rejects after `ms`. */
export async function waitFor<T>(m: Marionette, script: string, predicate: (v: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await m.execute<T>(script);
    if (predicate(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting on ${script}: last ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
