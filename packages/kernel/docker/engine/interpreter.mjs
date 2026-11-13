// Workflow interpreter: runs in the `workshop` container, called by harvester.mjs.
//
// Contract of a block module (`blocks/<type>.mjs`):
//   export default {
//     perItem: "no" | "option" | "always",
//     async run(ctx),                  // simple mode: returns { output, memory? }
//     async processItem(ctx),          // per item: returns the value stored under `field` in ctx.item
//     async finalize(list, ctx),       // optional, per item: returns { output } from the enriched list
//     failIfAllFail: true,             // optional, per item: the block fails if no item that was run succeeded
//   }
// ctx = { input, params, config, memory, now, ressac, log, folder, fill, partial, item?, userInput? }
//   - `userInput` (action run with a text only): that text; also `ressac.input` for the agent's code, and
//     `{input}` in the templates.
//   - `now`: the ISO time of `start`, the date of what the block keeps this time.
//   - `memory`: what the block kept last time (null otherwise); `run` returns the new one in `memory`.
//     Per item, the block's memory is that of `reuse`, held by the interpreter.
//   - `log(text)`: a line attached to the block. `ressac.log(...)` also goes to stderr.
//   - `fill(template, { url, maxText })` fills in with the current item (in simple mode: the input) and the config;
//     an absent value throws MissingValue: in simple mode the output is null, per item the item stays without a
//     field; in both cases, a log line and no error.
//   - per item, an ItemNotRun (errors.mjs) leaves the item without a field and the block "partial", never
//     counting as a failure; in simple mode, it is an ordinary error. After the first one, no item is
//     run any more (except those `reuse` takes back): one log line for the first, one for all the following.
//   - `partial(reason?)`: in simple mode, the block will end "partial" (for example one feed out of several failing).
// The per-item loop (two at a time, time budget, `onError`, `reuse`) is the interpreter's.
// In the as-it-goes chain, `ctx.input` is the chain's input (not the output of the previous block): a chainable
// module does not read it in `processItem`.
import { ItemNotRun } from "./errors.mjs";
import { MissingValue, readPath, fill } from "./templates.mjs";
import { createRessac, format } from "./ressac.mjs";
import code from "./blocks/code.mjs";
import aiWrite from "./blocks/ai-write.mjs";
import aiSort from "./blocks/ai-sort.mjs";
import listDedupe from "./blocks/list-dedupe.mjs";
import listKeep from "./blocks/list-keep.mjs";
import listNew, { KEYS_MAX, DAY_MS, asKey } from "./blocks/list-new.mjs";
import output from "./blocks/output.mjs";
import sourceFeed from "./blocks/source-feed.mjs";
import sourcePage from "./blocks/source-page.mjs";
import sourceFetch from "./blocks/source-fetch.mjs";
import webSearch from "./blocks/web-search.mjs";

/** The blocks shipped with the engine, by type. No way to load others from the container. */
export const SHIPPED_BLOCKS = Object.freeze({
  "source.page": sourcePage,
  "source.feed": sourceFeed,
  "source.fetch": sourceFetch,
  "web.search": webSearch,
  "list.new": listNew,
  "list.dedupe": listDedupe,
  "list.keep": listKeep,
  "ai.sort": aiSort,
  "ai.write": aiWrite,
  code,
  output,
});

/** After this time since `start`, no item is run any more (the container is stopped at 180 s). */
export const GLOBAL_LIMIT_MS = 150_000;
/** Progressive run: the memory is sent to the kernel at most once per this interval (copied from src/workflows/run.ts). */
export const MEMORY_GAP_MS = 30_000;
/** As it goes: at most one `publication` line per this interval (copied from src/workflows/run.ts). */
export const PUBLICATIONS_GAP_MS = 5000;
/** Action: at most one `progress` line per block per this interval, the last one always (copied from src/workflows/run.ts). */
export const PROGRESS_GAP_MS = 1000;
/**
 * As it goes: a larger publication (in JSON) is not sent, the kernel would ignore it (copied from
 * DATA_MAX_SIZE, src/workflows/protocol.ts).
 */
export const DATA_MAX_SIZE = 2 * 1024 * 1024;

/**
 * After this time, no item is run any more: `limitMs` of the `start` line (the widget's declared duration),
 * GLOBAL_LIMIT_MS without it, counted from the reception of `start`.
 */
export function deadlineOf(start, receivedAt) {
  const limit = start?.limitMs;
  return receivedAt + (typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : GLOBAL_LIMIT_MS);
}
const ITEMS_IN_PARALLEL = 2;
/** Values kept by `reuse`, per block (the oldest forgotten beyond). */
export const REUSED_MAX_BYTES = 2 * 1024 * 1024;
/**
 * All the memory sent to the kernel, under the cap of its file (MEMORY_MAX_BYTES, 3 MB, in
 * src/workflows/memory.ts: beyond it, the kernel refuses it and keeps the old one) and of a line (4 MB).
 */
