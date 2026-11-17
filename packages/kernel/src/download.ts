import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

/** The downloaded file's SHA-256 is not the expected one (the `.part` is already deleted). */
export class HashMismatchError extends Error {
  constructor() {
    super("hash mismatch");
  }
}

/**
 * Downloads `url` into `<file>.part`, resuming it with a range request, aborting past `bytes`, then checks the SHA-256 and
 * renames it to `file`. A bad hash or an oversized body deletes the `.part`; a cancel (`signal`) keeps it and throws
 * `cancelled()`. Other failures throw their raw message (HTTP status, network) or `HashMismatchError`.
 */
export async function downloadVerified(o: {
  url: string;
  file: string;
  sha256: string;
  bytes: number;
  signal: AbortSignal;
  onPercent: (p: number | null) => void;
  cancelled: () => Error;
}): Promise<void> {
  const part = `${o.file}.part`;
  try {
    await mkdir(dirname(o.file), { recursive: true });
    let from = (await stat(part).catch(() => undefined))?.size ?? 0;
    const r = await fetch(o.url, { headers: from ? { range: `bytes=${from}-` } : {}, signal: o.signal });
    // 416: the .part already holds the whole file (the app quit before checking it).
    if (r.status !== 416) {
      if ((r.status !== 200 && r.status !== 206) || !r.body) throw new Error(`HTTP ${r.status}`);
      if (r.status === 200) from = 0; // the range was ignored: start over
      const total = from + Number(r.headers.get("content-length") ?? NaN);
      let received = from;
      let shown: number | null | undefined;
      const file = await open(part, from ? "a" : "w");
      try {
        for await (const chunk of r.body) {
          await file.write(chunk);
          received += chunk.length;
          if (received > o.bytes) throw new Error("too many bytes");
          const percent = Number.isFinite(total) ? Math.floor((received * 100) / total) : null;
          if (percent !== shown) o.onPercent((shown = percent));
        }
      } finally {
        await file.close();
      }
    }
  } catch (e) {
    if (o.signal.aborted) throw o.cancelled();
    if ((e as Error).message === "too many bytes") await rm(part, { force: true });
    throw e;
  }
  // Checked per chunk: hashing a big file takes seconds, and the caller's slot stays taken until the cancel lands.
  const digest = await sha256File(part, () => {
    if (o.signal.aborted) throw o.cancelled();
  });
  if (o.signal.aborted) throw o.cancelled();
  if (digest !== o.sha256) {
    await rm(part, { force: true });
    throw new HashMismatchError();
  }
  await rename(part, o.file);
}

/** The file's SHA-256 (hex); `each` runs before every chunk (a cancel check). */
export async function sha256File(path: string, each?: () => void): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    each?.();
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}
