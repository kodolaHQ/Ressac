import { z } from "zod";

export const COLUMNS = 12;
export { DATA_MAX_SIZE } from "../workflows/protocol.js";

/** Lowercase host name (« news.ycombinator.com »). */
const domain = z.string().regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/, "nom d'hôte en minuscules attendu");
const side = z.number().int().min(1).max(12);
const size = z.object({ w: side, h: side });

export const WEB_WITH_ACCOUNT = "web : impossible avec un compte (les données d'un compte ne doivent pas pouvoir partir vers un site inconnu)";

/** What an owner (widget or action) reads: domains with its account, public domains, web search. */
export const DeclaredSources = z
  .object({ account: z.array(domain).default([]), public: z.array(domain).default([]), web: z.boolean().default(false) })
  .default({ account: [], public: [], web: false });
export type DeclaredSources = z.infer<typeof DeclaredSources>;

/** Refuses `web` with an `account` (an account's data must not be able to go to an unknown site). */
export function checkSources(s: DeclaredSources, ctx: z.RefinementCtx): void {
  if (s.web && s.account.length > 0) {
    ctx.addIssue({ code: "custom", path: ["sources", "web"], message: WEB_WITH_ACCOUNT });
  }
}

const fixedHour = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "heure HH:MM attendue");

const Harvest = z
  .object({
    minutes: z.number().int().min(5).max(10080).optional(),
    hours: z.array(fixedHour).min(1).max(6).optional(),
    maxDurationMinutes: z.number().int().min(1).max(60).optional(),
    notify: z.boolean().optional(),
  })
  .superRefine((r, ctx) => {
    if (r.minutes === undefined && r.hours === undefined) {
      ctx.addIssue({ code: "custom", message: "minutes ou hours attendu" });
    }
    if (r.hours && new Set(r.hours).size !== r.hours.length) {
      ctx.addIssue({ code: "custom", path: ["hours"], message: "hours en double" });
    }
  });

export const DeclarationWidget = z
  .object({
    name: z.string().min(1).max(60),
    description: z.string().default(""),
    sizes: z.object({ min: size, max: size, default: size }),
    harvest: Harvest.optional(),
    // For a widget with `account`, an empty `public` = no public fetch allowed (list applied by task 5).
    sources: DeclaredSources,
    config: z.unknown().optional(),
  })
  .superRefine((d, ctx) => {
    checkSources(d.sources, ctx);
    const { min, max, default: defaultValue } = d.sizes;
    for (const axe of ["w", "h"] as const) {
      if (!(min[axe] <= defaultValue[axe] && defaultValue[axe] <= max[axe])) {
        ctx.addIssue({ code: "custom", path: ["sizes"], message: `min ≤ default ≤ max exigé (${axe})` });
      }
    }
  });
export type DeclarationWidget = z.infer<typeof DeclarationWidget>;

/** Thousandths of the home width: the 12-column grid loses its precision there. */
export const FREE_WIDTH = 1000;
/** One height unit, in pixels. */
export const ROW_PX = 90;

export const FreePlacement = z
  .object({ id: z.string(), x: z.number().int().min(0).max(FREE_WIDTH), y: z.number().int().min(0), w: z.number().int().min(1).max(FREE_WIDTH), h: z.number().int().min(1) })
  .refine((p) => p.x + p.w <= FREE_WIDTH, "déborde de l'accueil");
export type FreePlacement = z.infer<typeof FreePlacement>;

export const FreeLayout = z.object({ version: z.literal(3), widgets: z.array(FreePlacement) });
export type FreeLayout = z.infer<typeof FreeLayout>;

/** Converts a declared size in units (1…12) to free units. */
export function freeSizes(t: { w: number; h: number }): { w: number; h: number } {
  return { w: Math.round((t.w * FREE_WIDTH) / COLUMNS), h: t.h * ROW_PX };
}

const WidgetStatus = z.enum(["ok", "running", "error", "grant-required", "workshop-stopped"]);

export const WidgetState = z.object({
  status: WidgetStatus,
  lastUpdate: z.string().nullable(),
  lastAttempt: z.string().nullable(),
  error: z.string().optional(),
  /**
   * The error was written by the kernel, with no text from the widget (its failure message, its output…). Absent: it
   * may have been written by the widget, which can put data of the user's account in it.
   */
  kernelError: z.literal(true).optional(),
  /** A kernel-written writer message (no account, limit reached) that failed items of the last run; never widget text. */
  warning: z.string().optional(),
  log: z.string().optional(),
  /** Grant required because the widget's code changed since its reads were approved (shown on the banner). */
  codeChanged: z.literal(true).optional(),
  /** Run in progress: items done out of the total. */
  progress: z.object({ done: z.number().int().min(0), total: z.number().int().min(0) }).optional(),
  /** Tracking of fixed hours: slots « YYYY-MM-DDTHH:MM » (local time). */
  hours: z
    .object({
      done: z.string().nullable(),
      /** `end`: the end of the last failure, from which the 15 min before the retry count. */
      failures: z.object({ hour: z.string(), count: z.number().int().min(0), end: z.string().optional() }).nullable(),
    })
    .optional(),
  /**
   * During a run (status running): the previous state, put back at the next start if Ressac stopped
   * abruptly. Never displayed; absent outside a run.
   */
  before: z.object({ status: WidgetStatus, error: z.string().optional(), kernelError: z.literal(true).optional() }).optional(),
});
export type WidgetState = z.infer<typeof WidgetState>;

export const DEFAULT_WIDGET_STATE: WidgetState = { status: "ok", lastUpdate: null, lastAttempt: null };

export type WidgetRead =
  | {
      id: string;
      folder: string;
      declaration: DeclarationWidget;
      state: WidgetState;
      data: unknown | null;
      example: unknown | null;
      /** The widget has a harvest: `workflow.json` or `harvest.mjs`. */
      hasHarvest: boolean;
      /** `workflow.json` present (it then wins over `harvest.mjs`). */
      hasWorkflow: boolean;
      hasDisplay: boolean;
    }
  | { id: string; folder: string; error: string };

export interface HomeState {
  widgets: WidgetRead[];
}
