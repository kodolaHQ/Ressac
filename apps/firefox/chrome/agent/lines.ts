/** Feeds raw pipe chunks, calls `cb` with each complete line; a UTF-8 character cut across chunks is kept for the next. */
export function lineSplitter(cb: (line: string) => void): (chunk: ArrayBuffer) => void {
  const decoder = new TextDecoder();
  let buffer = "";
  return (chunk) => {
    buffer += decoder.decode(chunk, { stream: true });
    for (let i: number; (i = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(i + 1)) cb(buffer.slice(0, i));
  };
}
