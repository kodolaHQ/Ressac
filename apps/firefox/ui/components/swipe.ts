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
  return (e: { deltaX: number; deltaY: number }): void => {
    const t = now();
    if (t - last > QUIET_MS) [sum, done] = [0, false];
    last = t;
    if (done || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    sum += e.deltaX;
    if (Math.abs(sum) < THRESHOLD) return;
    done = true;
    onStep(sum > 0 ? 1 : -1);
  };
}
