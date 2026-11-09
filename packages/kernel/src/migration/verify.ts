import { kind, readNoFollow, type Ctx } from "./json.js";

/** Each migrated JSON file read again and checked with the new schemas; the failures go to the report. */
export async function verify(ctx: Ctx): Promise<{ path: string; error: string }[]> {
  const failures: { path: string; error: string }[] = [];
  for (const { path, check } of ctx.written) {
    if ((await kind(path)) !== "file") continue;
    let error: string | null;
    try {
      error = await check(JSON.parse((await readNoFollow(path)).toString()));
    } catch (e) {
      error = (e as Error).message;
    }
    if (error) failures.push({ path, error });
  }
  return failures;
}