export const SENT_MEMORY_MAX_BYTES = 2.5 * 1024 * 1024;
const LINE_MAX = 4 * 1024 * 1024;
const TRACE_TEXT_MAX = 2000;

const message = (e) => String(e?.message ?? e);
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** `reuse` key of an item; null if absent. */
function reusedKey(item, path) {
  const v = readPath(item, path);
  if (v === undefined || v === null || v === "") return null;
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

const size = (v) => Buffer.byteLength(JSON.stringify(v));

/**
 * Values kept by `reuse` (`[key, value, isoDate]`), from oldest to most recent, bounded to
 * REUSED_MAX_BYTES.
 */
function bound(reused) {
  const entries = [...reused].map(([key, { value, date }]) => [key, value, date]);
  const sizes = entries.map((e) => size(e) + 1);
  let total = sizes.reduce((a, b) => a + b, 0);
  let first = 0;
  while (total > REUSED_MAX_BYTES && first < entries.length) total -= sizes[first++];
  return entries.slice(first);
}

/**
 * Bounds all the memory to SENT_MEMORY_MAX_BYTES: forgets the oldest `reuse` values, always starting
 * with the block that keeps the most, then, if still needed, the oldest keys of `list.new`.
 */
function boundMemory(memory) {
  let total = size(memory);
  const lists = (keep) =>
    Object.values(memory)
      .map((m) => keep(m))
      .filter(Boolean)
      .map((list) => {
        const sizes = list.map((e) => size(e) + 1);
        return { list, sizes, total: sizes.reduce((a, b) => a + b, 0) };
      });
  const phases = [
    (m) => (Array.isArray(m.value?.reused) ? m.value.reused : null),
    (m) => (m.type === "list.new" && Array.isArray(m.value) ? m.value : null),
  ];
  for (const keep of phases) {
    const blocks = lists(keep);
    while (total > SENT_MEMORY_MAX_BYTES) {
      const biggest = blocks.filter((b) => b.list.length > 0).reduce((a, b) => (!a || b.total > a.total ? b : a), null);
      if (!biggest) break;
      const t = biggest.sizes.shift();
      biggest.list.shift();
      biggest.total -= t;
      total -= t;
    }
  }
  return memory;
}

/**
 * `reuse` values read from the memory: key → { value, date }. An old `[key, value]` pair (no date) is
 * dated `now`; with `keepDays`, a value computed longer ago is forgotten (it will be recomputed).
 */
function readReused(memory, now, keepDays) {
  const entries = Array.isArray(memory?.reused) ? memory.reused : [];
  const limit = keepDays === undefined ? -Infinity : Date.parse(now) - keepDays * DAY_MS;
  const reused = new Map();
  for (const e of entries) {
    if (!Array.isArray(e) || (e.length !== 2 && e.length !== 3) || typeof e[0] !== "string") continue;
    const date = typeof e[2] === "string" && !Number.isNaN(Date.parse(e[2])) ? e[2] : now;
    if (Date.parse(date) < limit) continue;
    reused.set(e[0], { value: e[1], date });
  }
  return reused;
}

/**
 * One block per item, item by item: its rules (`reuse`, absent value, ItemNotRun, `onError`) and
 * its counts. Used by the loop of a single block (`perItem`) and by the as-it-goes chain (`runChain`).
 *   - `pass(i, item)`: the item after the block (without `field` if it has no value this time); an error with
 *     `onError: "fail"` is stored in `blockError`, never thrown;
 *   - `notRun(i, item)`: the item passes the block without being run in it (time, budget);
 *   - `finish()`: the final log lines and the status.
 */
function createStep(module, ctx, exposeMemory) {
  const { params, log } = ctx;
  const { field, reuse } = params;
  const onError = params.onError ?? "skip";
  const reused = reuse ? readReused(ctx.memory, ctx.now, params.keepDays) : null;
  // Progressive run: what the block has already learned is part of the memory sent along the way.
  if (reused && exposeMemory) exposeMemory(() => ({ reused: bound(reused) }));
  // A reused value keeps the date of its computation (its reliability is reviewed after keepDays) but becomes the most
  // recent for the size caps.
  const store = (key, entry) => {
    reused.delete(key);
    reused.set(key, entry);
  };
  // Computations in progress by `reuse` key: an item with the same key waits for that one rather than launching a second.
  const running = new Map();

  const step = {
    failures: 0,
    succeeded: 0,
    refused: 0,
    notRunCount: 0,
    // First refusal from the kernel (cap, searches stopped): it holds for the whole run, nothing is run any more.
    kernelRefusal: null,
    firstError: null,
    blockError: null,
    // Indexes of the items that failed, were refused by the kernel or were not run.
    failed: new Set(),
    reused,
    // An item without a value this time (failure, not run, absent value) leaves without `field`, even if it had one:
    // an old value never passes for this block's (ai.sort does not sort on an old score).
    withoutField(item) {
      if (!isObject(item) || !Object.hasOwn(item, field)) return item;
      const { [field]: _old, ...rest } = item;
      return rest;
    },
    async pass(i, item) {
      try {
        return await processOne(item);
      } catch (e) {
        if (e instanceof MissingValue) {
          log(`élément ${i + 1} : ${e.message}`);
          return step.withoutField(item);
        }
        if (e instanceof ItemNotRun) {
          // Refused by the kernel (search cap…): not run, never a failure. One line for the first, the
          // following ones are counted together at the end.
          step.refused++;
          step.failed.add(i);
          if (step.kernelRefusal === null) {
            step.kernelRefusal = e.message;
            log(`élément ${i + 1} : ${e.message}`);
          }
          return step.withoutField(item);
        }
        step.failures++;
        step.failed.add(i);
        step.firstError ??= e;
        log(`élément ${i + 1} : ${message(e)}`);
        if (onError === "fail") step.blockError ??= e;
        return step.withoutField(item);
      }
    },
    notRun(i, item) {
      step.notRunCount++;
      step.failed.add(i);
      return step.withoutField(item);
    },
    finish() {
      if (step.refused > 1) log(`${step.refused - 1} autre(s) élément(s) non lancé(s)`);
      if (step.notRunCount > 0) log(`temps écoulé : ${step.notRunCount} élément(s) non lancé(s)`);
      return step.failures > 0 || step.notRunCount > 0 || step.refused > 0 ? "partial" : "succeeded";
    },
  };

  async function processOne(item) {
    if (!isObject(item)) throw new Error("l'élément n'est pas un objet");
    const key = reused ? reusedKey(item, reuse) : null;
    if (key !== null && reused.has(key)) {
      const taken = reused.get(key);
      store(key, taken);
      step.succeeded++;
      return { ...item, [field]: taken.value };
    }
    if (key !== null && running.has(key)) {
      // The same computation is in progress for another item: its value, or, if it fails, a computation of its own.
      try {
        const value = await running.get(key);
        step.succeeded++;
        return { ...item, [field]: value };
      } catch (e) {
        // Refused by the kernel: this one would be too, no point asking again.
        if (e instanceof ItemNotRun) throw e;
        // Its error is counted on its side; this one tries in its turn.
      }
    }
    if (step.kernelRefusal !== null) throw new ItemNotRun(step.kernelRefusal);
    const computation = (async () => {
      const value = await module.processItem({
        ...ctx,
        item,
        fill: (template, options) => fillOrThrow(template, item, ctx, options),
      });
      if (value === undefined) throw new Error("aucune valeur rendue");
      return value;
    })();
    if (key !== null) running.set(key, computation);
    let value;
    try {
      value = await computation;
    } finally {
      if (key !== null && running.get(key) === computation) running.delete(key);
    }
    step.succeeded++;
    if (key !== null) store(key, { value, date: ctx.now });
    return { ...item, [field]: value };
  }

  return step;
}

/** Deadline of a per-item block: the global deadline, advanced by `budgetSeconds` counted from `since`. */
const limitOf = (params, deadline, since) =>
  Math.min(deadline, params.budgetSeconds ? since + params.budgetSeconds * 1000 : Infinity);

/**
 * The progress of a per-item block (action): `send(done, total)` after an item at most every
 * PROGRESS_GAP_MS, and always for the last one (`done = total`); `finish()` sends the final count if it has not
 * gone yet (items not run, block stopped by an error).
 */
function createProgress(total, clock, send) {
  let done = 0;
  let sent = 0;
  let last = null;
  const emit = () => {
    last = clock();
    sent = done;
    send(done, total);
  };
  return {
    item() {
      done++;
      if (done === total || last === null || clock() - last >= PROGRESS_GAP_MS) emit();
    },
    finish() {
      if (done !== sent) emit();
    },
  };
}

/** Per-item loop: returns { status, output, memory?, failed } or throws the block's error. */
async function perItem(module, ctx, { deadline, clock, afterItem, exposeMemory, onProgress }) {
  const { input } = ctx;
  if (!Array.isArray(input)) throw new Error("liste attendue en entrée");
  const limit = limitOf(ctx.params, deadline, clock());
  const step = createStep(module, ctx, exposeMemory);
  const result = input.map(step.withoutField);
  const progress = onProgress ? createProgress(input.length, clock, onProgress) : null;
  let next = 0;

  async function worker() {
    while (!step.blockError && next < input.length && clock() < limit) {
      const i = next++;
      try {
        result[i] = await step.pass(i, input[i]);
      } finally {
        progress?.item();
        afterItem?.();
      }
    }
  }
  await Promise.all(Array.from({ length: ITEMS_IN_PARALLEL }, worker));
  progress?.finish();

  if (step.blockError) throw step.blockError;
  // For a block that asks for it (ai.sort: with no score at all, its empty output means nothing), among the items
  // run, none succeeded and at least one failed: the block failed. Items not run (time, refused by the
  // kernel) or without a template value do not count as succeeded. The other blocks (which enrich) let
  // the items through without their field and end "partial".
  if (module.failIfAllFail === true && step.failures > 0 && step.succeeded === 0) {
    throw new Error(`Tous les éléments ont échoué (${message(step.firstError)})`);
  }
  for (let i = next; i < input.length; i++) step.notRun(i, input[i]);
  const status = step.finish();
  const output = module.finalize ? (await module.finalize(result, ctx))?.output : result;
  return {
    status,
    output,
    ...(step.reused ? { memory: { reused: bound(step.reused) } } : {}),
    failed: step.failed,
  };
}

/** `ctx`: the config and, for an action, the input. */
function fillOrThrow(template, item, { config, userInput }, options) {
  const r = fill(template, { item, config, input: userInput }, options);
  if ("missing" in r) throw new MissingValue(r.missing);
  return r;
}

/**
 * Runs a workflow validated by the kernel (`{ blocks, links, order }`), block by block in `order`. Sends through
 * `trace` the start and end of each block and its log lines. Returns the data (the output of the `output` block)
 * and the memory of the workflow's blocks; throws the error of the first failed block (the following ones are not run).
 *
 * With `replay` (`{ reruns, outputs }`, a builder try): only the blocks of `reruns` are run and
 * traced; the output of another block is that of `replay.outputs` (taken from the original run). A try reads
 * and returns no memory: `list.new` lets everything through, `reuse` takes nothing back, the returned memory is
 * empty. The data is the output of the `output` block if it is rerun, null otherwise.
 *
 * With `progressive` (a real long run or as-it-goes run; never a try):
 *   - the memory as it would be returned now (`memorySnapshot`) is sent through `trace` as a `memory`
 *     line at most every MEMORY_GAP_MS (checked at the end of each item and each block), and before
 *     raising a block's error: what was learned is not lost if the run does not finish;
 *   - the new keys of a `list.new` stay "pending" and are only kept once resolved: the item
 *     disappeared between the input and the output of a downstream block without failing in it (discarded by a sort, `keep`, a
 *     duplicate, a `code` block), or the `output` block ran. An item that failed or was not run (time, budget, kernel
 *     refusal) in a downstream per-item block keeps its key out of the memory: it will come back next time;
 *   - if the output publishes as it goes (`chainOf` not empty), the chain's blocks run item by item
 *     (`runChain`): each finished item resolves its key there, and `memory` then `publication` lines
 *     show the finished items at most every PUBLICATIONS_GAP_MS.
 * Without `progressive`, none of this: all the new keys are kept and the memory is only returned at the end.
 */
export async function runWorkflow({
  workflow,
  config = null,
  memory = {},
  now,
  previous = null,
  folder,
  call,
  trace,
  blocks = SHIPPED_BLOCKS,
  clock = Date.now,
  deadline = clock() + GLOBAL_LIMIT_MS,
  toStderr = (text) => process.stderr.write(text + "\n"),
  replay = null,
  progressive = false,
  // Action only: the text typed at launch, and the progress of per-item blocks.
  input = undefined,
  progress = false,
}) {
  if (typeof input !== "string") input = undefined;
  const reruns = replay ? new Set(Array.isArray(replay.reruns) ? replay.reruns : []) : null;
  const taken = replay && isObject(replay.outputs) ? replay.outputs : {};
  if (replay) memory = {};
  const inProgress = progressive === true && !replay;
  const byId = new Map(workflow.blocks.map((b) => [b.id, b]));
  const predecessors = new Map(workflow.blocks.map((b) => [b.id, []]));
  for (const { from, to } of workflow.links) {
    const p = predecessors.get(to);
    if (p && !p.includes(from)) p.push(from);
  }
  const outputs = new Map();
  const newMemory = new Map();
  // Per-item block in progress: what it has already learned (progressive).
  const runningMemory = new Map();
  // Per `list.new` block (progressive): its returned memory, its pending new keys, those that failed.
  const tracked = new Map();
  const instant = now ?? new Date().toISOString();
  let data = null;
  let lastMemory = clock();

  /** The memory as it would be returned now: the workflow's blocks, with their type, bounded. */
  function memorySnapshot() {
    const m = {};
    for (const b of workflow.blocks) {
      let value;
      const track = tracked.get(b.id);
      // Pending keys removed before the cap: they do not take the place of old keys.
      if (track) value = track.memory.filter((e) => !track.pending.has(e[0])).slice(-KEYS_MAX);
      else if (newMemory.has(b.id)) value = newMemory.get(b.id);
      else if (runningMemory.has(b.id)) value = runningMemory.get(b.id)();
      else if (memory[b.id]?.type === b.type) value = memory[b.id].value;
      else continue;
      m[b.id] = { type: b.type, value: boundableCopy(value) };
    }
    return boundMemory(m);
  }

  function sendMemory() {
    lastMemory = clock();
    try {
      trace({ t: "memory", memory: memorySnapshot() });
    } catch (e) {
      // Too big for a line: the kernel keeps the previous one.
      toStderr(`mémoire non envoyée : ${message(e)}`);
    }
  }

  const checkMemory = () => {
    if (clock() - lastMemory >= MEMORY_GAP_MS) sendMemory();
  };

  /**
   * After a successful block, for each tracked `list.new` it is downstream of: the keys of its items that failed or
   * were not run become failed (for the whole run, whatever the branch, even if another branch had
   * resolved them); the keys of the items it discarded are resolved. After `output`, all those that remain not failed.
   * If a block makes the items lose the key's field (a `code` that reshapes them), it resolves nothing by
   * disappearance; if an item without a key then fails, we no longer know which: the tracking becomes "blind", nothing
   * more is resolved in this run and the keys not yet resolved will come back next time.
   */
  /**
   * An item that failed or was not run downstream of a tracked `list.new`: its key (new this time) becomes
   * failed and goes back to pending. Without a key while the field was lost along the way: we no longer know which, the tracking
   * becomes blind.
   */
  function noteFailure(track, key) {
    if (key === null) {
      if (track.keyLost && !track.blind) {
        track.blind = true;
        trace({
          t: "log",
          block: track.id,
          text: `le champ ${track.path} n'est plus dans les éléments : un élément en échec n'a pas pu être reconnu, les éléments pas encore résolus reviendront la fois suivante`,
        });
      }
    } else if (track.newKeys.has(key)) {
      track.failed.add(key);
      track.pending.add(key);
    }
  }

  const trackedKey = (track, item) => (isObject(item) ? asKey(readPath(item, track.path)) : null);

  function trackKeys(block, input, r) {
    for (const track of tracked.values()) {
      if (track.downstream.has(block.id)) {
        const keyOf = (item) => trackedKey(track, item);
        const entered = itemsOf(input);
        const remained = itemsOf(r.output);
        const withoutKey = (list) => list.filter((e) => keyOf(e) === null).length;
        const lostHere = withoutKey(remained) > withoutKey(entered);
        if (lostHere) track.keyLost = true;
        if (Array.isArray(input) && r.failed) {
          for (const i of r.failed) noteFailure(track, keyOf(input[i]));
        }
        if (!track.blind && !lostHere) {
          const remainedKeys = new Set(remained.map(keyOf));
          for (const item of entered) {
            const key = keyOf(item);
            if (key !== null && !remainedKeys.has(key) && !track.failed.has(key)) track.pending.delete(key);
          }
        }
      }
      if (block.type === "output" && !track.blind) {
        for (const key of [...track.pending]) if (!track.failed.has(key)) track.pending.delete(key);
      }
    }
  }

  const logOf = (id) => (text) => trace({ t: "log", block: id, text: truncate(String(text), TRACE_TEXT_MAX) });
  /** What a block receives, besides the input: config, memory, clock, log, `ressac`. */
  const blockOptions = (id, block, log) => ({
    blocks,
    config,
    userInput: input,
    now: instant,
    folder,
    deadline,
    clock,
    log,
    memory: memory[id]?.type === block.type ? memory[id].value : null,
    ressac: createRessac({
      call,
      config,
      previous,
      now,
      input,
      log: (...a) => {
        const text = format(...a);
        toStderr(text);
        log(text);
      },
    }),
  });

  /** The `end` trace of a successful or partial block, without the output if it does not fit on a line. */
  function traceEnd(id, status, output) {
    const end = { t: "block", id, step: "end", status, output };
    if (Buffer.byteLength(JSON.stringify(end)) > LINE_MAX) {
      trace({ t: "block", id, step: "end", status, outputTooBig: true });
    } else trace(end);
  }

  // As it goes: only for a progressive run (never a try).
  const chain = inProgress ? chainOf(workflow, blocks) : [];
  const inChain = new Set(chain);

  /**
   * The as-it-goes chain: each item of the input goes through all its blocks before being finished, two items
   * at a time, with per block the rules of a per-item block (`createStep`). A block's deadline is the start of the
   * chain plus its `budgetSeconds`, bounded by the global deadline; an item that reaches a block after it
   * passes it without its field (not run for this block) and continues. No more items enter the chain after
   * the global deadline.
   *
   * At each finished item: if it failed or was not run in a block, its key becomes failed; otherwise it
   * waits. If PUBLICATIONS_GAP_MS has passed since the last publication (or there has been none yet), the waiting keys
   * are resolved, the `memory` line goes, then `publication`: a published item is never reprocessed next
   * time, even if the container stops right after, and an item not yet shown is never kept.
   *
   * Traces: `start` of all the chain's blocks at once, at the start, and their `end` at the end. The duration kept for
   * each block of the chain is thus that of the whole chain, not the time spent in that block.
   */
  async function runChain(input) {
    const chainStart = clock();
    for (const id of chain) trace({ t: "block", id, step: "start" });
    const steps = chain.map((id) => {
      const block = byId.get(id);
      const log = logOf(id);
      const { module, params, ctx } = blockContext(block, input, blockOptions(id, block, log));
      return {
        id,
        block,
        step: createStep(module, ctx, (read) => runningMemory.set(id, read)),
        limit: limitOf(params, deadline, chainStart),
      };
    });

    /** Block `b` fails with `e`, the others in the chain end "partial"; the memory goes before the error. */
    const fail = (b, e) => {
      chain.forEach((id, k) =>
        trace(
          k === b
            ? { t: "block", id, step: "end", status: "failed", error: truncate(message(e), TRACE_TEXT_MAX) }
            : { t: "block", id, step: "end", status: "partial" },
        ),
      );
      sendMemory();
      throw e instanceof Error ? e : new Error(message(e));
    };

    if (!Array.isArray(input)) fail(0, new Error("liste attendue en entrée"));
    const n = input.length;
    // The list as after each block.
    const after = chain.map(() => new Array(n));
    const finished = new Array(n).fill(false);
    let done = 0;
    let next = 0;
    let error = null;
    let lastPublication = null;
    const upstreamTracks = [...tracked.values()].filter((s) => s.downstream.has(chain[0]));

    /** Item `i` through all the blocks; false if it is abandoned (the run fails). */
    async function walk(i) {
      let item = input[i];
      for (let b = 0; b < steps.length; b++) {
        if (error) return false;
        const { id, step, limit } = steps[b];
        if (clock() >= limit) item = step.notRun(i, item);
        else {
          item = await step.pass(i, item);
          if (step.blockError) {
            error ??= { b, e: step.blockError };
            return false;
          }
        }
        // What circulates between blocks is JSON, copied: a block does not modify what another returned.
        const copy = jsonCopy(item);
        if (copy === undefined) {
          error ??= { b, e: new Error(`le bloc ${id} doit rendre du JSON`) };
          return false;
        }
        after[b][i] = copy;
        item = structuredClone(copy);
      }
      return true;
    }

    // Items finished without failure whose key waits to be shown: it is only kept at the publication that
    // shows them (or, at the normal end of the chain, by `output`). On a run failure or a stop, an item finished
    // but not yet published was never displayed: it stays pending and comes back next time.
    const toResolve = [];
    let publicationTooBigReported = false;

    /** Item `i` finished: failed in a block, its key becomes failed right away; otherwise it waits for its publication. */
    function finishItem(i) {
      if (!steps.some(({ step }) => step.failed.has(i))) {
        toResolve.push(i);
        return;
      }
      for (const track of upstreamTracks) noteFailure(track, trackedKey(track, input[i]));
    }

    /** The keys of the items the publication will show are resolved, then the memory goes, then the publication. */
    function publish() {
      lastPublication = clock();
      const data = after[after.length - 1].filter((_, i) => finished[i]);
      // Too big for the kernel: nothing is sent or resolved, its items stay waiting (the output will show them).
      if (size(data) > DATA_MAX_SIZE) {
        if (!publicationTooBigReported) toStderr("publication non envoyée : plus de 2 Mo, les éléments seront montrés à la fin");
        publicationTooBigReported = true;
        checkMemory();
        return;
      }
      for (const i of toResolve.splice(0)) {
        for (const track of upstreamTracks) {
          const key = trackedKey(track, input[i]);
          if (!track.blind && key !== null && !track.failed.has(key)) track.pending.delete(key);
        }
      }
      sendMemory();
      try {
        trace({ t: "publication", data, done, total: n });
      } catch (e) {
        // Too big for a line: the next one, or the output, will replace it.
        toStderr(`publication non envoyée : ${message(e)}`);
      }
    }

    async function worker() {
      while (!error && next < n && clock() < deadline) {
        const i = next++;
        if (await walk(i)) {
          finished[i] = true;
          done++;
          finishItem(i);
          if (lastPublication === null || clock() - lastPublication >= PUBLICATIONS_GAP_MS) {
            publish();
            continue;
          }
        }
        checkMemory();
      }
    }
    await Promise.all(Array.from({ length: ITEMS_IN_PARALLEL }, worker));
    if (error) fail(error.b, error.e);

    // No more items enter after the global deadline: those pass all the blocks without being run in them.
    for (let i = next; i < n; i++) {
      let item = input[i];
      steps.forEach(({ step }, b) => (item = after[b][i] = step.notRun(i, item)));
    }
    steps.forEach(({ id, block, step }, b) => {
      const status = step.finish();
      runningMemory.delete(id);
      if (step.reused) newMemory.set(id, { reused: bound(step.reused) });
      outputs.set(id, after[b]);
      trackKeys(block, b === 0 ? input : after[b - 1], { output: after[b], failed: step.failed });
      traceEnd(id, status, after[b]);
    });
    checkMemory();
  }

  for (const id of workflow.order) {
    if (reruns && !reruns.has(id)) {
      // Neither run nor traced: its output, if one is needed, is that of the original run.
      if (Object.hasOwn(taken, id)) outputs.set(id, taken[id]);
      continue;
    }
    const block = byId.get(id);
    const preds = predecessors.get(id);
    const blockInput = preds.length === 0 ? null : preds.length === 1 ? outputs.get(preds[0]) : Object.fromEntries(preds.map((p) => [p, outputs.get(p)]));
    if (inChain.has(id)) {
      // The whole chain at once, at its first block (a contiguous slice of the order).
      if (id === chain[0]) await runChain(blockInput);
      continue;
    }
    trace({ t: "block", id, step: "start" });
    const log = logOf(id);
    let r;
    try {
      r = await runBlock(block, blockInput, {
        ...blockOptions(id, block, log),
        ...(inProgress ? { afterItem: checkMemory, exposeMemory: (read) => runningMemory.set(id, read) } : {}),
        ...(progress === true ? { onProgress: (done, total) => trace({ t: "block", id, step: "progress", done, total }) } : {}),
      });
    } catch (e) {
      trace({ t: "block", id, step: "end", status: "failed", error: truncate(message(e), TRACE_TEXT_MAX) });
      if (inProgress) sendMemory();
      throw e instanceof Error ? e : new Error(message(e));
    }
    runningMemory.delete(id);
    outputs.set(id, r.output);
    if (r.memory !== undefined) newMemory.set(id, r.memory);
    if (inProgress) {
      trackKeys(block, blockInput, r);
      if (block.type === "list.new" && Array.isArray(r.fullMemory) && Array.isArray(r.newKeys)) {
        tracked.set(id, {
          id,
          path: block.params?.key,
          memory: r.fullMemory,
          newKeys: new Set(r.newKeys),
          pending: new Set(r.newKeys),
          failed: new Set(),
          downstream: descendants(workflow, id),
          keyLost: false,
          blind: false,
        });
      }
    }
    if (block.type === "output") data = r.output;
    traceEnd(id, r.status, r.output);
    if (inProgress) checkMemory();
  }

  if (replay) return { data, memory: {} };
  // Only the workflow's blocks, with their type: the new value, otherwise the old one if the type has not changed.
  return { data, memory: memorySnapshot() };
}

/** The items of an input or an output: the list, or those of the lists of a multi-block input. */
function itemsOf(value) {
  if (Array.isArray(value)) return value;
  if (isObject(value)) return Object.values(value).filter(Array.isArray).flat();
  return [];
}

/** The blocks reached from `id` through the links. */
function descendants(workflow, id) {
  const seen = new Set();
  const toSee = [id];
  while (toSee.length) {
    const current = toSee.pop();
    for (const { from, to } of workflow.links) {
      if (from === current && !seen.has(to)) {
        seen.add(to);
        toSee.push(to);
      }
    }
  }
  return seen;
}

/** A block that each item can go through alone: per item optional, without `finalize` or `failIfAllFail`. */
function chainable(block, blocks) {
  const module = Object.hasOwn(blocks, block.type) ? blocks[block.type] : undefined;
  return (
    module?.perItem === "option" &&
    !module.finalize &&
    module.failIfAllFail !== true &&
    block.params?.perItem === true
  );
}

/**
 * The "as it goes" chain, a copy of `streamingChain` (src/workflows/chain.ts; a test checks that they
 * agree): the blocks each item goes through alone up to the output, in run order. Empty if the
 * output does not publish as it goes or does not have exactly one predecessor. Going up from the output's predecessor,
 * a block is taken as long as it is chainable and has only one successor (the block taken just before, or the
 * output); we go up through its only predecessor, and stop after it if it has several. Finally, blocks are removed
 * at the start as long as the rest is not a contiguous slice of the order. A try has no chain: it is up to the
 * caller to judge (runWorkflow only looks for it for a progressive run).
 */
export function chainOf(workflow, blocks) {
  const byId = new Map(workflow.blocks.map((b) => [b.id, b]));
  const outputBlock = workflow.blocks.find((b) => b.type === "output");
  if (outputBlock?.params?.live !== true) return [];
  const predecessors = new Map(workflow.blocks.map((b) => [b.id, []]));
  const successors = new Map(workflow.blocks.map((b) => [b.id, []]));
  for (const { from, to } of workflow.links) {
    if (predecessors.has(to) && !predecessors.get(to).includes(from)) predecessors.get(to).push(from);
    if (successors.has(from) && !successors.get(from).includes(to)) successors.get(from).push(to);
  }
  const upstream = predecessors.get(outputBlock.id);
  if (upstream.length !== 1) return [];

  const chain = [];
  let next = outputBlock.id;
  let current = upstream[0];
  while (current !== undefined) {
    const b = byId.get(current);
    if (!b || !chainable(b, blocks)) break;
    const after = successors.get(current);
    if (after.length !== 1 || after[0] !== next) break;
    chain.unshift(current);
    const before = predecessors.get(current);
    if (before.length !== 1) break;
    next = current;
    current = before[0];
  }

  while (chain.length > 0) {
    const first = workflow.order.indexOf(chain[0]);
    if (chain.every((id, i) => workflow.order[first + i] === id)) break;
    chain.shift();
  }
  return chain;
}

/** Copy of the lists that boundMemory shortens in place (the memory in progress is still used after a send). */
function boundableCopy(value) {
  if (Array.isArray(value)) return [...value];
  if (isObject(value) && Array.isArray(value.reused)) return { ...value, reused: [...value.reused] };
  return value;
}

/** A block's module and the `ctx` it receives (see the contract at the top of the file). */
function blockContext(block, input, o) {
  const module = Object.hasOwn(o.blocks, block.type) ? o.blocks[block.type] : undefined;
  if (!module) throw new Error(`type inconnu dans le conteneur : ${block.type}`);
  const params = block.params ?? {};
  let partial = false;
  const ctx = {
    input,
    params,
    config: o.config,
    memory: o.memory,
    now: o.now,
    ressac: o.ressac,
    log: o.log,
    folder: o.folder,
    ...(o.userInput !== undefined ? { userInput: o.userInput } : {}),
    fill: (template, options) => fillOrThrow(template, input, o, options),
    partial: (reason) => {
      partial = true;
      if (reason) o.log(reason);
    },
  };
  return { module, params, ctx, isPartial: () => partial };
}

/** A value passed through JSON (what circulates between blocks); undefined if it is not one. */
function jsonCopy(value) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    return undefined;
  }
  return json === undefined ? undefined : JSON.parse(json);
}

