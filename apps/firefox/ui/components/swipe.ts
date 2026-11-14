/** Horizontal distance (px) a two-finger swipe must cover before it switches. */
const THRESHOLD = 80;
/** A pause this long (ms) without wheel events ends the gesture, macOS momentum included. */
const QUIET_MS = 250;

/**
 * Turns the sidebar's wheel events into one step per two-finger swipe: +1 when the fingers move left (the next space),
 * -1 to the right. Vertical scrolling and small moves never switch; the rest of a gesture after its step is ignored.
 */
export function createSwipe(onStep: (delta: 1 | -1) => void, now = () => Date.now()) {
  let sum = 0;
  let last = -Infinity;
  let done = false;
  // A swipe made while the last one's momentum runs never leaves a quiet pause: new fingers show as deltas that fell
  // almost to nothing, then rise clearly again (momentum only decays, a strong swipe's jitter never gets that low).
  let low = Infinity;
  return (e: { deltaX: number; deltaY: number }): void => {
    const t = now();
    const x = Math.abs(e.deltaX);
    if (t - last > QUIET_MS) [sum, done] = [0, false];
    last = t;
    if (x <= Math.abs(e.deltaY)) return;
    if (done) {
      low = Math.min(low, x);
      if (low > 3 || x < 12) return;
      [sum, done] = [0, false];
    }
    sum += e.deltaX;
    if (Math.abs(sum) < THRESHOLD) return;
    [done, low] = [true, Infinity];
    onStep(sum > 0 ? 1 : -1);
  };
}
