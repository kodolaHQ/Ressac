// « Voir ce qu'il ne voit pas »: when to measure the marks over the page while the agent's aura is on. Pure: the
// chrome gives the measure (pieces → mask.runs → rects) and the drawing.

type Rect = { x: number; y: number; width: number; height: number };

/** The pause after each measure before the next: marks follow a scroll or a change within about this. */
export const MARKS_EVERY_MS = 250;

/**
 * `start` measures at once; `nudge` asks for a new measure, run after the one in flight and MARKS_EVERY_MS after the
 * last answer (nudges meanwhile make one); `stop` draws null and drops whatever is pending or in flight. A failed
 * measure draws no mark.
 */
export function createMarks(o: { measure(): Promise<Rect[]>; draw(rects: Rect[] | null): void; setTimer(f: () => void, ms: number): unknown; clearTimer(t: unknown): void }): { start(): void; nudge(): void; stop(): void } {
  let on = false;
  /** Each start and stop: an answer from before it is dropped. */
  let gen = 0;
  let busy = false;
  let again = false;
  let timer: unknown = null;
  const cancel = () => {
    if (timer !== null) o.clearTimer(timer);
    timer = null;
    busy = again = false;
  };
  const run = () => {
    const g = gen;
    busy = true;
    again = false;
    void o.measure().then(
      (r) => r,
      () => [],
    ).then((rects) => {
      if (g !== gen) return;
      busy = false;
      o.draw(rects);
      timer = o.setTimer(() => {
        timer = null;
        if (g === gen && again) run();
      }, MARKS_EVERY_MS);
    });
  };
  return {
    start() {
      on = true;
      gen++;
      cancel();
      run();
    },
    nudge() {
      if (!on) return;
      if (busy || timer !== null) again = true;
      else run();
    },
    stop() {
      if (!on) return;
      on = false;
      gen++;
      cancel();
      o.draw(null);
    },
  };
}

type Run = { start: number; end: number };

/** One answer's runs, sorted, overlaps merged. */
function merged(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of [...runs].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

/**
 * What every conversation masks: the spans common to each window's answer that has a session (null: no session, left
 * out). A tab's tool may come from any window's conversation, so a hatch only where all of them mask. No session: none.
 */
export function commonRuns(answers: (Run[] | null)[]): Run[] {
  const held = answers.filter((a): a is Run[] => a !== null).map(merged);
  if (!held.length) return [];
  return held.reduce((acc, b) => {
    const out: Run[] = [];
    for (const x of acc)
      for (const y of b) {
        const start = Math.max(x.start, y.start), end = Math.min(x.end, y.end);
        if (end > start) out.push({ start, end });
      }
    return out;
  });
}
