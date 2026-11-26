/**
 * The pasted ranges of a draft after an edit from `before` to `after`: the changed span is found by the common prefix
 * and suffix. A range the edit touches stays pasted over the merged span (the safe side: pasted text is never counted as
 * typed); a range the edit removes entirely goes.
 */
export function shiftRanges(ranges: [number, number][], before: string, after: string): [number, number][] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  const oldEnd = before.length - end;
  const newEnd = after.length - end;
  const delta = newEnd - oldEnd;
  const out: [number, number][] = [];
  for (const [a, b] of ranges) {
    if (b <= start) out.push([a, b]);
    else if (a >= oldEnd) out.push([a + delta, b + delta]);
    else if (a >= start && b <= oldEnd && newEnd === start) continue;
    else out.push([Math.min(a, start), Math.max(b + delta, newEnd)]);
  }
  return out.filter(([a, b]) => a < b);
}
