// Zod compiles its object parsers with `new Function` unless `jitless` is set. Firefox forbids eval in the parent process
// and reports even Zod's caught probe as an error (Sentry, 0.1.6). Zod reads this config when it loads and when each
// schema is built: it must run first, hence its own module, imported before Zod by shims/zod.ts.
const g = globalThis as { __zod_globalConfig?: Record<string, unknown> };
g.__zod_globalConfig = { ...g.__zod_globalConfig, jitless: true };
