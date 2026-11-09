import { BLOCK_REGISTRY } from "./blocks/index.js";
import { streamingChain } from "./chain.js";
import type { Workflow } from "./schema.js";
import type { ValidWorkflow } from "./validate.js";

export const STREAMING_WARNING = "rien à publier au fil de l'eau : l'entrée de la sortie n'est pas traitée élément par élément";

/** A web search quickly takes more than the 150 s of an ordinary run. */
export const WEB_WITHOUT_DURATION_WARNING = "sans maxDurationMinutes, ce widget peut être coupé à 150 s : demande à l'agent de déclarer maxDurationMinutes";

export const INPUT_WARNING = "{input} : l'action ne déclare pas de saisie (input)";

export type Warning = { block: string; message: string };

/** The host of an address, unless the part before the path contains a template (`{…}`) or is not http(s). */
function hostOf(url: string): string | null {
  const m = /^https?:\/\/([^/?#]*)/i.exec(url.trim());
  if (!m || m[1]!.includes("{")) return null;
  try {
    return new URL(url.trim()).hostname.toLowerCase().replace(/\.+$/, "") || null;
  } catch {
    return null;
  }
}

/**
 * What does not block saving but risks making the run fail: a domain absent from the declared
 * sources (only for a widget with an account), a `{config.…}` key absent from the widget's config and, with
 * `valide` (the same validated workflow), an "as-it-goes" output without a chain: it would have nothing to publish. With
 * `dureeMaxMinutes: null` (the widget declares none), each `web.search`: the run risks being cut off.
 */
export function warnWorkflow(
  workflow: Workflow,
  ctx: { sources: { account: readonly string[]; public: readonly string[] }; config: unknown;
    maxDurationMinutes?: number | null;
    /** An action without `input` receives nothing in `{input}`. */
    owner?: "widget" | "action";
    input?: boolean;
  },
  valid?: ValidWorkflow,
): Warning[] {
  const r: Warning[] = [];
  const hasAccount = ctx.sources.account.length > 0;
  const config = ctx.config !== null && typeof ctx.config === "object" ? (ctx.config as Record<string, unknown>) : {};
  for (const b of workflow.blocks) {
    if (hasAccount) {
      let urls: string[] = [];
      let allowed: readonly string[] = ctx.sources.public;
      const p = b.params;
      if (b.type === "source.page" && typeof p.url === "string") {
        urls = [p.url];
        if (p.account === true) allowed = ctx.sources.account;
      } else if (b.type === "source.fetch" && typeof p.url === "string") urls = [p.url];
      else if (b.type === "source.feed" && Array.isArray(p.urls)) urls = p.urls.filter((u): u is string => typeof u === "string");
      for (const u of urls) {
        const host = hostOf(u);
        if (host && !allowed.includes(host)) r.push({ block: b.id, message: `domaine non déclaré : ${host}` });
      }
    }
    const champs = BLOCK_REGISTRY.get(b.type)?.fields.filter((c) => c.kind === "template") ?? [];
    const missing = new Set<string>();
    for (const c of champs) {
      const v = b.params[c.name];
      if (typeof v !== "string") continue;
      // An optional marker (`{config.x?}`) does not need the value: it is never reported.
      for (const m of v.matchAll(/\{config\.([A-Za-z0-9_]+)[^}]*\}/g)) {
        if (!m[0].endsWith("?}") && !Object.hasOwn(config, m[1]!)) missing.add(m[1]!);
      }
    }
    if (ctx.owner === "action" && ctx.input !== true) {
      const hasInput = champs.some((c) => {
        const v = b.params[c.name];
        return typeof v === "string" && /\{input\??\}/.test(v);
      });
      if (hasInput) r.push({ block: b.id, message: INPUT_WARNING });
    }
    for (const key of missing) r.push({ block: b.id, message: `config.${key} absent de la configuration du widget` });
    if (b.type === "web.search" && ctx.maxDurationMinutes === null) r.push({ block: b.id, message: WEB_WITHOUT_DURATION_WARNING });
  }
  if (valid) {
    const output = valid.workflow.blocks.find((b) => b.id === valid.output.id);
    if (output?.params.live === true && streamingChain(valid).length === 0) {
      r.push({ block: valid.output.id, message: STREAMING_WARNING });
    }
  }
  return r;
}