/** A block: returns { status, output (JSON), memory?, failed?, newKeys?, fullMemory? } or throws its error. */
async function runBlock(block, input, o) {
  const { module, params, ctx, isPartial } = blockContext(block, input, o);
  const itemByItem = module.perItem === "always" || (module.perItem === "option" && params.perItem === true);
  let r;
  if (itemByItem) {
    r = await perItem(module, ctx, {
      deadline: o.deadline,
      clock: o.clock,
      afterItem: o.afterItem,
      exposeMemory: o.exposeMemory,
      onProgress: o.onProgress,
    });
  }
  else {
    try {
      const returned = await module.run(ctx);
      r = {
        status: isPartial() ? "partial" : "succeeded",
        output: returned?.output,
        ...(returned?.memory !== undefined ? { memory: returned.memory } : {}),
        // list.new: the new keys of this time (pending from a progressive run).
        ...(Array.isArray(returned?.newKeys) ? { newKeys: returned.newKeys } : {}),
        ...(Array.isArray(returned?.fullMemory) ? { fullMemory: returned.fullMemory } : {}),
      };
    } catch (e) {
      if (!(e instanceof MissingValue)) throw e;
      o.log(e.message);
      r = { status: "succeeded", output: null };
    }
  }
  // What circulates between blocks is JSON (copied: a block does not modify another's output).
  const output = jsonCopy(r.output);
  if (output === undefined) throw new Error(`le bloc ${block.id} doit rendre du JSON`);
  return { ...r, output };
}
