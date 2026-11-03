/** What each bench test writes to WEBAIOS_BENCH_OUT. */
export interface BenchFile { app: "electron" | "firefox"; headed: boolean; measures: Record<string, number[]> }
export interface Row { measure: string; electron: number | null; firefox: number | null; ratio: number | null; verdict: "ok" | "too slow" | "info" }

export const TOLERANCE = 1.1;
/** Measures that only inform (no verdict): one app only, or the raw read that includes the 2 s calm. */
export const INFO_ONLY = ["invisibleRead", "containerForPerDispatch"];

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function compare(files: BenchFile[]): Row[] {
  const pooled: Record<BenchFile["app"], Record<string, number[]>> = { electron: {}, firefox: {} };
  for (const f of files) {
    for (const [name, xs] of Object.entries(f.measures)) (pooled[f.app][name] ??= []).push(...xs);
    const raw = f.measures.invisibleRead;
    if (raw) (pooled[f.app].invisibleReadNet ??= []).push(...raw.map((x) => x - 2000));
  }
  const names = [...new Set([...Object.keys(pooled.electron), ...Object.keys(pooled.firefox)])];
  return names.map((measure) => {
    const e = pooled.electron[measure], f = pooled.firefox[measure];
    const electron = e?.length ? median(e) : null, firefox = f?.length ? median(f) : null;
    const ratio = electron !== null && firefox !== null && electron !== 0 ? firefox / electron : null;
    const both = electron !== null && firefox !== null && !INFO_ONLY.includes(measure);
    return { measure, electron, firefox, ratio, verdict: both ? (firefox > electron * TOLERANCE ? "too slow" : "ok") : "info" };
  });
}
